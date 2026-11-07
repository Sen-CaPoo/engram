// 自動駕駛的硬性護欄（1.5.0）：不靠 LLM 遵守，由程式判斷。
// - 指令型內容：新寫入的內容像是被注入的指示、可疑指令或外洩資料的要求 → 一定要過審核員
// - 風險分級：決定哪些項目要審核員確認（只有 verify 不必）
// - 類別：由實際的動作推導（不採用 LLM 自己填的標籤），用於回饋與暫停
// - 單輪上限：以實際動到的記憶數計算
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
 * 風險：low 不必審核；medium、high 要審核員同意。
 * - high：封存、合併、核心準則、碰到每次都會載入的範圍（全域、單機）、拆分
 * - medium：其他改寫、在專案範圍內搬移或新增（只改 frontmatter 也算：description 會進每次載入的索引）
 * - low：只有確認仍正確（verify）
 */
export function riskOf(item, scopeOfRef) {
  const ops = item.ops ?? [];
  if (!ops.length) return 'low';
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
  if (has('merge')) return 'merge';
  if (has('remove')) return 'archive';
  if (has('create') && has('write')) return 'split';
  if (has('move')) return ops.some((o) => o.op === 'move' && o.to === 'global') ? 'promote' : 'move';
  if (has('create')) return dream ? 'dream-create' : 'create';
  if (ops.length && ops.every((o) => o.op === 'verify')) return 'verify';
  return dream ? 'dream-update' : 'update';
}

/** 一個項目裡所有動作各自的類別（暫停判斷用：任何一個類別被暫停就整項不做） */
export function categoriesOf(item, { dream = false } = {}) {
  const out = new Set([categoryOf(item, { dream })]);
  for (const o of item.ops ?? []) out.add(categoryOf({ ops: [o] }, { dream }));
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
