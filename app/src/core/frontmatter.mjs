// frontmatter.mjs — 記憶檔 frontmatter 的解析與「外科手術式」修改。
// 只支援 Claude Code 實際會寫出的 YAML 子集；看不懂的內容記錄在 errors，parseMemoryFile 絕不丟出例外。
// 修改時只動到目標鍵所在的行，其餘位元組（含換行字元、註解、順序）保持原樣。
// 結構性錯誤（行範圍不可信）時 setFields 拒絕修改，丟出 E_INVALID，由呼叫端改報 H12。

import { E, EngramError } from './errors.mjs';

const BOM = '\uFEFF';

/** Claude Code harness 每次寫入都會改動的欄位；比對內容時應排除。 */
export const HARNESS_KEYS = Object.freeze([
  'metadata.node_type',
  'metadata.originSessionId',
  'metadata.modified',
]);

const hasOwn = (obj, k) => obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, k);
const own = (obj, k) => (hasOwn(obj, k) ? obj[k] : undefined);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

function safeAssign(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

// ───────────────────────── 文件切割 ─────────────────────────

/**
 * 依原始換行字元切行，保留每行的換行符。
 * @param {string} str
 * @returns {{ text: string, nl: string }[]}
 */
function splitLines(str) {
  const out = [];
  let i = 0;
  while (i < str.length) {
    let j = i;
    while (j < str.length && str[j] !== '\n' && str[j] !== '\r') j++;
    let nl = '';
    if (j < str.length) nl = str[j] === '\r' && str[j + 1] === '\n' ? '\r\n' : str[j];
    out.push({ text: str.slice(i, j), nl });
    i = j + nl.length;
  }
  return out;
}

const joinLines = (lines) => lines.map((l) => l.text + l.nl).join('');

/** 多數決的換行字元；平手或沒有換行時用 LF。 */
function dominantEol(lines) {
  let crlf = 0, lf = 0;
  for (const l of lines) {
    if (l.nl === '\r\n') crlf++;
    else if (l.nl === '\n') lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

const isFence = (text, closing) => {
  const t = text.trimEnd();
  return t === '---' || (closing && t === '...');
};

/**
 * 把檔案切成 BOM、開頭分隔行、frontmatter 各行、結尾分隔行、內文。
 * @param {string} text
 */
function splitDocument(text) {
  let bom = '';
  let src = text ?? '';
  if (src.startsWith(BOM)) { bom = BOM; src = src.slice(1); }
  const lines = splitLines(src);
  const eol = dominantEol(lines);
  const errors = [];
  if (lines.length && isFence(lines[0].text, false)) {
    let close = -1;
    for (let k = 1; k < lines.length; k++) {
      if (isFence(lines[k].text, true)) { close = k; break; }
    }
    if (close > 0) {
      const fmLines = lines.slice(1, close);
      return {
        bom, eol, errors, hasFrontmatter: true,
        fmEol: dominantEol([lines[0], ...fmLines, lines[close]]),
        open: lines[0],
        fmLines,
        close: lines[close],
        body: joinLines(lines.slice(close + 1)),
      };
    }
    errors.push('frontmatter 沒有結尾的 --- 分隔行，整份視為內文');
  }
  return { bom, eol, fmEol: eol, errors, hasFrontmatter: false, open: null, fmLines: [], close: null, body: src };
}

/** 組回完整文字。 */
function assemble(doc) {
  if (!doc.hasFrontmatter) return doc.bom + doc.body;
  return doc.bom + doc.open.text + doc.open.nl + joinLines(doc.fmLines) + doc.close.text + doc.close.nl + doc.body;
}

// ───────────────────────── 路徑 ─────────────────────────

/** 鍵裡的 . 與 \ 加上跳脫，讓含點的鍵可以放進點分隔路徑。 */
const escapeKey = (k) => String(k).replace(/\\/g, '\\\\').replace(/\./g, '\\.');

/**
 * 點分隔路徑 → 各段；支援 \. 與 \\ 跳脫。
 * @returns {{ parts: string[], escaped: boolean }}
 */
function splitPath(path) {
  if (Array.isArray(path)) return { parts: path.map(String), escaped: true };
  const s = String(path);
  const parts = [];
  let cur = '';
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && (s[i + 1] === '.' || s[i + 1] === '\\')) { cur += s[i + 1]; i++; escaped = true; continue; }
    if (c === '.') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return { parts, escaped };
}

/**
 * 在物件 obj 上找 parts[d…] 開頭對應的鍵。smart 時優先比對最長的「含點鍵」（例如 v1.2）。
 * @returns {{ key: string, next: number } | null}
 */
function matchKey(hasKey, parts, d, smart) {
  if (smart) {
    for (let k = parts.length - d; k > 1; k--) {
      const key = parts.slice(d, d + k).join('.');
      if (hasKey(key)) return { key, next: d + k };
    }
  }
  return hasKey(parts[d]) ? { key: parts[d], next: d + 1 } : null;
}

// ───────────────────────── 純量 ─────────────────────────

/** 依 YAML 1.2 core schema 解讀未加引號的純量（引擎讀取用）。 */
function resolvePlain(s) {
  if (s === '' || s === '~' || /^null$/i.test(s)) return null;
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  if (/^[-+]?\d+$/.test(s)) {
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : s;
  }
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  return s;
}

const ESCAPES = {
  n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', '/': '/', '0': '\0', b: '\b', f: '\f', ' ': ' ',
  e: '\x1b', a: '\x07', v: '\v', N: '\u0085', _: '\u00A0', L: '\u2028', P: '\u2029', '\t': '\t',
};

/**
 * 從 s[pos] 的引號開始讀一個引號字串。
 * @returns {{ value: string, end: number } | null} end 為結尾引號之後的索引；未閉合回傳 null
 */
function readQuoted(s, pos) {
  const q = s[pos];
  let out = '';
  let i = pos + 1;
  if (q === "'") {
    while (i < s.length) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") { out += "'"; i += 2; continue; }
        return { value: out, end: i + 1 };
      }
      out += s[i++];
    }
    return null;
  }
  while (i < s.length) {
    const c = s[i];
    if (c === '"') return { value: out, end: i + 1 };
    if (c === '\\') {
      const n = s[i + 1];
      const hex = (len) => (new RegExp(`^[0-9a-fA-F]{${len}}$`).test(s.slice(i + 2, i + 2 + len)) ? parseInt(s.slice(i + 2, i + 2 + len), 16) : null);
      if (n === 'x' && hex(2) !== null) { out += String.fromCharCode(hex(2)); i += 4; continue; }
      if (n === 'u' && hex(4) !== null) { out += String.fromCharCode(hex(4)); i += 6; continue; }
      if (n === 'U' && hex(8) !== null && hex(8) <= 0x10ffff) { out += String.fromCodePoint(hex(8)); i += 10; continue; }
      if (n !== undefined && hasOwn(ESCAPES, n)) { out += ESCAPES[n]; i += 2; continue; }
      out += n ?? ''; i += 2; continue;
    }
    out += c; i++;
  }
  return null;
}

