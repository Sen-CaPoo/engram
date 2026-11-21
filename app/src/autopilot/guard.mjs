// 自動駕駛的硬性護欄（1.5.0）：不靠 LLM 遵守，由程式判斷。
// - 指令型內容：新寫入的內容像是被注入的指示、可疑指令或外洩資料的要求 → 一定要過審核員
// - 風險分級：決定哪些項目要審核員確認（只有 verify 不必）
// - 類別：由實際的動作推導（不採用 LLM 自己填的標籤），用於回饋與暫停
// - 單輪上限：以實際動到的記憶數計算
// - 2.0.0：拆分一律不執行；改寫後內文大幅變短的標上「大幅刪減」，一定送審核員（使用者的決定：不拆分、不為了精簡而刪減記憶）
import { parseMemoryFile } from '../core/frontmatter.mjs';

const PATTERNS = [
  [/(ignore|forget|disregard|override)\s+(all\s+|any\s+|the\s+|everything\s+|your\s+)*(previous|prior|above|earlier|system|original)?\s*(instructions|rules|directions|prompts?|guidelines|everything)/i, '要求忽略先前的指示'],
  [/(忽略|無視|不要理會|忘掉|忘記)[^\n]{0,12}(之前|先前|以上|上述|所有|系統|原本)[^\n]{0,6}(的)?(指示|指令|規則|提示|設定)/, '要求忽略先前的指示'],
  [/(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]{0,200}\|\s*(sh|bash|zsh|iex|Invoke-Expression|powershell|pwsh|python)\b/i, '下載後直接執行的指令'],
  [/(fetch|download|open|read|load|讀取|下載|打開|開啟)[^\n]{0,80}(https?:\/\/\S+)[^\n]{0,60}(and|then|並|再|後)\s*(follow|obey|execute|run|do what|照做|照著做|執行|遵守)/i, '要求讀取外部內容後照做'],
  [/powershell[^\n]{0,80}\s-e(nc|ncodedcommand)?\s+[A-Za-z0-9+/=]{20,}/i, '編碼過的 PowerShell 指令'],
  [/\bbase64\s+(-d|--decode)\b[^\n]{0,80}\|\s*(sh|bash)/i, '解碼後直接執行'],
  [/(send|post|upload|exfiltrat\w*|forward|paste|傳送|上傳|寄送|回傳|貼到|貼上)[^\n]{0,80}(token|api[ _-]?key|password|credential|secret|cookie|\.ssh|id_rsa|id_ed25519|\.aws|\.env|金鑰|密碼|憑證|權杖|私鑰)/i, '把憑證或私鑰送出去'],
  [/(token|api[ _-]?key|password|credential|secret|cookie|\.ssh|id_rsa|id_ed25519|\.aws|\.env|金鑰|密碼|憑證|權杖|私鑰)[^\n]{0,60}(send|post|upload|forward|paste|傳送|上傳|寄送|回傳|貼到)[^\n]{0,40}(https?:\/\/|\S+@\S+)/i, '把憑證或私鑰送出去'],
  [/(always|must|every time|每次|一律|永遠|務必)[^\n]{0,60}(run|execute|執行)[^\n]{0,80}(curl|wget|rm -rf|del \/[sq]|format [a-z]:|reg add|schtasks|Invoke-Expression|iex)\b/i, '要求每次執行可疑指令'],
  [/rm\s+-rf\s+(\/|~|\$HOME)(\s|$)/i, '刪除整個系統或家目錄'],
  [/--dangerously-skip-permissions|bypassPermissions|disableAllHooks|permissions\.allow/i, '要求關掉權限保護'],
  [/<\/?(system|assistant|instructions?)>|\[\s*(system|assistant)\s*\]\s*:|^\s*(system|assistant)\s*:/im, '偽裝成系統或助理訊息'],
];

/** 比對前先正規化：全形轉半形（NFKC）、拿掉零寬字元與軟連字號 */
export function normalizeText(t) {
  return String(t ?? '').normalize('NFKC').replace(/[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD]/g, '');
}

/** 新內容相對於舊內容新增的行 */
export function addedLines(next, prev = '') {
  const old = new Set(normalizeText(prev).replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()));
  return normalizeText(next).replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() && !old.has(l.trim()));
}

/**
 * 內容裡看起來像注入指示的地方；回傳理由（沒有時空陣列）。prev 給舊內容時只看新增的行；
 * 每一行也和下一行接起來比對，避免把一句話拆成兩行就躲過。
 */
export function instructionFlags(next, prev = '') {
  const lines = addedLines(next, prev);
  // 每一行、相鄰兩行接起來、以及全部接成一段：拆成好幾行也躲不過
  const text = [...lines, ...lines.slice(1).map((l, i) => `${lines[i]} ${l}`), lines.join(' ')].join('\n');
  const out = [];
  for (const [re, why] of PATTERNS) if (re.test(text) && !out.includes(why)) out.push(why);
  return out;
}

