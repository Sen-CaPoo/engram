// 記憶之間的 [[名稱]] 連結（1.4.0）：Anthropic 的記憶研究發現，第二輪「補洞」（修好斷掉的連結）能讓記憶更好用。
// 這裡只用規則判斷：連結指向的記憶曾經存在、後來被合併或封存，才算「斷了」。
// 從來沒有存在過的名稱不算錯（Claude Code 的說法：代表之後值得寫的主題）。
import path from 'node:path';
import { git } from './git.mjs';

/** 只撈合併與封存的 commit（git log --grep），由新到舊：{ action, refs } */
async function mergeAndRemoveCommits(ctx, limit) {
  const r = await git(['log', `-n${limit}`, '-E', '--grep=^Engram-Action: (merge|remove)$', '--format=%x1e%b'], { cwd: ctx.vault, allowFail: true });
  if (r.code !== 0) return [];
  return r.stdout.split('\x1e').filter((b) => b.trim()).map((body) => ({
    action: /^Engram-Action:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? null,
    refs: [...body.matchAll(/^Engram-Refs:\s*(.+)$/gm)].map((m) => m[1].trim()),
  }));
}

const LINK_RE = /\[\[([^\]\n|#]{1,120})(?:[|#][^\]\n]{0,120})?\]\]/g;

/** 內文去掉程式碼區塊（範例裡的 [[x]] 不算連結），保留行數不變 */
function stripCode(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

/** 內文裡的連結名稱（去重、保留第一次出現的順序） */
export function linksIn(body) {
  const out = [];
  for (const m of stripCode(body).matchAll(LINK_RE)) {
    const name = m[1].trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

const baseName = (ref) => path.posix.basename(String(ref), '.md');
const key = (s) => String(s).trim().toLowerCase();

/**
 * 名稱 → 目前的記憶（frontmatter name 與檔名都算）。同名時優先全域，其次依 ref 排序第一筆。
 * @param {object[]} memories  scanAllMemories 的結果
 */
export function nameIndex(memories) {
  const rank = (m) => (m.scope?.kind === 'global' ? 0 : m.scope?.kind === 'project' ? 1 : 2);
  const map = new Map();
  for (const m of [...memories].sort((a, b) => rank(a) - rank(b) || a.ref.localeCompare(b.ref))) {
    for (const n of new Set([m.name, baseName(m.ref)])) if (n && !map.has(key(n))) map.set(key(n), m);
  }
  return map;
}

/**
 * 從變更紀錄找出「曾經存在的名稱」去了哪裡：被合併 → 合併後的記憶名稱；被封存 → null。
 * 合併後的記憶也記在 metadata.engram.supersedes（合併時寫入），一併參考。
 * @returns {Promise<Map<string, { to: string|null, via: 'merge'|'remove' }>>} 小寫名稱 → 去向
 */
export async function formerNames(ctx, memories, { limit = 5000 } = {}) {
  const gone = new Map();
  const commits = await mergeAndRemoveCommits(ctx, limit).catch(() => []);
  // 由舊到新套用，較新的去向蓋掉較舊的
  for (const c of [...commits].reverse()) {
    if (c.action === 'merge' && c.refs.length >= 2) {
      const to = baseName(c.refs[0]);
      for (const r of c.refs.slice(1)) if (key(baseName(r)) !== key(to)) gone.set(key(baseName(r)), { to, via: 'merge' });
    } else if (c.action === 'remove' && c.refs.length) {
      gone.set(key(baseName(c.refs[0])), { to: null, via: 'remove' });
    }
  }
  for (const m of memories) {
    const sup = m._parsed?.data?.metadata?.engram?.supersedes;
    for (const r of Array.isArray(sup) ? sup : []) if (key(baseName(r)) !== key(m.name)) gone.set(key(baseName(r)), { to: m.name, via: 'merge' });
  }
  return gone;
}

/**
 * 斷掉的連結。合併鏈（a → b → c）會一路追到目前還在的記憶。
 * @returns {Promise<{ ref: string, name: string, from: string, to: string|null, via: 'merge'|'remove' }[]>}
 */
export async function brokenLinks(ctx, memories) {
  const names = nameIndex(memories);
  let gone = null;
  const out = [];
  for (const m of memories) {
    const links = linksIn(m._parsed?.body);
    for (const l of links) {
      if (names.has(key(l))) continue;
      gone ??= await formerNames(ctx, memories);
      let g = gone.get(key(l));
      if (!g) continue;
      // 追合併鏈（防止循環）
      const seen = new Set([key(l)]);
      let to = g.to;
      while (to && !names.has(key(to)) && gone.has(key(to)) && !seen.has(key(to))) {
        seen.add(key(to));
        g = gone.get(key(to));
        to = g.to;
      }
      const target = to && names.get(key(to));
      if (target && target.ref === m.ref) continue; // 合併進自己：不必改指向（由內容決定要不要拿掉）
      out.push({ ref: m.ref, name: m.name, from: l, to: target ? target.name : null, via: target ? 'merge' : 'remove' });
    }
  }
  return out;
}

/** 某筆記憶的連結關係：連到誰（對不到時 ref 為 null）、被誰連結。 */
export function linkGraph(memories, ref) {
  const names = nameIndex(memories);
  const me = memories.find((m) => m.ref === ref);
  if (!me) return { out: [], in: [] };
  const out = linksIn(me._parsed?.body).map((n) => ({ name: n, ref: names.get(key(n))?.ref ?? null }));
  const mine = new Set([key(me.name), key(baseName(me.ref))]);
  const inbound = memories
    .filter((m) => m.ref !== ref && linksIn(m._parsed?.body).some((n) => mine.has(key(n)) && names.get(key(n))?.ref === ref))
    .map((m) => ({ ref: m.ref, name: m.name }));
  return { out, in: inbound };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 改寫內文裡指向 from 的連結（frontmatter 不動）：to 為名稱時改指向，null 時拿掉括號只留文字。
 * 程式碼區塊裡的不改。回傳 { text, count }。
 */
export function rewriteLinks(text, from, to) {
  const src = String(text ?? '');
  // frontmatter 原樣保留
  const bom = src.charCodeAt(0) === 0xfeff ? src[0] : '';
  const fm = /^(---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$))/.exec(src.slice(bom.length));
  const head = bom + (fm ? fm[1] : '');
  const body = src.slice(head.length);
  const mask = stripCode(body);
  const re = new RegExp(`\\[\\[\\s*${esc(from)}\\s*(?:[|#]([^\\]\\n]{0,120}))?\\]\\]`, 'gi');
  let count = 0;
  let outBody = '';
  let last = 0;
  for (const m of mask.matchAll(re)) {
    const at = m.index;
    const original = body.slice(at, at + m[0].length);
    const alias = /\|([^\]\n]*)\]\]$/.exec(original)?.[1];
    const repl = to ? `[[${to}${alias !== undefined ? `|${alias}` : ''}]]` : (alias || from);
    outBody += body.slice(last, at) + repl;
    last = at + m[0].length;
    count++;
  }
  outBody += body.slice(last);
  return { text: head + outBody, count };
}