/** 字串結尾是否為「奇數個反斜線」（雙引號字串的跳脫換行）。 */
function endsWithEscapedBreak(s) {
  const m = /\\+$/.exec(s);
  return !!m && m[0].length % 2 === 1;
}

/** 純量的行尾註解：# 前面必須是空白或行首；純量裡的引號不影響判斷。 */
function stripPlainComment(s) {
  const m = /(^|[ \t])#/.exec(s);
  return m ? s.slice(0, m.index) : s;
}

/** 引號或流式結構之外的行尾註解。 */
function stripQuotedComment(s) {
  let inS = false, inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inD) { if (c === '\\') i++; else if (c === '"') inD = false; continue; }
    if (inS) { if (c === "'") inS = false; continue; }
    if (c === '"') inD = true;
    else if (c === "'") inS = true;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

/** 依值的開頭決定用哪一種註解規則。 */
function stripComment(s) {
  return /^\s*["'\[{]/.test(s) ? stripQuotedComment(s) : stripPlainComment(s);
}

/**
 * 解析行內流式結構（[ ] 與 { }），支援巢狀與引號。
 * @returns {{ value: any, end: number }}
 */
function parseFlow(s, pos, errors) {
  const open = s[pos];
  const closeCh = open === '[' ? ']' : '}';
  const isSeq = open === '[';
  const result = isSeq ? [] : {};
  let i = pos + 1;
  const skipWs = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const readItem = () => {
    skipWs();
    if (s[i] === '[' || s[i] === '{') { const r = parseFlow(s, i, errors); i = r.end; return r.value; }
    if (s[i] === '"' || s[i] === "'") {
      const r = readQuoted(s, i);
      if (!r) { errors.push(`流式結構的引號沒有閉合：${s}`); i = s.length; return ''; }
      i = r.end; return r.value;
    }
    let j = i;
    while (j < s.length && !',]}'.includes(s[j]) && !(s[j] === ':' && !isSeq && /\s/.test(s[j + 1] ?? ' '))) j++;
    const raw = s.slice(i, j).trim();
    i = j;
    return resolvePlain(raw);
  };
  skipWs();
  if (s[i] === closeCh) return { value: result, end: i + 1 };
  while (i < s.length) {
    if (isSeq) {
      result.push(readItem());
    } else {
      const key = readItem();
      skipWs();
      let val = null;
      if (s[i] === ':') { i++; val = readItem(); }
      safeAssign(result, String(key), val);
    }
    skipWs();
    if (s[i] === ',') { i++; skipWs(); if (s[i] === closeCh) return { value: result, end: i + 1 }; continue; }
    if (s[i] === closeCh) return { value: result, end: i + 1 };
    errors.push(`無法解析的流式結構：${s}`);
    return { value: result, end: s.length };
  }
  errors.push(`流式結構沒有閉合：${s}`);
  return { value: result, end: s.length };
}

// ───────────────────────── 區塊結構解析 ─────────────────────────

const isSeqItem = (rest) => rest === '-' || rest.startsWith('- ');
const BLOCK_HEADER = /^[|>][-+]?\d?[-+]?$/;

/**
 * 把 "key: value" 拆開；不是鍵值行時回傳 null。
 * @returns {{ key: string, keyRaw: string, rest: string } | null}
 */
function splitKeyValue(rest) {
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const q = readQuoted(rest, 0);
    if (!q) return null;
    const m = /^\s*:(?=\s|$)/.exec(rest.slice(q.end));
    if (!m) return null;
    return { key: q.value, keyRaw: rest.slice(0, q.end), rest: rest.slice(q.end + m[0].length) };
  }
  if (/^[\[{#&*!|>%@`\t]/.test(rest)) return null;
  for (let k = 0; k < rest.length; k++) {
    if (rest[k] === '#' && k > 0 && /\s/.test(rest[k - 1])) return null;
    if (rest[k] === ':' && (k + 1 === rest.length || /\s/.test(rest[k + 1]))) {
      const keyRaw = rest.slice(0, k).trimEnd();
      if (!keyRaw) return null;
      return { key: keyRaw, keyRaw, rest: rest.slice(k + 1) };
    }
  }
  return null;
}

/** 解析時的診斷：fail 為結構性錯誤（行範圍不可信），soft 為單行內的錯誤，warn 只是提醒。 */
function makeDiag() {
  const diag = { errors: [], warnings: [], fatal: false };
  diag.fail = (msg) => { diag.errors.push(msg); diag.fatal = true; };
  diag.soft = (msg) => { diag.errors.push(msg); };
  diag.warn = (msg) => { diag.warnings.push(msg); };
  return diag;
}

/**
 * 解析 frontmatter 各行，產生帶行號範圍的節點樹。
 * 節點：map { entries[{key,keyRaw,line,end,indent,value}] }、seq { items[{line,end,value}] }、scalar { value }。
 * end 為最後一個內容行之後的索引（不含尾端空行與註解）。
 */
function parseTree(fmLines, diag) {
  const n = fmLines.length;
  const info = fmLines.map((l, i) => {
    const m = /^( *)(.*)$/s.exec(l.text);
    const indent = m[1].length;
    const rest = m[2].replace(/\s+$/, '');
    const blank = rest === '';
    const tab = !blank && rest.startsWith('\t');
    if (tab) diag.fail(`第 ${i + 1} 行使用 tab 縮排`);
    return { indent, rest, blank, skip: blank || tab || rest.startsWith('#') };
  });

  const nextContent = (from) => {
    let i = from;
    while (i < n && info[i].skip) i++;
    return i;
  };

  const scalarNode = (value, line, end) => ({ kind: 'scalar', value, line, end });

  // 引號字串可以延續到縮排更深的後續行：一般換行折成空白、空行變成換行、雙引號行尾的 \ 直接相連。
  function parseQuoted(t, line, ownerIndent) {
    const dq = t[0] === '"';
    let folded = t;
    let q = readQuoted(folded, 0);
    let end = line + 1;
    let pending = 0;
    for (let j = line + 1; !q && j < n; j++) {
      const li = info[j];
      if (li.blank) { pending++; continue; }
      if (li.indent <= ownerIndent) break;
      const content = fmLines[j].text.trim();
      folded = folded.replace(/[ \t]+$/, '');
      if (pending) folded += '\n'.repeat(pending);
      else if (dq && endsWithEscapedBreak(folded)) folded = folded.slice(0, -1);
      else folded += ' ';
      folded += content;
      pending = 0;
      end = j + 1;
      q = readQuoted(folded, 0);
    }
    if (!q) {
      // 沒有閉合：只把這一行當成值，絕不吞掉後面的行
      diag.soft(`第 ${line + 1} 行的引號字串沒有閉合`);
      return scalarNode(t.slice(1), line, line + 1);
    }
    const tail = stripQuotedComment(folded.slice(q.end)).trim();
    if (tail) diag.soft(`第 ${line + 1} 行引號字串之後有多餘內容：${tail}`);
    return scalarNode(q.value, line, end);
  }

  // 純量可以延續到縮排更深的後續行（折疊成空白，空行變成換行）。
  function parseInline(raw, line, ownerIndent) {
    const t = raw.trimStart();
    if (t.startsWith('"') || t.startsWith("'")) return parseQuoted(t, line, ownerIndent);
    if (t.startsWith('[') || t.startsWith('{')) {
      const local = [];
      const r = parseFlow(t, 0, local);
      for (const e of local) diag.soft(`第 ${line + 1} 行：${e}`);
      const tail = stripQuotedComment(t.slice(r.end)).trim();
      if (tail) diag.soft(`第 ${line + 1} 行流式結構之後有多餘內容：${tail}`);
      return scalarNode(r.value, line, line + 1);
    }
    const first = stripPlainComment(t).trim();
    let end = line + 1;
    if (first !== t.trim()) return scalarNode(resolvePlain(first), line, end); // 有註解：純量到此為止
    let folded = first;
    let continued = false;
    let pending = 0;
    for (let j = line + 1; j < n; j++) {
      const li = info[j];
      if (li.blank) { pending++; continue; }
      if (li.skip) break;
      if (li.indent <= ownerIndent) break;
      if (isSeqItem(li.rest) || splitKeyValue(li.rest)) {
        diag.fail(`第 ${j + 1} 行：純量之後出現縮排更深的結構，格式不明確`);
        break;
      }
      const c = stripPlainComment(li.rest).trim();
      folded += (pending ? '\n'.repeat(pending) : ' ') + c;
      pending = 0;
      end = j + 1;
      continued = true;
      if (c !== li.rest.trim()) break;
    }
    return scalarNode(continued ? folded : resolvePlain(first), line, end);
  }

  function foldLines(lines) {
    let out = '';
    let started = false;
    let pending = 0;
    let prevMore = false;
    for (const r of lines) {
      if (r === '') { pending++; continue; }
      const more = /^[ \t]/.test(r);
      if (!started) out += '\n'.repeat(pending) + r;
      else if (more || prevMore) out += '\n' + '\n'.repeat(pending) + r;
      else out += pending ? '\n'.repeat(pending) + r : ' ' + r;
      started = true;
      pending = 0;
      prevMore = more;
    }
    return out;
  }

  function parseBlockScalar(line, ownerIndent, header) {
    const style = header[0];
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const explicit = /\d/.exec(header);
    let contentIndent = explicit ? ownerIndent + Number(explicit[0]) : -1;
    const raw = [];
    let lastContent = line;
    for (let j = line + 1; j < n; j++) {
      const text = fmLines[j].text;
      const blank = text.trim() === '';
      const ind = /^ */.exec(text)[0].length;
      if (!blank && ind <= ownerIndent) break;
      if (!blank && contentIndent < 0) contentIndent = ind;
      raw.push(blank ? '' : text.slice(Math.max(contentIndent, 0)));
      if (!blank) lastContent = j;
    }
    let trailing = 0;
    while (raw.length && raw[raw.length - 1] === '') { raw.pop(); trailing++; }
    let value = style === '|' ? raw.join('\n') : foldLines(raw);
    if (raw.length) {
      if (chomp === 'clip') value += '\n';
      else if (chomp === 'keep') value += '\n' + '\n'.repeat(trailing);
    } else if (chomp === 'keep') {
      value = '\n'.repeat(trailing);
    }
    return scalarNode(value, line, lastContent + 1);
  }

  function parseBlock(start, parentIndent) {
    return isSeqItem(info[start].rest) ? parseSeq(start, info[start].indent) : parseMap(start, info[start].indent, parentIndent);
  }

  function parseValueAfterKey(line, ownerIndent, rawRest) {
    const val = stripComment(rawRest).trim();
    if (val === '') {
      const j = nextContent(line + 1);
      if (j < n && info[j].indent > ownerIndent) {
        const r = info[j].rest;
        if (isSeqItem(r) || splitKeyValue(r)) return parseBlock(j, ownerIndent);
        return parseInline(r, j, ownerIndent); // 值從下一行開始的純量
      }
      if (j < n && info[j].indent === ownerIndent && isSeqItem(info[j].rest)) return parseSeq(j, ownerIndent);
      return scalarNode(null, line, line + 1);
    }
    if (BLOCK_HEADER.test(val)) return parseBlockScalar(line, ownerIndent, val);
    return parseInline(rawRest, line, ownerIndent);
  }

  function parseMap(start, ind) {
    const node = { kind: 'map', indent: ind, entries: [], byKey: new Map(), line: start, end: start };
    let i = start;
    while (true) {
      i = nextContent(i);
      if (i >= n) break;
      const li = info[i];
      if (li.indent < ind) break;
      if (li.indent > ind) { diag.fail(`第 ${i + 1} 行縮排不符`); i++; continue; }
      if (isSeqItem(li.rest)) break;
      const kv = splitKeyValue(li.rest);
      if (!kv) { diag.fail(`第 ${i + 1} 行無法解析：${li.rest}`); i++; continue; }
      const value = parseValueAfterKey(i, ind, kv.rest);
      const entry = { key: kv.key, keyRaw: kv.keyRaw, line: i, indent: ind, end: Math.max(value.end, i + 1), value };
      if (node.byKey.has(entry.key)) diag.warn(`第 ${i + 1} 行的鍵「${entry.key}」重複，以後者為準`);
      node.byKey.set(entry.key, entry);
      node.entries.push(entry);
      node.end = entry.end;
      i = entry.end;
    }
    return node;
  }

  function parseSeq(start, ind) {
    const node = { kind: 'seq', indent: ind, items: [], line: start, end: start };
    let i = start;
    while (true) {
      i = nextContent(i);
      if (i >= n) break;
      const li = info[i];
      if (li.indent !== ind || !isSeqItem(li.rest)) {
        if (li.indent > ind) { diag.fail(`第 ${i + 1} 行縮排不符`); i++; continue; }
        break;
      }
      const after = li.rest === '-' ? '' : li.rest.slice(2);
      const afterTrim = stripComment(after).trim();
      const item = { line: i, end: i + 1, value: null };
      if (afterTrim === '') {
        const j = nextContent(i + 1);
        item.value = j < n && info[j].indent > ind ? parseBlock(j, ind) : scalarNode(null, i, i + 1);
      } else if (isSeqItem(afterTrim)) {
        diag.soft(`第 ${i + 1} 行的巢狀行內列表不支援，視為字串`);
        item.value = scalarNode(afterTrim, i, i + 1);
      } else if (!/^["'\[{]/.test(afterTrim) && splitKeyValue(after.trimStart())) {
        // 列表中的物件：把這一行暫時視為縮排在「- 」之後的鍵值行
        const innerIndent = ind + 1 + (after.length - after.trimStart().length) + 1;
        const saved = info[i];
        info[i] = { indent: innerIndent, rest: after.trimStart(), blank: false, skip: false };
        item.value = parseMap(i, innerIndent);
        info[i] = saved;
      } else if (BLOCK_HEADER.test(afterTrim)) {
        item.value = parseBlockScalar(i, ind, afterTrim);
      } else {
        item.value = parseInline(after, i, ind);
      }
      item.end = Math.max(item.value.end, i + 1);
      node.items.push(item);
      node.end = item.end;
      i = item.end;
    }
    return node;
  }

  const first = nextContent(0);
  if (first >= n) return { kind: 'map', indent: 0, entries: [], line: n, end: n };
  if (isSeqItem(info[first].rest)) {
    diag.fail('frontmatter 頂層必須是鍵值對');
    return { kind: 'map', indent: 0, entries: [], line: n, end: n };
  }
  const root = parseMap(first, info[first].indent);
  for (let i = nextContent(root.end); i < n; i = nextContent(i + 1)) {
    diag.fail(`第 ${i + 1} 行無法解析：${info[i].rest}`);
  }
  return root;
}

/** 節點樹 → 一般 JS 值。 */
function toJS(node) {
  if (!node) return null;
  if (node.kind === 'scalar') return node.value;
  if (node.kind === 'seq') return node.items.map((it) => toJS(it.value));
  const obj = {};
  for (const e of node.entries) safeAssign(obj, e.key, toJS(e.value));
  return obj;
}

/** 偵測縮排單位（巢狀區塊比父層多幾格）。 */
function detectIndentUnit(node) {
  if (!node || node.kind === 'scalar') return 0;
  const children = node.kind === 'map' ? node.entries : node.items;
  for (const c of children) {
    const v = c.value;
    if (v && (v.kind === 'map' || v.kind === 'seq') && v.indent > (c.indent ?? node.indent)) {
      return v.indent - (c.indent ?? node.indent);
    }
    const deeper = detectIndentUnit(v);
    if (deeper) return deeper;
  }
  return 0;
}

// ───────────────────────── 公開 API：解析 ─────────────────────────

/**
 * 解析記憶檔。errors 收錄所有格式錯誤；warnings 只是提醒（例如重複的鍵）。
 * @param {string} text
 * @returns {{ hasFrontmatter: boolean, data: object, body: string, fmText: string, eol: '\n'|'\r\n', errors: string[], warnings: string[] }}
 */
export function parseMemoryFile(text) {
  try {
    const doc = splitDocument(String(text ?? ''));
    const diag = makeDiag();
    const root = doc.hasFrontmatter ? parseTree(doc.fmLines, diag) : null;
    const data = root ? toJS(root) : {};
    return {
      hasFrontmatter: doc.hasFrontmatter,
      data: isPlainObject(data) ? data : {},
      body: doc.body,
      fmText: joinLines(doc.fmLines),
      eol: doc.eol,
      errors: [...doc.errors, ...diag.errors],
      warnings: diag.warnings,
    };
  } catch (err) {
    return { hasFrontmatter: false, data: {}, body: String(text ?? ''), fmText: '', eol: '\n', errors: [`解析失敗：${err.message}`], warnings: [] };
  }
}

/**
 * 以點分隔路徑讀取欄位，例如 'metadata.engram.pinned'。含點的鍵（v1.2）會自動對上；也可用 \. 跳脫或傳入陣列。
 * @param {object} data
 * @param {string | string[]} dottedPath
 */
export function getField(data, dottedPath) {
  const { parts, escaped } = splitPath(dottedPath);
  let cur = data;
  let d = 0;
  while (d < parts.length) {
    if (!isPlainObject(cur)) return undefined;
    const m = matchKey((k) => hasOwn(cur, k), parts, d, !escaped);
    if (!m) return undefined;
    cur = cur[m.key];
    d = m.next;
  }
  return cur;
}

// ───────────────────────── 輸出 ─────────────────────────

// 其他 YAML 讀取器（YAML 1.1 或 1.2）可能讀成非字串的寫法：寫出字串時一律加引號
const NON_STRING_FORMS = [
  /^[-+]?(\.\d|\d)[\d_]*(\.[\d_]*)?([eE][-+]?\d+)?$/,   // 整數、小數、指數、底線分隔
  /^[-+]?\.\d+([eE][-+]?\d+)?$/,
  /^[-+]?0[xX][0-9a-fA-F_]+$/,                           // 十六進位
  /^[-+]?0[oO][0-7_]+$/,                                 // 八進位（1.2）
  /^[-+]?0[bB][01_]+$/,                                  // 二進位（1.1）
  /^[-+]?\.(inf|Inf|INF)$/,
  /^\.(nan|NaN|NAN)$/,
  /^[-+]?\d[\d_]*(:[0-5]?\d)+(\.[\d_]*)?$/,              // 六十進位（1.1）
  /^(y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/,
  /^(null|Null|NULL|~)$/,
  /^(=|<<)$/,
];

function needsQuote(s) {
  if (s === '') return true;
  if (s !== s.trim()) return true;
  if (/[\x00-\x1f\x7f\u0085\u2028\u2029\\]/.test(s)) return true;
  if (/^[-?:,\[\]{}#&*!|>'"%@`]/.test(s)) return true;
  if (/:(\s|$)/.test(s) || /\s#/.test(s)) return true;
  if (resolvePlain(s) !== s) return true;
  if (NON_STRING_FORMS.some((re) => re.test(s))) return true;
  return false;
}

function quoteDouble(s) {
  return '"' + s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0085\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
    + '"';
}

function renderScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : quoteDouble(String(v));
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return '[' + v.map(renderFlowItem).join(', ') + ']';
  if (isPlainObject(v)) return '{' + Object.keys(v).map((k) => `${formatKey(k)}: ${renderFlowItem(v[k])}`).join(', ') + '}';
  const s = String(v);
  return needsQuote(s) ? quoteDouble(s) : s;
}

function renderFlowItem(v) {
  if (typeof v === 'string' && /[,\[\]{}]/.test(v)) return quoteDouble(v);
  return renderScalar(v);
}

function formatKey(k) {
  return /^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/.test(k) ? k : quoteDouble(k);
}

/** 產生「鍵: 值」的各行（不含換行符）。 */
function renderEntry(keyRaw, value, indent, unit) {
  const pad = ' '.repeat(indent);
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (!keys.length) return [`${pad}${keyRaw}: {}`];
    const lines = [`${pad}${keyRaw}:`];
    for (const k of keys) lines.push(...renderEntry(formatKey(k), value[k], indent + unit, unit));
    return lines;
  }
  if (Array.isArray(value)) {
    if (!value.length) return [`${pad}${keyRaw}: []`];
    const lines = [`${pad}${keyRaw}:`];
    for (const item of value) lines.push(...renderSeqItem(item, indent + unit, unit));
    return lines;
  }
  return [`${pad}${keyRaw}: ${renderScalar(value)}`];
}

function renderSeqItem(item, indent, unit) {
  const pad = ' '.repeat(indent);
  if (isPlainObject(item) && Object.keys(item).length) {
    const lines = [];
    Object.keys(item).forEach((k, idx) => {
      const sub = renderEntry(formatKey(k), item[k], indent + 2, unit);
      if (idx === 0) sub[0] = `${pad}- ${sub[0].slice(indent + 2)}`;
      lines.push(...sub);
    });
    return lines;
  }
  return [`${pad}- ${renderScalar(item)}`];
}

const TOP_ORDER = ['name', 'description', 'metadata'];

/**
 * 產生全新檔案用的 frontmatter 區塊（含開頭與結尾的 ---，結尾帶換行）。
 * @param {object} data
 * @returns {string}
 */
export function stringifyFrontmatter(data) {
  const obj = isPlainObject(data) ? data : {};
  const keys = [
    ...TOP_ORDER.filter((k) => hasOwn(obj, k)),
    ...Object.keys(obj).filter((k) => !TOP_ORDER.includes(k)),
  ];
  const lines = [];
  for (const k of keys) {
    if (obj[k] === undefined) continue;
    lines.push(...renderEntry(formatKey(k), obj[k], 0, 2));
  }
  return '---\n' + lines.map((l) => l + '\n').join('') + '---\n';
}

// ───────────────────────── 外科手術式修改 ─────────────────────────

function lastEntry(mapNode, key) {
  if (mapNode.byKey) return mapNode.byKey.get(key) ?? null;
  for (let i = mapNode.entries.length - 1; i >= 0; i--) if (mapNode.entries[i].key === key) return mapNode.entries[i];
  return null;
}

/** 不可變地在物件上設定或刪除巢狀鍵（只看自有屬性，避免原型污染）。 */
function deepSet(obj, parts, value) {
  const root = isPlainObject(obj) ? structuredClone(obj) : {};
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(own(cur, parts[i]))) safeAssign(cur, parts[i], {});
    cur = cur[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (value === undefined) delete cur[last];
  else safeAssign(cur, last, value);
  return root;
}

function invalidError(errors) {
  return new EngramError(E.INVALID, `frontmatter 格式有誤，拒絕修改：${errors.join('；')}`, '請先修正 frontmatter，或以原始碼模式編輯整份內容', { errors });
}

/** 對已切割的文件套用單一更新，直接修改 doc.fmLines。 */
function applyOne(doc, parts, value, smart) {
  const diag = makeDiag();
  const root = parseTree(doc.fmLines, diag);
  if (diag.fatal) throw invalidError(diag.errors);
  const unit = detectIndentUnit(root) || 2;
  const eol = doc.fmEol;
  const toLines = (texts) => texts.map((text) => ({ text, nl: eol }));
  const splice = (start, end, texts) => doc.fmLines.splice(start, end - start, ...toLines(texts));

  let node = root;
  let parentEntry = null;
  let d = 0;
  while (d < parts.length) {
    const m = matchKey((k) => !!lastEntry(node, k), parts, d, smart);
    if (m) {
      const entry = lastEntry(node, m.key);
      if (m.next >= parts.length) {
        if (value === undefined) splice(entry.line, entry.end, []);
        else splice(entry.line, entry.end, renderEntry(entry.keyRaw, value, entry.indent, unit));
        return;
      }
      if (entry.value.kind === 'map' && entry.value.entries.length) {
        parentEntry = entry;
        node = entry.value;
        d = m.next;
        continue;
      }
      // 中間層不是區塊物件（純量、空值、列表或行內物件）→ 整個鍵改寫成物件
      const current = toJS(entry.value);
      if (value === undefined && !isPlainObject(current)) return;
      const next = deepSet(isPlainObject(current) ? current : {}, parts.slice(m.next), value);
      splice(entry.line, entry.end, renderEntry(entry.keyRaw, next, entry.indent, unit));
      return;
    }
    if (value === undefined) return;
    const key = parts[d];
    const sub = d === parts.length - 1 ? value : deepSet({}, parts.slice(d + 1), value);
    if (node.entries.length) {
      splice(node.end, node.end, renderEntry(formatKey(key), sub, node.indent, unit));
    } else if (parentEntry) {
      splice(parentEntry.end, parentEntry.end, renderEntry(formatKey(key), sub, parentEntry.indent + unit, unit));
    } else {
      // 空的 frontmatter：插在最後一個非空行之後
      let at = doc.fmLines.length;
      while (at > 0 && doc.fmLines[at - 1].text.trim() === '') at--;
      splice(at, at, renderEntry(formatKey(key), sub, 0, unit));
    }
    return;
  }
}

/**
 * 只改動指定的鍵，其餘位元組保持原樣。
 * frontmatter 有結構性錯誤（沒有結尾分隔行、tab 縮排、無法解析的行…）時丟出 E_INVALID，不做任何修改。
 * @param {string} text 完整檔案內容
 * @param {Record<string, any> | Array<[string | string[], any]>} updates
 *   點分隔路徑 → 新值；值為 undefined 代表刪除。路徑可用 \. 跳脫，或改傳 [路徑陣列, 值] 的陣列以精確指定。
 * @returns {string}
 */
export function setFields(text, updates) {
  const doc = splitDocument(String(text ?? ''));
  const entries = Array.isArray(updates) ? updates : Object.entries(updates ?? {});
  if (!entries.length) return assemble(doc);
  if (doc.errors.length) throw invalidError(doc.errors);
  const parsed = entries.map(([p, v]) => {
    const { parts, escaped } = splitPath(p);
    return { parts, smart: !escaped, value: v };
  });
  if (!doc.hasFrontmatter) {
    let data = {};
    for (const u of parsed) data = deepSet(data, u.parts, u.value);
    if (!Object.keys(data).length) return assemble(doc);
    const eol = doc.eol;
    const fm = stringifyFrontmatter(data).replace(/\n/g, eol);
    const body = doc.body;
    const sep = body === '' || body.startsWith('\n') || body.startsWith('\r\n') ? '' : eol;
    return doc.bom + fm + sep + body;
  }
  for (const u of parsed) applyOne(doc, u.parts, u.value, u.smart);
  return assemble(doc);
}

/**
 * 換掉內文、保留 frontmatter 原文。結尾分隔行沒有換行而新內文不是空的時，補上換行。
 * 沒有 frontmatter 時整份換成新內文（保留 BOM）。
 * @param {string} text
 * @param {string} body
 */
export function replaceBody(text, body) {
  const doc = splitDocument(String(text ?? ''));
  const next = String(body ?? '');
  if (!doc.hasFrontmatter) return doc.bom + next;
  doc.body = next;
  if (doc.close.nl === '' && next !== '') doc.close = { text: doc.close.text, nl: doc.fmEol };
  return assemble(doc);
}

// ───────────────────────── 比對輔助 ─────────────────────────

/**
 * 內文正規化：統一 LF、去除行尾空白、連續空行收成一行、去頭尾空白。
 * @param {string} body
 */
export function normalizeBody(body) {
  return String(body ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 語意比對用的穩定字串：name、description、type 與正規化內文。不受 harness 欄位影響。
 * @param {{ data: object, body: string }} parsed
 */
export function semanticKey(parsed) {
  const data = parsed?.data ?? {};
  const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
  return JSON.stringify([
    str(own(data, 'name')),
    str(own(data, 'description')),
    str(getField(data, ['metadata', 'type'])),
    normalizeBody(parsed?.body),
  ]);
}

/**
 * 合併頂層 engram 與 metadata.engram（後者優先）。
 * @param {object} data
 */
export function engramMeta(data) {
  const top = isPlainObject(own(data, 'engram')) ? data.engram : {};
  const meta = isPlainObject(own(own(data, 'metadata'), 'engram')) ? data.metadata.engram : {};
  return { ...top, ...meta };
}

/**
 * 把舊格式的頂層 engram 搬到 metadata.engram（與 Claude Code 改寫後的位置一致），回傳新物件。
 * @param {object} data
 */
export function normalizeEngramLocation(data) {
  if (!isPlainObject(data) || !isPlainObject(own(data, 'engram'))) return data;
  const out = structuredClone(data);
  const meta = isPlainObject(own(out, 'metadata')) ? out.metadata : {};
  safeAssign(meta, 'engram', engramMeta(out));
  safeAssign(out, 'metadata', meta);
  delete out.engram;
  return out;
}

/**
 * 物件攤平成「點分隔路徑 → 葉值」。陣列、純量與空物件都視為葉；鍵裡的點以 \. 跳脫。
 * @param {object} data
 * @returns {Record<string, any>}
 */
export function flatten(data, prefix = '', out = {}) {
  if (!isPlainObject(data)) return out;
  for (const k of Object.keys(data)) {
    const path = prefix ? `${prefix}.${escapeKey(k)}` : escapeKey(k);
    const v = data[k];
    if (isPlainObject(v) && Object.keys(v).length) flatten(v, path, out);
    else safeAssign(out, path, v);
  }
  return out;
}

/**
 * flatten 的反向操作（認得 \. 跳脫）。
 * @param {Record<string, any>} flat
 */
export function unflatten(flat) {
  let out = {};
  for (const p of Object.keys(flat ?? {})) {
    const v = flat[p];
    if (v === undefined) continue;
    out = deepSet(out, splitPath(p).parts, v);
  }
  return out;
}