export const SHARED = (scope) => scope === 'global' || scope === 'core' || String(scope ?? '').startsWith('machine');

/** 一個計畫項目寫到哪些範圍（'global'、'core'、'machine:<mid>'、'project:<pid>'） */
export function targetScopes(item, scopeOfRef) {
  const out = new Set();
  for (const o of item.ops ?? []) {
    if (o.op === 'core') out.add('core');
    else if (o.op === 'move') out.add(o.to);
    else if (o.op === 'create') out.add(o.scope === 'machine' ? 'machine:' : o.scope);
    else if (o.op === 'merge') { out.add(scopeOfRef(o.into ?? o.refs?.[0])); for (const r of o.refs ?? []) out.add(scopeOfRef(r)); }
    else if (o.ref) out.add(scopeOfRef(o.ref));
  }
  return [...out].filter(Boolean);
}

/**
 * 記憶畢業（2.0.0 WP9）才有的動作：guardrail（加一條護欄提醒規則）、env（環境設定檔加一項）、
 * graduate（在原記憶的 frontmatter 記下去向；內文不動）。不是記憶整理的動作，不會交給整理計畫流程。
 */
export const GRADUATE_OPS = ['guardrail', 'env', 'graduate'];

/**
 * 風險：low 不必審核；medium、high 要審核員同意。
 * - high：封存、合併、核心準則、碰到每次都會載入的範圍（全域、單機）、拆分
 * - medium：其他改寫、在專案範圍內搬移或新增（只改 frontmatter 也算：description 會進每次載入的索引）
 * - low：只有確認仍正確（verify）
 */
export function riskOf(item, scopeOfRef) {
  const ops = item.ops ?? [];
  if (!ops.length) return 'low';
  // 2.0.0 WP9：記憶畢業（護欄規則、環境設定、在記憶記下去向）一律送審，不看範圍
  if (ops.some((o) => GRADUATE_OPS.includes(o.op))) return 'high';
  if (ops.every((o) => o.op === 'verify')) return 'low';
  if (ops.some((o) => o.op === 'remove' || o.op === 'merge' || o.op === 'core')) return 'high';
  if (ops.some((o) => o.op === 'create') && ops.some((o) => o.op === 'write')) return 'high';
  if (targetScopes(item, scopeOfRef).some(SHARED)) return 'high';
  return 'medium';
}

/** 只改了 frontmatter、內文一字不差 */
export function frontmatterOnly(before, after) {
  const a = parseMemoryFile(String(before ?? ''));
  const b = parseMemoryFile(String(after ?? ''));
  return a.body.trim() === b.body.trim();
}

/**
 * 回饋與暫停用的類別：由動作推導，不看 LLM 填的 action 標籤（否則換個標籤就能躲過暫停）。
 */
export function categoryOf(item, { dream = false, scopeOfRef = () => null } = {}) {
  const ops = item.ops ?? [];
  const has = (k) => ops.some((o) => o.op === k);
  if (has('core')) return 'core';
  if (has('guardrail')) return 'guardrail';
  if (has('env')) return 'env';
  if (has('merge')) return 'merge';
  if (has('remove')) return 'archive';
  if (has('create') && has('write')) return 'split';
  if (has('move')) return ops.some((o) => o.op === 'move' && o.to === 'global') ? 'promote' : 'move';
  if (has('create')) return dream ? 'dream-create' : 'create';
  if (ops.length && ops.every((o) => o.op === 'verify')) return 'verify';
  return dream ? 'dream-update' : 'update';
}

/** 內文的行（比對「新增的內容是不是來自那一筆」用）：去掉清單符號與多餘空白；Why／How to apply 這類每筆都有的樣板行不算 */
function bodyLines(text) {
  return parseMemoryFile(String(text ?? '')).body.replace(/\r\n/g, '\n').split('\n')
    .map((l) => normalizeText(l).trim().replace(/^([-*+]|\d+[.)])\s+/, '').replace(/\s+/g, ' '))
    .filter((l) => l && !/^\*\*(Why|How to apply)/i.test(l));
}

/** 新內容有多少（以字數計）是逐行照抄 sourceLines 的：0～1 */
function derivedShare(content, sourceLines) {
  const lines = bodyLines(content);
  const total = lines.reduce((n, l) => n + l.length, 0);
  return total ? lines.filter((l) => sourceLines.has(l)).reduce((n, l) => n + l.length, 0) / total : 0;
}

