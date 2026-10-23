// SessionStart、Stop、SessionEnd、PostCompact 的處理（ADR §06）。
// 只做本機動作：網路同步一律交給常駐程式，hook 本身不等待結果。
import path from 'node:path';
import { isFresh } from '../agent/heartbeat.mjs';
import { safeName, writeJsonAtomic } from '../cli/fsutil.mjs';
import { BIN_PATH } from '../cli/paths.mjs';
import { recordMemoryIndex } from './loaded.mjs';

export const CONTEXT_LIMIT = 1500; // additionalContext 上限（F14；ADR §06）
export const SYNC_STALE_MS = 10 * 60_000; // 距離上次同步超過 10 分鐘才請常駐程式同步
export const FAILURE_NOTICE_AT = 2; // hooks 連續失敗幾次後在 SessionStart 提醒
const AGENT_TIMEOUT_MS = 150; // 對本機常駐程式的請求上限；逾時就當作沒送到

const iso = (deps) => new Date(deps.now()).toISOString();

/** 超過上限時截斷並加上省略號，不切開代理對（surrogate pair）。 */
export function clip(text, limit = CONTEXT_LIMIT) {
  if (text.length <= limit) return text;
  let end = limit - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** hooks 連續失敗時加在狀態文字裡的提醒 */
export function failureNotice(f) {
  return `⚠ Engram 的背景動作最近連續失敗 ${f.count} 次（${f.last?.message ?? '原因不明'}）。請執行 engram doctor 檢查；詳細記錄在 ~/.engram/local/logs/。`;
}

/** SessionStart 的 hook 輸出（F14）。沒有內容時不輸出。 */
export function contextOutput(text) {
  const body = clip(String(text ?? '').trim());
  if (!body) return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: body } });
}

/**
 * SessionStart：注入精簡狀態；常駐程式沒在跑就啟動它；太久沒同步就請它同步。
 * 記憶資料夾的 junction 由引擎的 sessionContext 處理：只在原資料夾不存在或為空時當場建立，
 * 其他情況引擎記成 pending，由常駐程式在對話結束後切換（R-06）。
 */
export async function sessionStart(input, deps) {
  let memoryIndex = null;
  let pid = null;
  try {
    const eg = await deps.loadEngine();
    const ctx = await eg.sessionContext({
      cwd: input.cwd,
      event: input.source ?? 'startup',
      transcriptPath: input.transcript_path,
      sessionId: input.session_id,
    });
    memoryIndex = ctx.memoryIndex ?? null;
    pid = ctx.binding?.pid ?? null;
    const notice = deps.failures?.count >= FAILURE_NOTICE_AT ? failureNotice(deps.failures) : '';
    return contextOutput([ctx.text, notice].filter(Boolean).join('\n'));
  } finally {
    // 輸出寫完之後才補記 MEMORY.md、處理常駐程式（E16）：deps.defer 由 main() 提供；直接呼叫 runHook 時（測試）立即執行
    const later = async () => {
      await recordMemoryIndex(input, memoryIndex, pid, deps).catch((err) => deps.log.debug('session-start', err));
      await kickAgent(deps, 'session-start');
    };
    if (deps.defer) deps.defer(later); else await later();
  }
}

/** 常駐程式沒在跑（心跳過期）就在背景啟動；在跑而且太久沒同步就請它同步。都不等結果。 */
export async function kickAgent(deps, reason) {
  const hb = deps.readHeartbeat();
  const now = deps.now();
  if (!isFresh(hb, now)) {
    deps.spawnNode([BIN_PATH, 'agent']);
    deps.log.info(reason, '常駐程式沒有在執行，已在背景啟動');
    return 'spawned';
  }
  const lastSync = Date.parse(hb.lastSyncAt ?? '');
  if (!(now - lastSync < SYNC_STALE_MS)) {
    await deps.requestAgent(hb, 'POST', '/api/sync', { reason }, AGENT_TIMEOUT_MS);
    return 'sync';
  }
  return 'none';
}

/**
 * Stop：標記「有變更」，由常駐程式稍後做本機 commit。每一輪對話都會觸發，所以不載入引擎、不 spawn git（E17）：
 * 旗標以對話紀錄所在的編碼資料夾命名；常駐程式本機 commit 時一次處理整個 vault，不需要知道專案 ID。
 */
export async function stop(input, deps) {
  const key = input.transcript_path ? path.basename(path.dirname(input.transcript_path)) : input.session_id;
  if (!key) return null;
  await writeJsonAtomic(path.join(deps.paths.dirty, safeName(key)), {
    cwd: input.cwd ?? null,
    sessionId: input.session_id ?? null,
    at: iso(deps),
  });
  return null;
}

/**
 * SessionEnd：通知常駐程式同步；常駐程式不在時改 spawn 一個脫離的 `engram sync --local --debounce 30s`。
 * 這個事件可能根本不觸發（直接關掉終端機），所以它只是加速，不是唯一保障。
 */
export async function sessionEnd(input, deps) {
  const hb = deps.readHeartbeat();
  if (isFresh(hb, deps.now())) {
    const res = await deps.requestAgent(hb, 'POST', '/api/sync', { reason: 'session-end', sessionId: input.session_id ?? null }, AGENT_TIMEOUT_MS);
    if (res && res.status < 300) return null;
  }
  deps.spawnNode([BIN_PATH, 'sync', '--local', '--debounce', '30s', '--quiet']);
  return null;
}

/**
 * PostCompact：Claude Code 2.1.306 的 hookSpecificOutput 不包含 PostCompact，輸出 additionalContext 會被判為格式錯誤；
 * 壓縮後的重新注入改由 SessionStart（matcher 含 compact，壓縮後會再觸發一次）負責，這裡刻意不輸出。
 */
export async function postCompact() {
  return null;
}
