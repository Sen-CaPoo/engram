// 容易過時的記憶（1.4.0）：Anthropic〈Components of agent memory〉建議把驗證集中在「容易變動」的資訊。
// 只用規則判斷：專案進度類（type project）、單機環境、或內文寫著待辦／尚未／截至這類會過期的狀態。

const DAY = 86_400_000;

// 會過期的狀態用語。刻意不收「目前」「現在」這類太常見的詞，避免幾乎每一筆都算進來。
const MARKERS = /待辦|尚未|還沒|未完成|進行中|截至|預計|暫時|\bTODO\b|\bTBD\b|\bpending\b|\bnot yet\b|\bas of\b|\bin progress\b|\bfor now\b/i;

/** 內文去掉程式碼區塊（指令範例裡的 TODO 不算） */
function prose(text) {
  return String(text ?? '').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

/**
 * @param {{ type?: string, scope?: { kind: string } }} m  MemorySummary
 * @param {string} body  內文
 * @returns {{ yes: boolean, reasons: ('type'|'machine'|'marker')[] }}
 */
export function volatility(m, body) {
  const reasons = [];
  if (m?.type === 'project') reasons.push('type');
  if (m?.scope?.kind === 'machine') reasons.push('machine');
  if (MARKERS.test(prose(body))) reasons.push('marker');
  return { yes: reasons.length > 0, reasons };
}

/** 最後確認的時間（毫秒）：驗證日期與最後修改時間取較新的；都沒有時 0。 */
export function lastCheckedMs(m) {
  const v = m?.verified ? Date.parse(`${m.verified}T00:00:00`) : 0;
  const u = Date.parse(m?.updatedAt ?? '') || 0;
  return Math.max(Number.isNaN(v) ? 0 : v, u);
}

/** 多久沒確認（天，無條件捨去）；沒有任何時間資訊時 null。 */
export function uncheckedDays(m, now = Date.now()) {
  const t = lastCheckedMs(m);
  return t ? Math.floor((now - t) / DAY) : null;
}