/**
 * 拆分（2.0.0：依使用者的偏好不拆分記憶，一律不執行）：從動作判斷（同一項裡新增＋改寫），也看 LLM 自己標的 split。
 * 不能只看 categoryOf：同一項裡還有封存時，categoryOf 會回 archive。
 * 審查 F4：新增的同時封存（或合併掉）某一筆既有記憶，而新增的內容主要（一半以上）來自那一筆，也是拆分的寫法
 * （例如新增兩筆、再封存原檔）。textOf(ref) 給目前的內容；不給時只看動作。
 */
export function isSplit(item, textOf = null) {
  const ops = item.ops ?? [];
  if (item.action === 'split') return true;
  const creates = ops.filter((o) => o.op === 'create');
  if (!creates.length) return false;
  if (ops.some((o) => o.op === 'write')) return true;
  if (typeof textOf !== 'function') return false;
  const gone = ops.flatMap((o) => (o.op === 'remove' ? [o.ref] : o.op === 'merge' ? (o.refs ?? []).filter((r) => r !== (o.into ?? o.refs?.[0])) : []));
  const source = new Set(gone.flatMap((r) => bodyLines(textOf(r))));
  return source.size > 0 && creates.some((o) => derivedShare(o.content, source) >= 0.5);
}

/**
 * 拆到不同項目的拆分（2.0.0 第二輪審查 R5）：同一批裡，一個項目新增記憶，另一個項目封存、合併掉或大幅刪減某一筆記憶，
 * 而新增的內容主要（一半以上）來自被拿掉的那些內文。回傳要一起拒絕的項目索引（新增的與拿掉來源的都算）。
 * 合併時被併掉的記憶，內容通常進了同一項的合併結果，只和「別的項目」的新增比對。
 */
export function crossSplits(items, textOf) {
  const out = new Set();
  const sources = [];
  items.forEach((it, i) => {
    for (const o of it.ops ?? []) {
      if (o.op === 'remove') sources.push({ i, lines: new Set(bodyLines(textOf(o.ref))) });
      else if (o.op === 'merge') for (const r of (o.refs ?? []).filter((x) => x !== (o.into ?? o.refs?.[0]))) sources.push({ i, lines: new Set(bodyLines(textOf(r))) });
      else if (o.op === 'write' && shrunk(textOf(o.ref), o.content)) {
        const kept = new Set(bodyLines(o.content));
        sources.push({ i, lines: new Set(bodyLines(textOf(o.ref)).filter((l) => !kept.has(l))) });
      }
    }
  });
  if (!sources.length) return out;
  items.forEach((it, i) => {
    for (const o of (it.ops ?? []).filter((x) => x.op === 'create')) {
      for (const s of sources) if (s.i !== i && s.lines.size && derivedShare(o.content, s.lines) >= 0.5) { out.add(i); out.add(s.i); }
    }
  });
  return out;
}

/** 改寫後內文比原本短多少以上算「大幅刪減」（2.0.0：一定送審核員，並提醒審核員逐一確認被拿掉的內容） */
export const SHRINK_RATIO = 0.3;
export function shrunk(before, after) {
  const b0 = parseMemoryFile(String(before ?? '')).body.trim().length;
  const b1 = parseMemoryFile(String(after ?? '')).body.trim().length;
  return b0 > 0 && b1 < b0 * (1 - SHRINK_RATIO);
}

/** 一個項目裡所有動作各自的類別（暫停判斷用：任何一個類別被暫停就整項不做） */
export function categoriesOf(item, { dream = false } = {}) {
  const out = new Set([categoryOf(item, { dream })]);
  // 記下畢業去向（graduate）只是附帶的一步，不是另一類處理
  for (const o of item.ops ?? []) if (o.op !== 'graduate') out.add(categoryOf({ ops: [o] }, { dream }));
  return [...out];
}

/** 一個項目實際動到幾筆記憶（上限用）：每筆被修改、搬移、封存、合併的記憶與每筆新增各算一筆 */
export function costOf(item) {
  const refs = new Set();
  let creates = 0;
  for (const o of item.ops ?? []) {
    if (o.op === 'create') creates++;
    else if (o.op === 'merge') for (const r of o.refs ?? []) refs.add(r);
    else if (o.op === 'core') refs.add('core/CORE.md');
    else if (o.ref) refs.add(o.ref);
  }
  return Math.max(1, refs.size + creates);
}

/** 一個項目最多幾個動作、合併最多幾筆（避免一個項目塞進大量變更） */
export const MAX_OPS = 6;
export const MAX_MERGE = 5;

/** 核心準則每輪最多新增的行數與字數（每次對話都會載入，新增要節制） */
export const CORE_ADD_LINES = 12;
export const CORE_ADD_CHARS = 1200;

/** 單輪上限：最多改動 30 筆記憶，而且不超過記憶總數的 15%（至少 5 筆） */
export function changeCap(memoryCount) {
  return Math.min(30, Math.max(5, Math.ceil(memoryCount * 0.15)));
}
