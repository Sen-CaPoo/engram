// 記憶庫打包（S3）。Engram 把 gc.auto 設成 0：git 的自動打包會附在 fetch、commit 這些指令後面執行，
// 而它們的逾時只有 30 秒，打包被殺掉後留下過期的 .git/gc.pid 與一堆零散物件，之後永遠打包不完。
// 改由常駐程式每週一次（零散物件太多時提早）在背景執行 git gc，逾時 10 分鐘。
import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.mjs';
import { pruneHealBackups } from './healbackup.mjs';
import { processAlive } from './lock.mjs';

export const GC_TIMEOUT_MS = 10 * 60_000;
export const GC_PID_STALE_MS = 12 * 3600_000;
/** 零散物件超過這個數量，不等一週、下一次閒置就打包 */
export const LOOSE_LIMIT = 2000;

const gcPidPath = (vaultDir) => path.join(vaultDir, '.git', 'gc.pid');

/** gc.pid 的內容是「程序 ID 主機名稱」 */
function pidOf(file) {
  try { return Number.parseInt(fs.readFileSync(file, 'utf8'), 10); } catch { return NaN; }
}

/** .git/gc.pid 是否已經過期：檔案超過 staleMs 沒更新，而且裡面的程序已不存在 */
export function isStaleGcPid(vaultDir, { now = Date.now(), staleMs = GC_PID_STALE_MS } = {}) {
  const file = gcPidPath(vaultDir);
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  if (now - st.mtimeMs < staleMs) return false;
  const pid = pidOf(file);
  return !(Number.isFinite(pid) && processAlive(pid));
}

/** 清掉過期的 gc.pid；回傳是否刪除 */
export function clearStaleGcPid(vaultDir, opts) {
  if (!isStaleGcPid(vaultDir, opts)) return false;
  try { fs.rmSync(gcPidPath(vaultDir), { force: true }); return true; } catch { return false; }
}

/** 零散物件與打包檔數量（git count-objects -v） */
export async function countObjects(vaultDir) {
  const r = await git(['count-objects', '-v'], { cwd: vaultDir, allowFail: true });
  const num = (key) => Number(new RegExp(`^${key}: (\\d+)`, 'm').exec(r.stdout)?.[1] ?? 0);
  return { loose: num('count'), packs: num('packs') };
}

/** 既有的記憶庫在常駐程式啟動時補設 gc.auto=0；回傳是否有改 */
export async function ensureGcConfig(vaultDir) {
  const cur = await git(['config', '--local', '--get', 'gc.auto'], { cwd: vaultDir, allowFail: true });
  if (cur.code === 0 && cur.stdout.trim() === '0') return false;
  await git(['config', '--local', 'gc.auto', '0'], { cwd: vaultDir });
  return true;
}

// 2.0.0 WP4a：本機紀錄的清理（順便在每週打包時做）。統計最多只看近 90 天（讀取統計、召回頁、護欄、每週摘要），
// 所以每日紀錄檔保留 90 天（再多留一天：檔名的日期有的是 UTC、有的是本地時間）；每場對話一個的 .mod 標記檔保留 7 天
export const LOG_RETAIN_DAYS = 90;
export const MARKER_RETAIN_DAYS = 7;
const LOG_KINDS = ['recall', 'search', 'guardrails'];
const LOG_FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:\.[A-Za-z0-9_-]{1,40})?\.jsonl$/;
const DAY_MS = 86_400_000;

/**
 * 刪掉 local/usage/{recall,search,guardrails}/ 超過 90 天的每日紀錄檔，與 local/cache/session/ 超過 7 天的 .mod 標記檔
 * （開場快取 state.json 與其他檔案不動）。任何一個檔刪不掉就略過。
 * @returns {{ logs: number, markers: number }}
 */
export function pruneLocalLogs(localDir, { now = Date.now() } = {}) {
  const out = { logs: 0, markers: 0 };
  const cutDay = new Date(now - (LOG_RETAIN_DAYS + 1) * DAY_MS).toISOString().slice(0, 10);
  for (const kind of LOG_KINDS) {
    const dir = path.join(localDir, 'usage', kind);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const day = LOG_FILE_RE.exec(n)?.[1];
      if (!day || day >= cutDay) continue;
      try { fs.rmSync(path.join(dir, n)); out.logs++; } catch { /* 被占用就下次再刪 */ }
    }
  }
  const sessionDir = path.join(localDir, 'cache', 'session');
  let markers = [];
  try { markers = fs.readdirSync(sessionDir).filter((n) => n.endsWith('.mod')); } catch { /* 沒有標記檔 */ }
  for (const n of markers) {
    const file = path.join(sessionDir, n);
    try {
      if (now - fs.statSync(file).mtimeMs <= MARKER_RETAIN_DAYS * DAY_MS) continue;
      fs.rmSync(file);
      out.markers++;
    } catch { /* 被占用就下次再刪 */ }
  }
  return out;
}

/** over：零散物件超過 LOOSE_LIMIT，常駐程式會在下一次閒置時提早打包 */
export async function gcStatus(ctx, { now = Date.now() } = {}) {
  const counts = await countObjects(ctx.vault);
  return { ...counts, stalePid: isStaleGcPid(ctx.vault, { now }), over: counts.loose > LOOSE_LIMIT };
}

/**
 * 執行 git gc：先清過期的 gc.pid，逾時 10 分鐘。刻意不持有引擎的寫入鎖：打包可能很久，
 * 持鎖會讓同步與介面寫入全部失敗；git 本身允許打包與 commit 並行。
 * 被中止或逾時（程序樹被我們殺掉）時，gc.pid 會留下，這裡立刻清掉，免得下一次打包被它擋住。
 * @param {{ signal?: AbortSignal, now?: number }} [opts]
 * @returns {Promise<{ ok: true, ms: number, clearedPid: boolean, prunedBackups: number, before: { loose: number, packs: number }, after: { loose: number, packs: number } }>}
 */
export async function runGc(ctx, { signal, now = Date.now() } = {}) {
  const t0 = Date.now();
  const before = await countObjects(ctx.vault);
  const clearedPid = clearStaleGcPid(ctx.vault, { now });
  // 順便清掉超過 30 天的自我修復備份（local/backup；只刪自我修復自己建立的資料夾）。清不掉不影響打包
  const prunedBackups = await pruneHealBackups(ctx, { now }).catch(() => 0);
  // 2.0.0 WP4a：順便清掉超過 90 天的本機紀錄檔與超過 7 天的開場標記檔
  let pruned = { logs: 0, markers: 0 };
  try { pruned = pruneLocalLogs(ctx.local, { now }); } catch { /* 清不掉不影響打包 */ }
  try {
    await git(['gc', '--quiet'], { cwd: ctx.vault, timeoutMs: GC_TIMEOUT_MS, signal });
  } catch (err) {
    clearStaleGcPid(ctx.vault, { staleMs: 0 }); // 剛被殺掉的 gc：程序已不存在，不必等 12 小時
    throw err;
  }
  return { ok: true, ms: Date.now() - t0, clearedPid, prunedBackups, prunedLogs: pruned.logs, prunedMarkers: pruned.markers, before, after: await countObjects(ctx.vault) };
}
