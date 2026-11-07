// 自動駕駛的硬性護欄（1.5.0）：不靠 LLM 遵守，由程式判斷。
// - 指令型內容：新寫入的內容（只看新增的行）像是被注入的指示、可疑指令或外洩資料的要求 → 一定要過審核員
// - 風險分級：決定哪些項目要審核員確認
// - 單輪上限：一輪最多改動的項目數
import { parseMemoryFile } from '../core/frontmatter.mjs';

const PATTERNS = [
  [/ignore (all |any |the )?(previous|prior|above|earlier) (instructions|rules|directions)/i, '要求忽略先前的指示'],
  [/disregard[^\n]{0,40}(instructions|rules|system prompt)/i, '要求忽略指示'],
  [/(忽略|無視|不要理會)[^\n]{0,10}(之前|先前|以上|上述|所有|系統)[^\n]{0,6}(的)?(指示|指令|規則|提示)/, '要求忽略先前的指示'],
  [/(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]{0,200}\|\s*(sh|bash|zsh|iex|Invoke-Expression|powershell|pwsh|python)\b/i, '下載後直接執行的指令'],
  [/powershell[^\n]{0,80}\s-e(nc|ncodedcommand)?\s+[A-Za-z0-9+/=]{20,}/i, '編碼過的 PowerShell 指令'],
  [/\bbase64\s+(-d|--decode)\b[^\n]{0,80}\|\s*(sh|bash)/i, '解碼後直接執行'],
  [/(send|post|upload|exfiltrat\w*|forward|傳送|上傳|寄送|回傳)[^\n]{0,60}(token|api[ _-]?key|password|credential|secret|cookie|金鑰|密碼|憑證|權杖)[^\n]{0,60}(to|至|到|給)\s*(https?:\/\/|\S+@\S+)/i, '把憑證送到外部'],
  [/(always|must|every time|每次|一律|永遠|務必)[^\n]{0,60}(run|execute|執行)[^\n]{0,80}(curl|wget|rm -rf|del \/[sq]|format [a-z]:|reg add|schtasks|Invoke-Expression|iex)\b/i, '要求每次執行可疑指令'],
  [/rm\s+-rf\s+(\/|~|\$HOME)(\s|$)/i, '刪除整個系統或家目錄'],
  [/--dangerously-skip-permissions|"defaultMode"\s*:\s*"bypassPermissions"/i, '要求關掉權限保護'],
  [/<\/?(system|assistant|instructions?)>|\[\s*(system|assistant)\s*\]\s*:/i, '偽裝成系統或助理訊息'],
];

/** 新內容相對於舊內容新增的行 */
export function addedLines(next, prev = '') {
  const old = new Set(String(prev ?? '').replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()));
  return String(next ?? '').replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() && !old.has(l.trim()));
}

/** 新增的內容裡看起來像注入指示的地方；回傳理由（沒有時空陣列） */
export function instructionFlags(next, prev = '') {
  const text = addedLines(next, prev).join('\n');
  const out = [];
  for (const [re, why] of PATTERNS) if (re.test(text) && !out.includes(why)) out.push(why);
  return out;
}

const SHARED = (scope) => scope === 'global' || scope === 'core' || String(scope ?? '').startsWith('machine');

/** 一個計畫項目寫到哪些範圍（'global'、'core'、'machine:<mid>'、'project:<pid>'） */
export function targetScopes(item, scopeOfRef) {
  const out = new Set();
  for (const o of item.ops ?? []) {
    if (o.op === 'core') out.add('core');
    else if (o.op === 'move') out.add(o.to);
    else if (o.op === 'create') out.add(o.scope);
    else if (o.op === 'merge') out.add(scopeOfRef(o.into ?? o.refs?.[0]));
    else if (o.ref) out.add(scopeOfRef(o.ref));
  }
  return [...out].filter(Boolean);
}

/**
 * 風險：low 不必審核；medium、high 要審核員同意。
 * - high：封存、合併、核心準則、寫進每次都會載入的範圍（全域、單機）、拆分
 * - medium：改寫、在專案範圍內搬移或新增
 * - low：確認仍正確（verify）、只改 frontmatter
 */
export function riskOf(item, scopeOfRef) {
  const ops = item.ops ?? [];
  if (!ops.length) return 'low';
  if (ops.every((o) => o.op === 'verify')) return 'low';
  if (ops.some((o) => o.op === 'remove' || o.op === 'merge' || o.op === 'core')) return 'high';
  if (item.action === 'split') return 'high';
  if (targetScopes(item, scopeOfRef).some(SHARED)) return 'high';
  if (ops.length === 1 && ops[0].op === 'write' && ops[0].before !== undefined && frontmatterOnly(ops[0].before, ops[0].content)) return 'low';
  return 'medium';
}

/** 只改了 frontmatter、內文一字不差 */
export function frontmatterOnly(before, after) {
  const a = parseMemoryFile(String(before ?? ''));
  const b = parseMemoryFile(String(after ?? ''));
  return a.body.trim() === b.body.trim();
}

/** 回饋與暫停用的類別 */
export function categoryOf(item, { dream = false } = {}) {
  if ((item.ops ?? []).some((o) => o.op === 'core')) return 'core';
  if (dream && item.action === 'create') return 'dream-create';
  if (dream && item.action === 'update') return 'dream-update';
  return String(item.action || 'update');
}

/** 單輪上限：最多 30 項，而且不超過記憶總數的 15%（至少 5 項） */
export function changeCap(memoryCount) {
  return Math.min(30, Math.max(5, Math.ceil(memoryCount * 0.15)));
}
