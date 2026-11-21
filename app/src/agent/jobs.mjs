// 常駐程式的程序內排程器（ADR §07）：sync、watch、health、probe、bind、curate。
// 一個 60 秒計時器負責：到期的工作、偵測牆上時鐘跳躍（從睡眠恢復就立即同步）、每小時檢查 Claude Code 版本。
// 每個工作記錄 nextRunAt、lastRunAt、lastResult；啟用狀態與上次執行時間存在 local/agent-jobs.json。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CliError, toErrorInfoI18n } from '../cli/errors.mjs';
import { localTime, readJsonSync, writeJsonAtomic } from '../cli/fsutil.mjs';
import { CONTRACTS } from '../cli/probe/contracts.mjs';
import { pausedFrom, userPermissionMode } from '../cli/probe/index.mjs';
import { isLocked, summarizeSync, summarizeSyncEn, syncFailure } from '../cli/syncresult.mjs';
import { createPendingBinder, pendingBindings } from './pending.mjs';
import { runAutopilot as realRunAutopilot, summarize } from '../autopilot/run.mjs';
import { setEnabledState } from '../autopilot/state.mjs';
import { dreamTargets } from '../autopilot/tasks/dream.mjs';

export const TICK_MS = 60_000;
export const SYNC_EVERY_MS = 10 * 60_000;
export const QUIET_MS = 30_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HEALTH_AT = { hour: 9, minute: 30 };
const LOCK_RETRY_MS = 60_000;
const SYNC_ALERT_MS = DAY;
const SYNC_ERROR_ALERT_MS = HOUR;
const WARMUP_RETRY_MS = [30_000, 60_000, 120_000]; // 剛啟動或喚醒後第一次同步連不上時的重試間隔
const LOCK_WAIT_MS = 60_000; // 啟動時的工作遇到 E_LOCKED：最多等這麼久
const LOCK_POLL_MS = 2_000;
const DIAGNOSIS_REASONS = { secret: '疑似含有金鑰，被扣住', recent: '剛被修改', 'held-deletion': '被扣住的大量刪除', unmerged: '未解決的合併', uncommitted: '沒有被提交' };
const AUTOPILOT_EVERY_MS = 20 * HOUR;
const AUTOPILOT_IDLE_MS = 20 * 60_000;
const AUTOPILOT_RETRY_MS = 30 * 60_000;
// 2.0.0：Claude 暫時忙碌（過載、速率限制）而提前停止的一輪，連續這麼多次之後不再每 30 分鐘重試，等下一個每日排程
const AUTOPILOT_BUSY_MAX = 6;
const AUTOPILOT_FORCE_MS = 2 * DAY;
// 2.0.0：環境健檢的每日排程時間；對話紀錄剩幾天就會被清除時，自動駕駛不等電腦閒置
const ENV_AT = { hour: 10, minute: 0 };
const AUTOPILOT_EXPIRING_DAYS = 3;
const GC_EVERY_MS = 7 * DAY;
const GC_BUSY_RECHECK_MS = 5 * 60_000;
const GC_FORCE_MS = 2 * DAY; // 每週的打包到期後最多等兩天的空檔，之後不管電腦是否閒置照做（仍然不會和同步、存檔重疊）
const ENV_SYNC_RETRY_MS = 30 * 60_000; // 2.0.0 WP8：環境設定同步（auto）遇到對話進行中時的重試間隔
// 2.0.0 R2：自動更新每天一次；有對話進行中或自動駕駛正在跑時 30 分鐘後再看，連不上遠端 2 小時後再試
const UPDATE_AT = { hour: 11, minute: 0 };
const UPDATE_BUSY_RETRY_MS = 30 * 60_000;
const UPDATE_OFFLINE_RETRY_MS = 2 * HOUR;

export const JOB_DEFS = Object.freeze({
  sync: { label: '網路同步', schedule: '每 10 分鐘；啟動、睡眠恢復、對話結束時', enabled: true, en: { label: 'Network sync', schedule: 'Every 10 minutes; also at startup, after waking from sleep, and when a conversation ends' } },
  watch: { label: '本機存檔', schedule: 'vault 有變更且安靜 30 秒後', enabled: true, en: { label: 'Local save', schedule: 'After the vault changes and stays quiet for 30 seconds' } },
  health: { label: '健康檢查', schedule: '每天 09:30；錯過時於啟動後補跑', enabled: true, en: { label: 'Health check', schedule: 'Every day at 09:30; runs after startup if it was missed' } },
  probe: { label: '相容性探測', schedule: 'Claude Code 改版時；會用你的 Claude 額度跑 6 次 Haiku 小測試（約 3 萬 token／次）', enabled: true, en: { label: 'Compatibility probe', schedule: 'When Claude Code is updated; runs 6 small Haiku tests on your Claude quota (about 30k tokens each)' } },
  bind: { label: '背景綁定', schedule: '待切換的專案在對話結束 30 分鐘後；權限模式或探測結果改變時重新對齊', enabled: true, en: { label: 'Background binding', schedule: 'For projects waiting to switch, 30 minutes after the conversation ends; realigns when the permission mode or probe result changes' } },
  rename: { label: '撞名資料夾改名', schedule: '每小時；設定為自動時，依命名規則改名沒有對話在使用的撞名資料夾', enabled: true, en: { label: 'Colliding folder rename', schedule: 'Every hour; when set to automatic, renames colliding folders that no conversation is using, by the naming rule' } },
  // S3：git 的自動打包（gc.auto）關掉了，改由這個工作每週打包一次；零散物件太多時提早，在電腦閒置時做
  gc: { label: '記憶庫打包', schedule: '每週一次（逾時 10 分鐘）；零散物件超過 2,000 個時，不等一週、下一次電腦閒置就做', enabled: true, en: { label: 'Vault packing', schedule: 'Once a week (10-minute limit); sooner, at the next idle moment, when there are more than 2,000 loose objects' } },
  // 1.5.0：原本預留的「每週整理」改成自動駕駛；啟用與否跟著設定的 autopilot（在設定或自動駕駛頁開關）
  curate: { label: '自動駕駛', schedule: '開啟後每天一次，在電腦閒置 20 分鐘以上時執行（超過 2 天沒執行就直接執行；有對話紀錄剩不到 3 天就會被清除而且還沒回顧時，不等閒置）', enabled: false, en: { label: 'Autopilot', schedule: 'Once a day when turned on, while the computer has been idle for 20+ minutes (runs anyway if it has not run for 2 days, or does not wait for idle when a conversation that has not been reviewed will be deleted in under 3 days)' } },
  // 2.0.0：環境健檢（R1、R5）。受設定 envHealth 控制
  env: { label: '環境健檢', schedule: '每天 10:00；錯過時於啟動後補跑（掃描設定、外掛、技能與近 30 天的對話紀錄，只取名稱、版本、雜湊與耗時）', enabled: true, en: { label: 'Environment check', schedule: 'Every day at 10:00; runs after startup if it was missed (scans settings, plugins, skills and the last 30 days of conversations; only names, versions, hashes and timings are read)' } },
  // 2.0.0：自動更新（R2）。受設定 autoUpdate 控制
  update: { label: '自動更新', schedule: '每天 11:00；錯過時於啟動後補跑（另一台電腦用 engram update 發佈新版後才會更新；有對話進行中或自動駕駛執行中時延後，更新失敗會退回並通知）', enabled: true, en: { label: 'Automatic update', schedule: 'Every day at 11:00; runs after startup if it was missed (updates only after another computer publishes a new version with engram update; waits while a conversation or autopilot is running, and rolls back and notifies if the update fails)' } },
});

export const JUMP_THRESHOLD_MS = 90_000;

