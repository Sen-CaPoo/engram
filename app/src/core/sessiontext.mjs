// SessionStart 動態內容的文字（41 號文件 §09）：純函式，不讀檔、不依賴引擎。
// 完整路徑（core/session.mjs 的 sessionContext）與快速路徑（core/sessioncache.mjs，常駐程式預先寫好的快取）都用這裡組出文字，
// 所以兩條路徑的輸出一字不差（2.0.0 S5）。格式：≤ 12 行、≤ 1,200 字元。
export const MAX_LINES = 12;
export const MAX_CHARS = 1200;
export const SYNC_FAILURE_NOTICE_MS = 3_600_000; // 非離線的同步失敗超過這麼久，開場訊息要請 Claude 告訴使用者
export const WRITE_LINE = '記憶寫入：專案 → 自動記憶（照常）；全域 → engram remember --scope global；單機 → engram remember --scope machine';

export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso ?? '');
  if (!t) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return '剛剛';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 小時前`;
  return `${Math.round(h / 24)} 天前`;
}

/** 持續時間的口語寫法：5 小時 30 分、2 天 3 小時 */
function durationText(ms) {
  const total = Math.round(ms / 60_000);
  if (total >= 1440) {
    const hours = Math.floor((total % 1440) / 60);
    return `${Math.floor(total / 1440)} 天${hours ? ` ${hours} 小時` : ''}`;
  }
  const minutes = total % 60;
  return `${Math.floor(total / 60)} 小時${minutes ? ` ${minutes} 分` : ''}`;
}

function syncLine(state, now) {
  const s = state.sync ?? {};
  const last = relativeTime(s.lastSuccessAt, now);
  if (!state.remote && (!s.state || s.state === 'never' || s.state === 'ok') && !s.lastSuccessAt) return '同步：僅本機（尚未設定同步）';
  switch (s.state) {
    case 'syncing': return '同步：同步中';
    case 'offline': return `同步：離線${last ? `（最後成功 ${last}）` : ''}`;
    case 'auth': return '同步：需要重新登入 GitHub';
    case 'error': return s.error?.code === 'E_PUSH_PROTECTED' ? '同步：推送被 GitHub 擋下' : `同步：發生錯誤${last ? `（最後成功 ${last}）` : ''}`;
    default: return last ? `同步：最後同步 ${last}` : '同步：尚未同步';
  }
}

/** 依優先序組合，超過上限時從最低優先的警告開始刪。 */
function compose(head, warnings) {
  const sorted = [...warnings].sort((a, b) => a.priority - b.priority).slice(0, 3);
  for (;;) {
    const lines = [...head, ...sorted.flatMap((w) => w.text.split('\n'))];
    const text = lines.join('\n');
    if ((lines.length <= MAX_LINES && text.length <= MAX_CHARS) || !sorted.length) return text.slice(0, MAX_CHARS);
    sorted.pop();
  }
}

/**
 * 和目前資料夾無關的那部分警告：核心準則衝突、同步連續失敗、GitHub 登入、推送被擋、疑似金鑰。順序與優先序照原本。
 * @param {{ coreConflicts: number, state: { remote?: string|null, sync?: object|null, syncIssue?: object|null } }} shared
 */
function sharedWarnings(shared, now) {
  const out = [];
  for (let i = 0; i < shared.coreConflicts; i++) out.push({ priority: 1, text: '⚠ 核心準則 CORE.md 在兩台電腦有衝突（目前使用本機版本），請在 Engram 介面確認。' });
  const state = shared.state ?? {};
  // S2：非離線的同步失敗連續超過 1 小時（例如被扣住的檔案擋住合併）：要明確請 Claude 告訴使用者，不受「使用者沒問就不要提」限制
  const issue = state.syncIssue;
  const failingSince = Date.parse(issue?.since ?? '');
  if (issue && issue.offline === false && Number.isFinite(failingSince) && now - failingSince > SYNC_FAILURE_NOTICE_MS) {
    const files = (issue.diagnosis?.blockers ?? []).map((b) => b.ref).slice(0, 2);
    out.push({
      priority: 1,
      text: `⚠ Engram 同步已連續失敗 ${durationText(now - failingSince)}，不是離線（${issue.code}：${issue.message}）${files.length ? `；擋住的檔案：${files.join('、')}` : ''}。\n  請在這次對話一開始就主動告訴使用者，並請他到 Engram 管理介面的收件匣查看；這是「使用者沒問就不要提」的例外。`,
    });
  }
  if (state.sync?.state === 'auth') out.push({ priority: 5, text: '⚠ GitHub 登入已失效，記憶暫時不會同步到其他電腦。' });
  if (state.sync?.error?.code === 'E_PUSH_PROTECTED') out.push({ priority: 5, text: '⚠ GitHub 擋下了推送（疑似含有金鑰），記憶暫時不會同步。' });
  if (state.sync?.blockedBySecrets?.length) out.push({ priority: 6, text: `⚠ 有 ${state.sync.blockedBySecrets.length} 筆記憶疑似含有金鑰，未同步。記憶裡請只記「存放位置」。` });
  return out;
}

/**
 * 組出開場訊息。
 * - projectPart、bindState、bindingWarnings：目前資料夾的綁定（sessionContext 算的；快速路徑用快取）。
 * - shared：{ coreConflicts, conflictCount, inboxCount, userPaused, state: { remote, sync, syncIssue } }。
 * - machineWarning：這台電腦上只與目前專案有關的單機記憶；guard：護欄的後備提示。兩者優先序最低，放不下時先被省略。
 * @returns {{ text: string, warnings: { priority: number, text: string }[] }}
 */
export function renderSession({ label, mid, projectPart, bindState, bindingWarnings = [], shared, machineWarning = null, guard = null, now = Date.now() }) {
  const warnings = [...bindingWarnings, ...sharedWarnings(shared, now)];
  if (machineWarning) warnings.push(machineWarning);
  if (guard) warnings.push(guard);
  const inbox = (shared.inboxCount ?? 0) + (shared.conflictCount && !shared.inboxCount ? shared.conflictCount : 0);
  const head = [
    // 全形括號後面不加空白，與「（mid）· 」一致
    `[Engram] ${label}（${mid}）· ${projectPart}${bindState ? `${/[）」]$/.test(projectPart) ? '' : ' '}· ${bindState}` : ''}`,
    WRITE_LINE,
    shared.userPaused ? '同步：Engram 已暫停（不同步、不自動接上）' : syncLine(shared.state ?? {}, now),
  ];
  if (inbox > 0) head.push(`收件匣：${inbox} 項待整理（使用者沒有問起就不要提）`);
  return { text: compose(head, warnings), warnings };
}