/** 兩次計時器觸發的間隔比預期多 90 秒以上（或時間倒退）→ 牆上時鐘跳躍，多半是剛從睡眠恢復（21 號文件）。 */
export function detectClockJump(prevAt, nowAt, intervalMs = TICK_MS) {
  const gap = nowAt - prevAt;
  return gap - intervalMs > JUMP_THRESHOLD_MS || gap < -5_000;
}

/** 不晚於 now 的最近一次每日排程時間點（本地時間） */
export function lastDailySlot(now, { hour, minute } = HEALTH_AT) {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}

export function nextDailySlot(now, hm = HEALTH_AT) {
  const d = new Date(lastDailySlot(now, hm));
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

const iso = (t) => new Date(t).toISOString();

/**
 * 檔案或資料夾的簽章（修改時間＋大小）；不存在回傳 null。
 * Windows 的 fs.watch 連「最後存取時間」變動也會回報 change，只靠事件分不出是讀取還是寫入，所以事件來了再比對簽章。
 */
function fileSignature(abs) {
  try {
    const st = fs.statSync(abs);
    const mtime = Math.round(st.mtimeMs); // 以毫秒比對：NTFS 的時間到 100 奈秒，但 JS 的時間運算只到毫秒，更細的位數分不出來也不必分
    return st.isDirectory() ? `d:${mtime}` : `f:${mtime}:${st.size}`;
  } catch {
    return null;
  }
}

/** 1.0.0 存下的探測結果沒有英文：依契約 id 補上英文名稱（detail 是當時的原始輸出，原樣保留）。 */
function withProbeEn(probe) {
  if (!probe?.checks) return probe;
  return {
    ...probe,
    checks: probe.checks.map((c) => {
      if (c.en) return c;
      const label = CONTRACTS.find((k) => k.id === c.id)?.en?.label;
      return label ? { ...c, en: { label } } : c;
    }),
  };
}

function loadState(file) {
  const saved = readJsonSync(file, {}) ?? {};
  const jobs = {};
  for (const [id, def] of Object.entries(JOB_DEFS)) {
    const s = saved.jobs?.[id] ?? {};
    jobs[id] = { enabled: s.enabled ?? def.enabled, lastRunAt: s.lastRunAt ?? null, lastResult: s.lastResult ?? null };
  }
  return {
    jobs,
    probe: saved.probe ?? null,
    claudeVersion: saved.claudeVersion ?? null,
    versionCheckedAt: saved.versionCheckedAt ?? null,
    syncFailingSince: saved.syncFailingSince ?? null,
    syncErrorSince: saved.syncErrorSince ?? null,
    binding: saved.binding ?? null,
    // 自動駕駛因為 Claude 暫時忙碌而提前停止的連續次數（2.0.0）
    autopilotBusy: Number.isInteger(saved.autopilotBusy) && saved.autopilotBusy > 0 ? saved.autopilotBusy : 0,
  };
}

/** 自動更新（2.0.0 R2）：用到時才載入 install/ 的程式，不拖慢常駐程式啟動 */
const realAutoUpdate = async (o) => (await import('../../install/autoupdate.mjs')).runAutoUpdate(o);

/**
 * @param {{ eg, paths, events, log, notifier: { notify: Function }, runProbe, detectVersion, settings?, now?: () => number }} deps
 *   settings：agent/settings.mjs；沒有時用預設值（測試）
 *   autoUpdate：自動更新的實作（install/autoupdate.mjs 的 runAutoUpdate）；restartAgent：更新成功後換成新版的常駐程式（測試用假的）
 */
export function createJobs({ eg, paths, events, log, notifier, runProbe, detectVersion, settings, now = Date.now, runAutopilot = realRunAutopilot, isIdle = () => claudeIdle(eg?.paths?.claudeHome, now()), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), autoUpdate = realAutoUpdate, restartAgent = () => {} }) {
  const syncEvery = () => settings?.syncEveryMs() ?? SYNC_EVERY_MS;
  const healthAt = () => settings?.healthAt() ?? HEALTH_AT;
  const userPaused = () => settings?.paused() ?? false;
  const state = loadState(paths.jobsFile);
  const vaultDir = eg?.paths?.vault ?? paths.vault;
  const binder = createPendingBinder({ eg, log });
  const running = new Map();
  const again = new Set();
  let saving = Promise.resolve();
  let tickTimer = null;
  let lastTickAt = null;
  let watcher = null;
  let watchTimer = null;
  let watchDueAt = null;
  let syncRetryAt = null;
  let warmup = null; // 剛啟動或剛喚醒：{ step } 第一次連上之前，連不上就依序重試（不計入失敗）
  let warmupTimer = null;
  let stopping = false;
  let autopilotRetryAt = null;
  let autopilotAbort = null;
  let gcAbort = null;
  let gcCheckAt = 0; // 下一次檢查打包條件（零散物件數量、電腦是否閒置）的時間
  let gcDeferredSince = null; // 每週的打包到期後一直等不到空檔，從什麼時候開始等
  let updateRetryAt = null; // 自動更新被延後（有對話進行中、連不上遠端）時，下一次再看的時間
  let restartPending = false; // 自動更新成功、常駐程式即將重啟：這段空檔也不開始新的自動駕駛
  let changeTimer = null;
  const changed = new Set();
  const signatures = new Map(); // vault 相對路徑 → 最近一次看到的簽章（見 fileSignature）
  let baselined = false;

  const enabled = (id) => state.jobs[id].enabled;
  const paused = () => pausedFrom(state.probe);
  // R-52：綁定方式取決於使用者的預設權限模式與 junction 是否暫停；任一改變就要重新對齊（eg.identity.reconcile）
  // 暫停狀態也算在內：恢復時要立即補做對齊
  const bindingMode = () => [
    userPermissionMode(eg?.paths?.claudeHome ?? '') ?? 'default',
    paused().includes('junction') ? 'no-junction' : 'junction',
    userPaused() || paused().includes('bind') ? 'off' : 'on',
  ].join('|');
  const save = () => {
    const snapshot = JSON.parse(JSON.stringify(state));
    saving = saving.then(() => writeJsonAtomic(paths.jobsFile, snapshot)).catch((err) => log.warn('jobs', err));
    return saving;
  };
  const syncOptions = (network) => (paused().includes('normalize') ? { network, normalize: false } : { network });

  function nextRunAt(id) {
    const st = state.jobs[id];
    if (!st.enabled) return null;
    const last = Date.parse(st.lastRunAt ?? '');
    const t = now();
    switch (id) {
      case 'sync':
        return iso(syncRetryAt ?? (Number.isFinite(last) ? last + syncEvery() : t));
      case 'watch':
        return watchDueAt ? iso(watchDueAt) : null;
      case 'health':
        return iso(Number.isFinite(last) && last >= lastDailySlot(t, healthAt()) ? nextDailySlot(t, healthAt()) : t);
      case 'probe':
        // 只在目前的 Claude Code 版本還沒有探測結果時執行（第一次偵測到版本、或改版）；版本沒變，行為就不會變（R-49）。
        // 失敗時至少隔一小時才重試，避免每分鐘呼叫 claude
        if (!state.claudeVersion || state.probe?.claudeVersion === state.claudeVersion) return null;
        return iso(Number.isFinite(last) && t - last < HOUR ? last + HOUR : t);
      case 'curate':
        return iso(autopilotRetryAt ?? (Number.isFinite(last) ? last + AUTOPILOT_EVERY_MS : t));
      case 'rename':
        return iso(Number.isFinite(last) ? last + HOUR : t);
      case 'env':
        return iso(Number.isFinite(last) && last >= lastDailySlot(t, ENV_AT) ? nextDailySlot(t, ENV_AT) : t);
      case 'gc':
        return iso(Number.isFinite(last) ? last + GC_EVERY_MS : t);
      case 'update':
        return iso(updateRetryAt ?? (Number.isFinite(last) && last >= lastDailySlot(t, UPDATE_AT) ? nextDailySlot(t, UPDATE_AT) : t));
      default:
        return null; // bind：有待切換的綁定時由計時器處理
    }
  }

  const isDue = (id, t) => {
    const n = nextRunAt(id);
    return n !== null && Date.parse(n) <= t;
  };

  function info(id) {
    const st = state.jobs[id];
    const def = JOB_DEFS[id];
    return { id, label: def.label, schedule: def.schedule, en: def.en, enabled: st.enabled, nextRunAt: nextRunAt(id), lastRunAt: st.lastRunAt, lastResult: st.lastResult, running: running.has(id) };
  }

  const emitJob = (id) => events.emit('job', info(id));
  const emitStatus = () => Promise.resolve().then(() => eg.status()).then((s) => events.emit('status', s)).catch(() => {});

  // ───────── 各工作的內容 ─────────

  /**
   * 同步失敗的通知（Windows 通知，通知器負責 24 小時去重）：離線（網路暫時不通）連續失敗超過 24 小時才通知；
   * 非離線的錯誤（衝突、認證、本機 git 逾時…）不會自己好，連續失敗滿 1 小時就通知（S2）。
   */
  function onSyncFailed(error, offline) {
    const t = now();
    state.syncFailingSince ??= iso(t);
    if (offline) {
      state.syncErrorSince = null;
      if (t - Date.parse(state.syncFailingSince) >= SYNC_ALERT_MS) {
        notifier.notify({ key: 'sync-failed', title: 'Engram 憶跡', body: `已超過 24 小時沒有成功同步，請開啟管理介面查看原因：${error.message}`, page: 'devices' });
      }
      return;
    }
    state.syncErrorSince ??= iso(t);
    if (t - Date.parse(state.syncErrorSince) >= SYNC_ERROR_ALERT_MS) {
      notifier.notify({ key: 'sync-error', title: 'Engram 憶跡', body: `同步已連續失敗超過 1 小時，不是網路問題，請開啟管理介面查看原因：${error.message}`, page: 'devices' });
    }
  }

  /** 診斷結果寫進日誌：失敗時 warn、自動修復成功時 info；內容沒變就不重複寫（每 10 分鐘同步一次，不要一直重複） */
  let lastDiagnosisLogged = '';
  function logDiagnosis(res) {
    const d = res?.diagnosis;
    if (!d) return;
    const key = JSON.stringify([d.blockers, d.uncommitted, d.healed, d.healFailed ?? null]);
    if (key === lastDiagnosisLogged) return;
    lastDiagnosisLogged = key;
    const why = (x) => `${x.ref}（${DIAGNOSIS_REASONS[x.reason] ?? x.reason}）`;
    if (d.healed?.length) {
      // 對方也改過同一個檔案時，對方的版本在衝突紀錄（收件匣可選本機、對方或合併）；衝突紀錄建不起來就另存在 local/backup
      const theirs = (h) => (h.theirs?.kind === 'conflict' ? `；對方的版本已存成衝突紀錄 ${h.theirs.id}，請到收件匣處理`
        : h.theirs?.kind === 'backup' ? `；對方的版本另存在 local/${h.theirs.path}（衝突紀錄建不起來：${h.theirs.error}）`
          : h.theirs?.kind === 'none' ? `；對方的版本沒能保存：${h.theirs.error}` : '');
      log.info('sync', `同步自我修復：擋住合併的被扣住檔案已暫時移開、合併完成後放回原位，本機版本一字不差；備份：${d.healed.map((h) => `${h.ref} → ${h.backup}${theirs(h)}`).join('、')}`);
      return;
    }
    const parts = [`擋住合併的檔案：${d.blockers?.length ? d.blockers.map(why).join('、') : '沒有（不是檔案擋住）'}`];
    if (d.uncommitted?.length) parts.push(`這一輪沒被提交的檔案：${d.uncommitted.map(why).join('、')}`);
    if (d.healFailed) parts.push(`自動修復失敗：${d.healFailed}`);
    log.warn('sync', `同步連續失敗的診斷：${parts.join('；')}`);
  }

  /**
   * 引擎的寫入鎖被占用（E_LOCKED）時等鎖再做，最多 60 秒（S2）。啟動時網路同步正在進行（可能超過 15 秒），
   * 同時排隊的使用統計、綁定檢查等工作不該因此直接記成失敗。其他錯誤原樣丟出；常駐程式停止中就不再等。
   */
  async function retryLocked(fn) {
    for (let waited = 0; ; waited += LOCK_POLL_MS) {
      try {
        return await fn();
      } catch (err) {
        if (err?.code !== 'E_LOCKED' || waited >= LOCK_WAIT_MS || stopping) throw err;
        await sleep(LOCK_POLL_MS);
      }
    }
  }

  /** 失敗的備註；錯誤沒有英文訊息時不附 en，介面會退回中文 */
  const failNote = (f) => ({ note: `${f.code}：${f.message}`, ...(f.en?.message ? { en: { note: `${f.code}: ${f.en.message}` } } : {}) });

  /** R5（2.0.0）：這台電腦綁定的專案有還沒回顧的對話，最早的剩 3 天以內就會被 Claude Code 清除：不等電腦閒置，下一個時間點就執行 */
  async function dreamExpiring() {
    const targets = await dreamTargets({ eg }).catch(() => []);
    return targets.some((t) => t.expires <= AUTOPILOT_EXPIRING_DAYS);
  }

  const RUNNERS = {
    async sync(reason) {
      if (userPaused()) return { ok: true, note: '已暫停（設定）', en: { note: 'Paused (setting)' } };
      events.emit('sync', { state: 'start', reason, at: iso(now()) });
      let res;
      try {
        res = await eg.sync(syncOptions(true));
      } catch (err) {
        res = { ok: false, state: 'error', error: toErrorInfoI18n(err) };
      }
      const failure = syncFailure(res);
      const offline = res?.state === 'offline'; // E_OFFLINE 與 E_PROXY
      // 剛啟動或剛喚醒，網路常常還沒準備好：連不上時 30、60、120 秒各重試一次；這幾次都不算失敗、不寫 warn（S2）
      const warming = !!failure && offline && warmup !== null;
      events.emit('sync', { state: 'end', ok: !failure || warming, reason, at: iso(now()), result: res ?? null, ...(failure && !warming ? { error: failure } : {}) });
      if (isLocked(res)) {
        syncRetryAt = now() + LOCK_RETRY_MS;
        return { ok: true, note: '另一個同步正在進行，1 分鐘後重試', en: { note: 'Another sync is in progress, retrying in 1 minute' } };
      }
      emitStatus();
      if (warming) {
        const delay = WARMUP_RETRY_MS[warmup.step++];
        if (delay === undefined) {
          warmup = null;
          return { ok: true, quiet: true, note: '剛啟動或喚醒時網路一直沒有連上，等下一次排程再同步', en: { note: 'The network did not come up after startup or wake-up; waiting for the next scheduled sync' } };
        }
        clearTimeout(warmupTimer);
        warmupTimer = setTimeout(() => { warmupTimer = null; if (!stopping) runJob('sync', 'warmup-retry'); }, delay);
        warmupTimer.unref?.();
        return { ok: true, quiet: true, note: `剛啟動或喚醒，連不上遠端，${delay / 1000} 秒後重試（不計入失敗）`, en: { note: `The remote is unreachable just after startup or wake-up; retrying in ${delay / 1000} seconds (not counted as a failure)` } };
      }
      warmup = null;
      clearTimeout(warmupTimer);
      logDiagnosis(res);
      if (res?.healRecovered?.preserved?.length) {
        log.warn('sync', `上一輪自我修復放回被扣住的檔案時，原位的檔案在這段期間被改過：目前的內容已先另存到 local/，本機版本才放回原位：${res.healRecovered.preserved.map((p) => `${p.ref} → ${p.backup}`).join('、')}`);
      }
      if (failure) {
        onSyncFailed(failure, offline);
        return { ok: false, ...failNote(failure) };
      }
      state.syncFailingSince = null;
      state.syncErrorSince = null;
      return { ok: true, note: summarizeSync(res).join(' '), en: { note: summarizeSyncEn(res).join(' ') } };
    },

    async watch() {
      if (userPaused()) return { ok: true, note: '已暫停（設定）', en: { note: 'Paused (setting)' } };
      const startedAt = now();
      const res = await eg.sync(syncOptions(false));
      if (isLocked(res)) {
        scheduleWatch(QUIET_MS);
        return { ok: true, note: '另一個同步正在進行，30 秒後重試', en: { note: 'Another sync is in progress, retrying in 30 seconds' } };
      }
      const failure = syncFailure(res);
      if (failure) return { ok: false, ...failNote(failure) };
      await clearDirtyFlags(startedAt);
      // 沒有東西可 commit、也沒有需要注意的事（衝突、被扣住的檔案）時，只寫 debug（S1）
      const quiet = !res?.committed && !res?.conflicts?.length && !res?.held?.length && !res?.skipped?.secrets?.length;
      return { ok: true, quiet, note: summarizeSync(res, { network: false }).join(' '), en: { note: summarizeSyncEn(res, { network: false }).join(' ') } };
    },

    async health() {
      // 1.4.0：先更新讀取統計（從對話紀錄增量計算、每天同步一次摘要）與確認紀錄的起點，再做健康檢查。失敗不影響健康檢查
      if (typeof eg.usage?.refresh === 'function') await retryLocked(() => eg.usage.refresh()).catch((err) => log.warn('usage', err));
      if (typeof eg.review?.baseline === 'function') await retryLocked(() => eg.review.baseline()).catch((err) => log.warn('review', err));
      if (typeof eg.review?.prune === 'function') await retryLocked(() => eg.review.prune()).catch((err) => log.warn('review', err));
      if (typeof eg.dream?.ensureReadable === 'function') await retryLocked(() => eg.dream.ensureReadable()).catch((err) => log.warn('dream', err));
      // 放著沒完成的對話回顧：匯出的文字 14 天後清除
      if (typeof eg.dream?.cleanup === 'function') await retryLocked(() => eg.dream.cleanup()).catch((err) => log.warn('dream', err));
      const findings = (await retryLocked(() => eg.health())) ?? [];
      const high = findings.filter((f) => f.severity === 'high');
      events.emit('finding', { at: iso(now()), findings });
      if (high.length) {
        // 同一組高等級發現 24 小時內只通知一次；出現新的發現時 key 不同，會再通知
        const key = `health:${high.map((f) => f.id ?? f.code).sort().join(',')}`;
        notifier.notify({ key, title: 'Engram 憶跡', body: `有 ${high.length} 項需要你處理：${high[0].title ?? high[0].code}`, page: 'inbox' });
      }
      // 2.0.0 Q8：每週摘要（在讀取統計更新之後：「帶出之後被打開」要用新的統計）。自動駕駛關閉時照樣產生，只是不通知
      if (typeof eg.digest?.refresh === 'function') await eg.digest.refresh({ notifier }).catch((err) => log.warn('digest', err));
      return { ok: true, note: `${findings.length} 項發現，其中高 ${high.length} 項`, en: { note: `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}, ${high.length} High` } };
    },

    async probe() {
      const result = await runProbe();
      state.probe = result;
      if (result.claudeVersion) state.claudeVersion = result.claudeVersion;
      events.emit('probe', result);
      const failed = result.checks.filter((c) => !c.ok).map((c) => c.id);
      await settings?.writePaused(paused()).catch((err) => log.warn('probe', err));
      if (failed.length) {
        log.warn('probe', `契約未通過：${failed.join('、')}；暫停：${paused().join('、') || '無'}`);
        notifier.notify({ key: `probe:${failed.join(',')}`, title: 'Engram 憶跡', body: `Claude Code ${result.claudeVersion ?? ''} 的相容性探測有 ${failed.length} 項未通過，部分自動化已暫停。`, page: 'schedule' });
      }
      return {
        ok: result.ok,
        note: failed.length ? `未通過：${failed.join('、')}` : `${result.checks.length} 項全部通過`,
        en: { note: failed.length ? `Failed: ${failed.join(', ')}` : `All ${result.checks.length} passed` },
      };
    },

    async bind() {
      const mode = bindingMode();
      if (userPaused() || paused().includes('bind')) {
        state.binding = { mode, deferred: 0, at: iso(now()) };
        return { ok: true, note: userPaused() ? '已暫停（設定）' : '已暫停（相容性探測未通過）', en: { note: userPaused() ? 'Paused (setting)' : 'Paused (compatibility probe failed)' } };
      }
      // 先依目前的權限模式對齊既有綁定（補上或拆掉 junction；設定檔綁定一律保留），再處理待切換的綁定
      const rc = eg.identity.reconcile ? await retryLocked(() => eg.identity.reconcile()) : { changed: [], deferred: [] };
      state.binding = { mode, deferred: rc.deferred?.length ?? 0, at: iso(now()) };
      if (rc.changed?.length) {
        log.info('bind', `依權限模式重新對齊 ${rc.changed.length} 個綁定：${rc.changed.map((c) => `${c.path}（${c.from} → ${c.to}）`).join('、')}`);
        events.emit('change', { at: iso(now()), kind: 'bind', items: rc.changed.map(({ path: p, pid }) => ({ path: p, pid })) });
      }
      const r = await binder.run({ now: now() });
      if (r.done.length) events.emit('change', { at: iso(now()), kind: 'bind', items: r.done });
      const aligned = rc.changed?.length ? `重新對齊 ${rc.changed.length}、` : '';
      const waiting = r.waiting.length + (rc.deferred?.length ?? 0);
      const alignedEn = rc.changed?.length ? `Realigned ${rc.changed.length}, done` : 'Done';
      return { ok: r.failed.length === 0, note: `${aligned}完成 ${r.done.length}、等待 ${waiting}、失敗 ${r.failed.length}`, en: { note: `${alignedEn} ${r.done.length}, waiting ${waiting}, failed ${r.failed.length}` } };
    },

    /** 撞名資料夾依命名規則改名（SW-4）。只在設定為自動時；改名會重新綁定，所以背景綁定被暫停時也一併暫停 */
    async rename() {
      if (userPaused() || paused().includes('bind')) return { ok: true, note: userPaused() ? '已暫停（設定）' : '已暫停（相容性探測未通過）', en: { note: userPaused() ? 'Paused (setting)' : 'Paused (compatibility probe failed)' } };
      // silent：這一輪沒有事可做，每小時一次的結果完全不寫進日誌（工作狀態照常記錄，S1）
      if (!eg.collisions) return { ok: true, silent: true, note: '引擎不支援', en: { note: 'Not supported by the engine' } };
      const mode = (await eg.settings?.get?.())?.collisionRename ?? 'ask';
      if (mode !== 'auto') return { ok: true, silent: true, note: mode === 'ask' ? '設定為詢問：在收件匣一鍵改名' : '已關閉（設定）', en: { note: mode === 'ask' ? 'Set to ask: rename in one click from the inbox' : 'Turned off (setting)' } };
      const r = await eg.collisions.apply({});
      if (r.renamed.length) {
        const list = r.renamed.map((x) => `${path.basename(x.from)} → ${path.basename(x.to)}`).join('、');
        log.info('rename', `依命名規則改名 ${r.renamed.length} 個撞名的資料夾：${list}`);
        events.emit('change', { at: iso(now()), kind: 'rename', items: r.renamed });
        notifier.notify({ key: `rename:${r.id}`, title: 'Engram 憶跡', body: `已依命名規則改名 ${r.renamed.length} 個撞名的資料夾：${list}。可在「裝置與同步」的變更紀錄整批還原。`, page: 'devices' });
      }
      const reasons = [...new Set(r.skipped.map((s) => s.reason))];
      const waiting = r.skipped.length ? `、暫不改名 ${r.skipped.length}（${reasons.join('、')}）` : '';
      const waitingEn = r.skipped.length ? `, skipped ${r.skipped.length} (${reasons.join(', ')})` : '';
      return { ok: true, silent: r.renamed.length === 0, note: `改名 ${r.renamed.length}${waiting}`, en: { note: `Renamed ${r.renamed.length}${waitingEn}` } };
    },

    /**
     * 記憶庫打包（S3）：先清過期的 gc.pid 再 git gc（逾時 10 分鐘）。常駐程式停止時會中止它。
     * 做完（不論成功與否）一天內不再因為零散物件太多而提早重做，避免打包沒效果時每小時重試。
     */
    async gc() {
      if (typeof eg.gc?.run !== 'function') return { ok: true, quiet: true, note: '引擎不支援', en: { note: 'Not supported by the engine' } };
      gcAbort = new AbortController();
      gcDeferredSince = null;
      try {
        const r = await eg.gc.run({ signal: gcAbort.signal });
        const secs = Math.max(1, Math.round(r.ms / 1000));
        // 2.0.0 WP4a：順便清掉的本機紀錄檔（召回、搜尋、護欄，超過 90 天）與開場標記檔（超過 7 天）
        const pl = r.prunedLogs ?? 0;
        const pm = r.prunedMarkers ?? 0;
        const logsNote = pl || pm ? `已清除 ${pl} 個超過 90 天的紀錄檔、${pm} 個超過 7 天的開場標記檔；` : '';
        const logsNoteEn = pl || pm ? `Removed ${pl} log ${pl === 1 ? 'file' : 'files'} older than 90 days and ${pm} session ${pm === 1 ? 'marker' : 'markers'} older than 7 days. ` : '';
        return {
          ok: true,
          note: `${r.clearedPid ? '已清除過期的 gc.pid；' : ''}${r.prunedBackups ? `已清除 ${r.prunedBackups} 個超過 30 天的自我修復備份；` : ''}${logsNote}打包完成：零散物件 ${r.before.loose} → ${r.after.loose} 個（${secs} 秒）`,
          en: { note: `${r.clearedPid ? 'Removed a stale gc.pid. ' : ''}${r.prunedBackups ? `Removed ${r.prunedBackups} self-heal ${r.prunedBackups === 1 ? 'backup' : 'backups'} older than 30 days. ` : ''}${logsNoteEn}Packing complete: loose objects ${r.before.loose} → ${r.after.loose} (${secs} s)` },
        };
      } finally {
        gcAbort = null;
        gcCheckAt = now() + DAY;
      }
    },

    /** 自動駕駛（1.5.0）：AI 判斷並處理收件匣、整理、對話回顧。排程觸發時要電腦閒置，避免和使用者搶 Claude 的用量 */
    async curate(reason) {
      if (userPaused()) return { ok: true, note: '已暫停（設定）', en: { note: 'Paused (setting)' } };
      const on = (await eg.settings?.get?.())?.autopilot === 'on';
      if (!on) return { ok: true, note: '未開啟', en: { note: 'Turned off' } };
      // 自動更新進行中不開始新的一輪：更新成功後的重啟會中止它，已經花掉的 Claude 用量就白費了（自動更新開始前也會等自動駕駛跑完）
      if (running.has('update') || restartPending) return { ok: true, defer: true, quiet: true, note: '自動更新進行中，30 分鐘後再試', en: { note: 'An automatic update is in progress; trying again in 30 minutes' } };
      const last = Date.parse(state.jobs.curate.lastRunAt ?? '');
      if (reason === 'schedule' && Number.isFinite(last) && now() - last < AUTOPILOT_FORCE_MS && !(await isIdle()) && !(await dreamExpiring())) {
        return { ok: true, defer: true, note: '電腦使用中，30 分鐘後再試', en: { note: 'The computer is in use; trying again in 30 minutes' } };
      }
      autopilotAbort = new AbortController();
      try {
        const r = await runAutopilot(eg, { notifier, log, reason, signal: autopilotAbort.signal, onProgress: (run) => events.emit('autopilot', { id: run.id, status: run.status, summary: summarize(run) }) });
        if (r.skipped === 'busy') return { ok: true, note: '另一輪正在執行', en: { note: 'Another run is in progress' } };
        if (r.skipped === 'off') return { ok: true, note: '未開啟', en: { note: 'Turned off' } };
        // 2.0.0：這台或另一台撞到 Claude 的用量上限：延後到重置時間，不算執行過
        if (r.skipped === 'limit') return { ok: true, defer: true, retryAt: Date.parse(r.until), note: `Claude 的用量上限要到 ${localTime(r.until)} 才重置，之後再執行`, en: { note: `Claude's usage limit resets at ${localTime(r.until)}; it will run after that` } };
        const sm = r.run?.summary ?? { changes: 0, rejected: 0, costUsd: 0 };
        events.emit('autopilot', { id: r.run?.id, status: r.run?.status, summary: sm });
        emitStatus();
        // 2.0.0：Claude 暫時忙碌（過載、速率限制）而提前停止：照既有的重試間隔再試，不算執行過。
        // 連續 AUTOPILOT_BUSY_MAX 次之後記為執行過（上次執行時間前進），等下一個每日排程，不再每 30 分鐘重試
        if (sm.stopped === 'busy') {
          state.autopilotBusy = (state.autopilotBusy ?? 0) + 1;
          if (state.autopilotBusy >= AUTOPILOT_BUSY_MAX) {
            state.autopilotBusy = 0;
            return { ok: true, note: `處理 ${sm.changes} 項；Claude 連續 ${AUTOPILOT_BUSY_MAX} 次暫時忙碌（過載或速率限制），等下一次的每日排程再試`, en: { note: `${sm.changes} handled; Claude was temporarily busy (overloaded or rate limited) ${AUTOPILOT_BUSY_MAX} times in a row, so it will try again at the next daily run` } };
          }
          return { ok: true, defer: true, note: `處理 ${sm.changes} 項；Claude 暫時忙碌（過載或速率限制），30 分鐘後再試`, en: { note: `${sm.changes} handled; Claude is temporarily busy (overloaded or rate limited), trying again in 30 minutes` } };
        }
        state.autopilotBusy = 0;
        const stop = { limit: ['；已達 Claude 的用量上限', '; hit Claude\'s usage limit'], auth: ['；Claude Code 的登入已到期，請重新登入', '; the Claude Code login has expired, please sign in again'] }[sm.stopped] ?? ['', ''];
        return {
          ok: r.ok,
          note: r.ok ? `處理 ${sm.changes} 項、不執行 ${sm.rejected} 項（約當 US$${sm.costUsd}）${stop[0]}` : `失敗：${r.run?.error?.message ?? ''}`,
          en: { note: r.ok ? `${sm.changes} handled, ${sm.rejected} not carried out (about US$${sm.costUsd})${stop[1]}` : `Failed: ${r.run?.error?.message ?? ''}` },
        };
      } finally {
        autopilotAbort = null;
      }
    },
  };

  // 環境健檢（2.0.0 R1、R5）：掃設定、外掛、技能與對話紀錄，內容有變才把環境指紋寫進記憶庫，自動修該自動修的
  RUNNERS.env = async function env() {
    if (userPaused()) return { ok: true, note: '已暫停（設定）', en: { note: 'Paused (setting)' } };
    if (typeof eg.env?.run !== 'function') return { ok: true, note: '引擎不支援', en: { note: 'Not supported by the engine' } };
    const r = await eg.env.run({ claudeVersion: state.claudeVersion, isIdle });
    if (r.skipped === 'off') return { ok: true, note: '已關閉（設定）', en: { note: 'Turned off (setting)' } };
    const fixed = r.fixed?.length ? `、自動修正 ${r.fixed.join('、')}` : '';
    const blocked = r.blocked?.length ? '；環境指紋含疑似金鑰，沒有寫進記憶庫' : '';
    return {
      ok: !r.failed?.length,
      note: `${r.findings} 項發現${r.written ? '、環境指紋已更新' : ''}${fixed}${blocked}${r.failed?.length ? `；自動修正失敗：${r.failed.map((f) => `${f.code} ${f.message}`).join('、')}` : ''}`,
      en: { note: `${r.findings} ${r.findings === 1 ? 'finding' : 'findings'}${r.written ? ', environment fingerprint updated' : ''}${r.fixed?.length ? `, fixed ${r.fixed.join(', ')} automatically` : ''}${r.blocked?.length ? '; the fingerprint contained a possible secret, so it was not written to the vault' : ''}${r.failed?.length ? `; automatic fix failed: ${r.failed.map((f) => `${f.code} ${f.message}`).join(', ')}` : ''}` },
    };
  };

  // 2.0.0 WP4a：本機存檔與網路同步之後（記憶與同步狀態可能變了）重建情境召回的索引 local/cache/recall.json（記憶沒變就不重建），
  // 並更新開場 hook 快速路徑用的快取 local/cache/session/state.json（S5）。失敗只寫紀錄，不影響存檔與同步的結果
  async function refreshCaches(id) {
    // 網路同步之後（其他電腦的版本只會在這時候改變）：共用的索引分層開著、卻有舊版電腦回來時改回 observe，通知一次
    if (id === 'sync' && typeof eg.recall?.guardLayers === 'function') {
      try {
        const { reverted } = await eg.recall.guardLayers();
        if (reverted?.length) {
          const list = reverted.map((m) => `${m.label}（${m.version ?? '版本不明'}）`).join('、');
          const listEn = reverted.map((m) => `${m.label} (${m.version ?? 'unknown version'})`).join(', ');
          log.warn('recall', `有舊版的電腦最近還在用：${list}。索引分層已改回並行觀察（observe）；在那幾台更新之前，共用的索引暫時照舊版的方式產生（相容模式），兩台才不會互相改寫`);
          notifier.notify({
            key: `index-layers-reverted:${reverted.map((m) => m.mid).sort().join(',')}`,
            title: 'Engram 憶跡',
            body: `${list} 還是舊版的 Engram，讀不懂共用的索引分層設定。已把索引分層改回並行觀察；在那幾台更新之前，共用的索引會暫時照舊版的方式產生（相容模式），兩台才不會互相改寫。更新之後索引會自動切換，索引分層可以在設定頁再開啟。`,
            // 英文版（通知器目前只顯示中文；沒有語言選項，跟著資料帶著，和其他訊息的 en 寫法一致）
            en: {
              title: 'Engram',
              body: `${listEn} still run an older Engram that does not understand the shared index layers setting. Index layers were switched back to observe. Until those computers are updated, the shared indexes are written the old way (compatibility mode) so the computers do not rewrite each other's files. After the update the indexes switch back automatically, and index layers can be turned on again in Settings.`,
            },
            page: 'settings',
          });
        }
      } catch (err) {
        log.warn('recall', err);
      }
    }
    if (typeof eg.recall?.rebuild === 'function') await eg.recall.rebuild().catch((err) => log.warn('recall', err));
    if (typeof eg.sessionCache?.write === 'function') await eg.sessionCache.write().catch((err) => log.warn('session-cache', err));
  }
  for (const id of ['sync', 'watch']) {
    const run = RUNNERS[id];
    RUNNERS[id] = async (reason) => {
      const r = await run(reason);
      await refreshCaches(id);
      return r;
    };
  }

  // 環境設定同步（2.0.0 WP8）：併進每日的 env 工作。envHealth 為 off 時環境健檢不做，但這一步照自己的設定（envSync）走。
  // report（預設）：算出 plan 存成快取，不寫入 ~/.claude；auto：沒有對話進行中才套用，對話進行中就每 30 分鐘重試（不佔用 env 工作的排程）；off：不做。
  let envSyncRetryAt = null;
  let envSyncBusy = false;
  async function envSyncStep() {
    if (typeof eg.env?.syncRun !== 'function' || userPaused()) return null;
    let r;
    try { r = await eg.env.syncRun({ isIdle }); } catch (err) { return { ok: false, ...failNote(toErrorInfoI18n(err)) }; }
    envSyncRetryAt = r.deferred ? now() + ENV_SYNC_RETRY_MS : null;
    // 從記憶庫同步來、還沒在這台核可的項目（pending）不會被套用（auto 也一樣），在備註裡提醒
    const wait = r.pending ? `；${r.pending} 項等待這台核可（engram env approve）` : '';
    const waitEn = r.pending ? `; ${r.pending} ${r.pending === 1 ? 'item is' : 'items are'} waiting for approval on this computer (engram env approve)` : '';
    if (r.failed) return { ok: false, note: `環境設定同步失敗：${r.failed.code}：${r.failed.message}${wait}`, en: { note: `Environment sync failed: ${r.failed.code}: ${r.failed.message}${waitEn}` } };
    if (r.applied) return { ok: true, note: `環境設定已套用 ${r.result.applied} 項${wait}`, en: { note: `Applied ${r.result.applied} environment ${r.result.applied === 1 ? 'change' : 'changes'}${waitEn}` } };
    if (!r.changes) return r.pending ? { ok: true, note: wait.slice(1), en: { note: waitEn.slice(2) } } : null;
    if (r.deferred) return { ok: true, note: `環境設定有 ${r.changes} 項待套用（對話進行中，稍後再試）${wait}`, en: { note: `${r.changes} environment ${r.changes === 1 ? 'change is' : 'changes are'} waiting to be applied (a conversation is in progress; will retry later)${waitEn}` } };
    return { ok: true, note: `環境設定有 ${r.changes} 項可套用（只報告，不自動套用）${wait}`, en: { note: `${r.changes} environment ${r.changes === 1 ? 'change' : 'changes'} can be applied (report only; nothing is applied automatically)${waitEn}` } };
  }
  async function retryEnvSync() {
    envSyncBusy = true;
    try {
      const s = await envSyncStep();
      if (s?.note) log[s.ok === false ? 'warn' : 'info']('env', `環境設定同步（重試）：${s.note}`);
    } catch (err) { log.warn('env', err); } finally { envSyncBusy = false; }
  }
  const runEnvHealth = RUNNERS.env;
  RUNNERS.env = async function env() {
    const h = await runEnvHealth();
    const s = await envSyncStep();
    if (!s) return h;
    return { ...h, ok: h.ok !== false && s.ok !== false, note: [h.note, s.note].filter(Boolean).join('；'), en: { note: [h.en?.note, s.en?.note].filter(Boolean).join('; ') } };
  };

  // 自動更新（2.0.0 R2）：記憶庫的 release.json 有比本機新的版本、而且各項條件都符合時，走既有的更新流程；
  // 條件不符就不更新並留下原因（工作狀態與日誌），細節見 install/autoupdate.mjs
  RUNNERS.update = async function update() {
    updateRetryAt = null;
    if (userPaused()) return { ok: true, silent: true, note: '已暫停（設定）', en: { note: 'Paused (setting)' } };
    const setting = (await eg.settings?.get?.().catch(() => null))?.autoUpdate ?? 'on';
    // 有對話進行中或自動駕駛正在跑時延後（原因帶英文版：GET /api/update 的 last.en.reason）
    const busy = async () => (running.has('curate') ? { zh: '自動駕駛正在執行', en: 'autopilot is running' } : (await isIdle()) ? null : { zh: '有對話進行中', en: 'a conversation is in progress' });
    const r = await autoUpdate({ home: paths.home, autoUpdate: setting, busy, notify: (n) => notifier.notify(n), restartAgent, now });
    const note = { note: r.reason, en: { note: r.en?.reason ?? r.reason } };
    if (r.status === 'updated') restartPending = true;
    if (r.status === 'deferred') {
      // 同一個原因連續延後 5 次之後（runAutoUpdate 已通知一次）：這次算執行過，不再短間隔重試，下一次是明天的排程
      if (r.giveUpToday) return { ok: true, quiet: true, ...note };
      updateRetryAt = now() + (r.code === 'offline' ? UPDATE_OFFLINE_RETRY_MS : UPDATE_BUSY_RETRY_MS);
      return { ok: true, defer: true, quiet: true, ...note };
    }
    if (r.status === 'failed') return { ok: false, ...note };
    if (['off', 'none', 'current'].includes(r.status)) return { ok: true, silent: true, ...note }; // 沒有事可做：日誌不寫
    return { ok: true, ...note };
  };

  // ───────── 執行與排程 ─────────

  /** 執行工作。同一個工作不會同時跑兩份；sync／watch 執行中又被觸發時，結束後再補跑一次。 */
  function runJob(id, reason = 'manual') {
    if (!JOB_DEFS[id]) throw new CliError('E_NOT_FOUND', `沒有這個工作：${id}`).withEn(`No such job: ${id}`);
    if (running.has(id)) {
      if (id === 'sync' || id === 'watch') again.add(id);
      return running.get(id);
    }
    const t0 = now();
    if (id === 'sync') syncRetryAt = null;
    if (id === 'watch') {
      clearTimeout(watchTimer);
      watchDueAt = null;
    }
    const p = execute(id, reason, t0).finally(() => {
      running.delete(id);
      emitJob(id);
      if (again.delete(id)) runJob(id, 'coalesced');
    });
    running.set(id, p);
    emitJob(id);
    return p;
  }

  async function execute(id, reason, t0) {
    let result;
    let defer = false;
    let quiet = false; // 沒什麼好說的一輪：日誌只寫 debug
    let silent = false; // 沒有事可做：日誌完全不寫（工作狀態照常記錄）
    let retryAt = null;
    try {
      const r = await RUNNERS[id](reason);
      defer = !!r?.defer;
      quiet = !!r?.quiet;
      silent = !!r?.silent;
      if (Number.isFinite(r?.retryAt)) retryAt = r.retryAt;
      result = { ok: r?.ok !== false, ms: now() - t0, note: r?.note ?? '', ...(r?.en ? { en: r.en } : {}) };
    } catch (err) {
      result = { ok: false, ms: now() - t0, ...failNote(toErrorInfoI18n(err)) };
    }
    if (id === 'curate') autopilotRetryAt = defer ? (retryAt ?? now() + AUTOPILOT_RETRY_MS) : null;
    // 延後（例如電腦使用中）：不算執行過，保留上次執行時間，只記結果
    if (defer) Object.assign(state.jobs[id], { lastResult: result });
    else Object.assign(state.jobs[id], { lastRunAt: iso(t0), lastResult: result });
    save();
    if (silent && result.ok) return result;
    log[result.ok ? (quiet ? 'debug' : 'info') : 'warn'](id, `${result.ok ? '完成' : '失敗'}（${reason}，${result.ms} ms）${result.note ? `：${result.note}` : ''}`);
    return result;
  }

  function scheduleWatch(delay = QUIET_MS) {
    if (!enabled('watch')) return;
    clearTimeout(watchTimer);
    watchDueAt = now() + delay;
    watchTimer = setTimeout(() => runJob('watch', 'quiet'), delay);
    watchTimer.unref?.();
  }

  /** vault 目前每個檔案與資料夾（.git 以外）的簽章 */
  function scanVault() {
    const found = new Map();
    const walk = (dir, prefix) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!prefix && e.name === '.git') continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        const sig = fileSignature(path.join(vaultDir, rel));
        if (sig !== null) found.set(rel, sig);
        if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      }
    };
    walk(vaultDir, '');
    return found;
  }

  /** 記下 vault 目前每個檔案的簽章，之後的事件才分得出「真的變了」與「只是被讀過」。 */
  function baselineVault() {
    signatures.clear();
    for (const [rel, sig] of scanVault()) signatures.set(rel, sig);
    baselined = true;
  }

  /** 重新掃描並對照簽章：回傳新增、修改、刪除的路徑，同時更新簽章。還沒有基準時（沒辦法比）一律回報有變更。 */
  function rescanVault() {
    if (!baselined) return ['(unknown)'];
    const now = scanVault();
    const diff = [...now].filter(([rel, sig]) => signatures.get(rel) !== sig).map(([rel]) => rel);
    for (const rel of signatures.keys()) if (!now.has(rel)) diff.push(rel);
    signatures.clear();
    for (const [rel, sig] of now) signatures.set(rel, sig);
    return diff;
  }

  /**
   * vault 有檔案變更：推送 change 事件（1 秒內合併），並在安靜 30 秒後做本機 commit。
   * 簽章沒變（只是被讀過、最後存取時間更新）的事件不算變更：同步自己就會讀遍整個 vault，不濾掉的話每次同步後都會多一次空的存檔。
   * 檔案已不存在或從沒看過的路徑一律算變更。沒有路徑的事件（Windows 在 git gc 這類一大批檔案操作之後會回報，
   * 可能代表監看的緩衝區滿了、事件被丟掉）看不出是哪個檔案：重新掃描整個 vault 對照簽章，有差異才算。
   */
  function onVaultChange(name) {
    const rel = String(name ?? '').replace(/\\/g, '/');
    if (rel === '.git' || rel.startsWith('.git/')) return;
    if (rel) {
      const sig = fileSignature(path.join(vaultDir, rel));
      if (sig !== null && signatures.get(rel) === sig) return;
      if (sig === null) signatures.delete(rel); else signatures.set(rel, sig);
      changed.add(rel);
    } else {
      const diff = rescanVault();
      if (!diff.length) return;
      for (const p of diff) changed.add(p);
    }
    if (!changeTimer) {
      changeTimer = setTimeout(() => {
        changeTimer = null;
        const list = [...changed];
        changed.clear();
        events.emit('change', { at: iso(now()), paths: list.slice(0, 50), count: list.length });
      }, 1000);
      changeTimer.unref?.();
    }
    scheduleWatch();
  }

  function startWatcher() {
    try {
      watcher = fs.watch(vaultDir, { recursive: true }, (_evt, name) => onVaultChange(name));
      watcher.on('error', (err) => {
        log.warn('watch', err);
        watcher?.close();
        watcher = null;
      });
      // 先開始監看再記簽章：記的途中有事件進來，最多是多算一次變更，不會漏掉。監看中斷重啟時沿用舊的簽章
      if (!baselined) baselineVault();
    } catch (err) {
      log.warn('watch', `無法監看 vault（${vaultDir}）：${err.message}`);
      watcher = null;
    }
  }

  const listDir = (dir) => fsp.readdir(dir).catch(() => []);

  /** Stop hook 寫的旗標檔：本機 commit 完成後，刪掉在這次開始前就存在的旗標。 */
  async function clearDirtyFlags(before) {
    for (const n of await listDir(paths.dirty)) {
      const file = path.join(paths.dirty, n);
      const st = await fsp.stat(file).catch(() => null);
      if (st && st.mtimeMs <= before) await fsp.rm(file, { force: true }).catch(() => {});
    }
  }

  async function checkClaudeVersion() {
    state.versionCheckedAt = iso(now());
    const v = await detectVersion().catch(() => null);
    if (v && v !== state.claudeVersion) {
      log.info('probe', `Claude Code 版本 ${state.claudeVersion ?? '未知'} → ${v}`);
      state.claudeVersion = v;
      if (enabled('probe')) runJob('probe', 'version-change');
    }
    save();
  }

  /** 有待切換的綁定、權限模式或 junction 暫停狀態改變、或上次對齊有延後的項目時，執行背景綁定 */
  async function bindDue() {
    if (state.binding?.mode !== bindingMode() || state.binding?.deferred > 0) return true;
    return (await pendingBindings(eg).catch(() => [])).length > 0;
  }

  /** 自動駕駛的啟用狀態跟著設定（設定檔可能被介面、CLI 或另一個程序改過） */
  async function syncAutopilotEnabled() {
    const on = (await eg?.settings?.get?.().catch(() => null))?.autopilot === 'on';
    if (state.jobs.curate.enabled !== on) {
      state.jobs.curate.enabled = on;
      if (!on) autopilotRetryAt = null;
      if (eg?.machine && eg?.paths?.vault) setEnabledState(eg, on).catch((err) => log.warn('autopilot', err));
      save();
      emitJob('curate');
    }
  }

  /**
   * 可以開始打包嗎：沒有同步、存檔正在執行（或已經排定）——這些會寫 ref，和打包重疊可能互相卡鎖——
   * 而且沒有對話進行中（電腦閒置）。同步或存檔在忙就下一個 tick 再看；電腦使用中就 5 分鐘後再看；
   * 每週的打包拖了兩天還等不到閒置就不再等（上面的同步、存檔檢查仍然要過）。
   */
  async function gcMayStart(t) {
    if (running.has('sync') || running.has('watch') || watchDueAt !== null) return false;
    if (gcDeferredSince !== null && t - gcDeferredSince >= GC_FORCE_MS) return true;
    if (await isIdle()) return true;
    gcCheckAt = t + GC_BUSY_RECHECK_MS;
    return false;
  }

  /** 零散物件超過上限，而且現在可以打包：該提早打包了。沒超過每小時看一次。 */
  async function looseObjectsDue(t) {
    const s = await eg.gc?.status?.().catch(() => null);
    if (!s?.over) {
      gcCheckAt = t + HOUR;
      return false;
    }
    return gcMayStart(t);
  }

  async function tick() {
    const t = now();
    await syncAutopilotEnabled();
    if (lastTickAt !== null && detectClockJump(lastTickAt, t)) {
      log.info('clock', `偵測到時鐘跳躍 ${Math.round((t - lastTickAt) / 1000)} 秒（可能剛從睡眠恢復），立即同步`);
      syncRetryAt = null;
      if (enabled('sync')) {
        // 剛喚醒網路常常還沒連上：連不上時先重試，不直接記成失敗（S2）
        warmup = { step: 0 };
        clearTimeout(warmupTimer);
        runJob('sync', 'resume');
      }
    }
    lastTickAt = t;
    for (const id of ['sync', 'health', 'probe', 'curate', 'rename']) {
      if (!running.has(id) && isDue(id, t)) runJob(id, 'schedule');
    }
    if (!running.has('env') && isDue('env', t)) runJob('env', 'schedule'); // 2.0.0：環境健檢（每天一次）
    // 2.0.0：自動更新（每天一次）。同步進行中先不跑：發佈資訊（release.json）要同步下來才看得到
    if (!running.has('update') && !running.has('sync') && isDue('update', t)) runJob('update', 'schedule');
    // 打包（U3）：不持引擎的寫入鎖、會短暫鎖住 ref，所以只在沒有同步或存檔正在執行、而且沒有對話進行中時才啟動；每週到期或零散物件太多都一樣
    if (enabled('gc') && !running.has('gc') && t >= gcCheckAt) {
      const due = isDue('gc', t);
      if (due) gcDeferredSince ??= t;
      if (due ? await gcMayStart(t) : await looseObjectsDue(t)) runJob('gc', due ? 'schedule' : 'loose-objects');
    }
    if (envSyncRetryAt !== null && t >= envSyncRetryAt && !envSyncBusy && !running.has('env')) retryEnvSync(); // 2.0.0 WP8：環境設定同步（auto）遇到對話進行中，稍後重試
    if (enabled('bind') && !running.has('bind') && (await bindDue())) runJob('bind', 'schedule');
    if (enabled('watch') && !watchDueAt && (await listDir(paths.dirty)).length) scheduleWatch();
    if (!watcher) startWatcher();
    if (t - (Date.parse(state.versionCheckedAt ?? '') || 0) >= HOUR) await checkClaudeVersion();
  }

  return {
    /** 啟動：開始監看 vault 與計時器，並立即同步、補跑錯過的健康檢查與背景綁定。 */
    start() {
      lastTickAt = now();
      syncAutopilotEnabled().catch(() => {});
      settings?.writePaused(paused()).catch((err) => log.warn('settings', err));
      // 既有的記憶庫補設 gc.auto=0（舊版引擎沒有 gc 就略過）
      if (typeof eg.gc?.ensureConfig === 'function') Promise.resolve(eg.gc.ensureConfig()).catch((err) => log.warn('gc', err));
      startWatcher();
      tickTimer = setInterval(() => tick().catch((err) => log.error('tick', err)), TICK_MS);
      tickTimer.unref?.();
      if (enabled('sync')) {
        warmup = { step: 0 }; // 剛啟動：網路可能還沒連上，連不上時先重試（S2）
        runJob('sync', 'startup');
      }
      if (isDue('health', now())) runJob('health', 'catch-up');
      if (enabled('bind')) runJob('bind', 'startup');
    },
    /** 停止計時器與監看，等執行中的工作（例如同步）做完再返回，避免中途結束 git 操作 */
    async stop() {
      stopping = true;
      autopilotAbort?.abort();
      gcAbort?.abort();
      clearInterval(tickTimer);
      clearTimeout(watchTimer);
      clearTimeout(warmupTimer);
      clearTimeout(changeTimer);
      watcher?.close();
      watcher = null;
      again.clear();
      await Promise.allSettled([...running.values()]);
      return saving;
    },
    run: runJob,
    retryLocked,
    toggle(id, on) {
      if (!JOB_DEFS[id]) throw new CliError('E_NOT_FOUND', `沒有這個工作：${id}`).withEn(`No such job: ${id}`);
      state.jobs[id].enabled = !!on;
      // 自動駕駛的開關就是設定的 autopilot
      if (id === 'curate') {
        eg?.settings?.set?.({ autopilot: on ? 'on' : 'off' })
          .then(() => (eg?.machine && eg?.paths?.vault ? setEnabledState(eg, !!on).catch((err) => log.warn('autopilot', err)) : null))
          .then(() => { if (on) runJob('curate', 'enable'); })
          .catch((err) => log.warn('autopilot', err));
      }
      if (id === 'curate' && !on) autopilotAbort?.abort();
      if (id === 'watch' && !on) {
        clearTimeout(watchTimer);
        watchDueAt = null;
      }
      save();
      emitJob(id);
      return info(id);
    },
    list: () => Object.keys(JOB_DEFS).map(info),
    tick,
    onVaultChange,
    baselineVault,
    paused,
    probe: () => withProbeEn(state.probe),
    claudeVersion: () => state.claudeVersion,
    lastSyncAt: () => state.jobs.sync.lastRunAt,
    flush: () => saving,
  };
}

/** 最近 AUTOPILOT_IDLE_MS 內沒有任何 Claude Code 對話紀錄被寫入（使用者沒有在用 Claude Code） */
export async function claudeIdle(claudeHome, t = Date.now()) {
  if (!claudeHome) return true;
  const root = path.join(claudeHome, 'projects');
  for (const d of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    for (const f of await fsp.readdir(path.join(root, d.name)).catch(() => [])) {
      if (!f.endsWith('.jsonl')) continue;
      const st = await fsp.stat(path.join(root, d.name, f)).catch(() => null);
      if (st && t - st.mtimeMs < AUTOPILOT_IDLE_MS) return false;
    }
  }
  return true;
}
