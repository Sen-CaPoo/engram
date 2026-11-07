// 常駐程式的程序內排程器（ADR §07）：sync、watch、health、probe、bind、curate。
// 一個 60 秒計時器負責：到期的工作、偵測牆上時鐘跳躍（從睡眠恢復就立即同步）、每小時檢查 Claude Code 版本。
// 每個工作記錄 nextRunAt、lastRunAt、lastResult；啟用狀態與上次執行時間存在 local/agent-jobs.json。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CliError, toErrorInfoI18n } from '../cli/errors.mjs';
import { readJsonSync, writeJsonAtomic } from '../cli/fsutil.mjs';
import { CONTRACTS } from '../cli/probe/contracts.mjs';
import { pausedFrom, userPermissionMode } from '../cli/probe/index.mjs';
import { isLocked, summarizeSync, summarizeSyncEn, syncFailure } from '../cli/syncresult.mjs';
import { createPendingBinder, pendingBindings } from './pending.mjs';
import { runAutopilot as realRunAutopilot, summarize } from '../autopilot/run.mjs';
import { setEnabledState } from '../autopilot/state.mjs';

export const TICK_MS = 60_000;
export const SYNC_EVERY_MS = 10 * 60_000;
export const QUIET_MS = 30_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HEALTH_AT = { hour: 9, minute: 30 };
const LOCK_RETRY_MS = 60_000;
const SYNC_ALERT_MS = DAY;
const AUTOPILOT_EVERY_MS = 20 * HOUR;
const AUTOPILOT_IDLE_MS = 20 * 60_000;
const AUTOPILOT_RETRY_MS = 30 * 60_000;
const AUTOPILOT_FORCE_MS = 2 * DAY;

export const JOB_DEFS = Object.freeze({
  sync: { label: '網路同步', schedule: '每 10 分鐘；啟動、睡眠恢復、對話結束時', enabled: true, en: { label: 'Network sync', schedule: 'Every 10 minutes; also at startup, after waking from sleep, and when a conversation ends' } },
  watch: { label: '本機存檔', schedule: 'vault 有變更且安靜 30 秒後', enabled: true, en: { label: 'Local save', schedule: 'After the vault changes and stays quiet for 30 seconds' } },
  health: { label: '健康檢查', schedule: '每天 09:30；錯過時於啟動後補跑', enabled: true, en: { label: 'Health check', schedule: 'Every day at 09:30; runs after startup if it was missed' } },
  probe: { label: '相容性探測', schedule: 'Claude Code 改版時；會用你的 Claude 額度跑 6 次 Haiku 小測試（約 3 萬 token／次）', enabled: true, en: { label: 'Compatibility probe', schedule: 'When Claude Code is updated; runs 6 small Haiku tests on your Claude quota (about 30k tokens each)' } },
  bind: { label: '背景綁定', schedule: '待切換的專案在對話結束 30 分鐘後；權限模式或探測結果改變時重新對齊', enabled: true, en: { label: 'Background binding', schedule: 'For projects waiting to switch, 30 minutes after the conversation ends; realigns when the permission mode or probe result changes' } },
  rename: { label: '撞名資料夾改名', schedule: '每小時；設定為自動時，依命名規則改名沒有對話在使用的撞名資料夾', enabled: true, en: { label: 'Colliding folder rename', schedule: 'Every hour; when set to automatic, renames colliding folders that no conversation is using, by the naming rule' } },
  // 1.5.0：原本預留的「每週整理」改成自動駕駛；啟用與否跟著設定的 autopilot（在設定或自動駕駛頁開關）
  curate: { label: '自動駕駛', schedule: '開啟後每天一次，在電腦閒置 20 分鐘以上時執行（超過 2 天沒執行就直接執行）', enabled: false, en: { label: 'Autopilot', schedule: 'Once a day when turned on, while the computer has been idle for 20+ minutes (runs anyway if it has not run for 2 days)' } },
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
    binding: saved.binding ?? null,
  };
}

/**
 * @param {{ eg, paths, events, log, notifier: { notify: Function }, runProbe, detectVersion, settings?, now?: () => number }} deps
 *   settings：agent/settings.mjs；沒有時用預設值（測試）
 */
export function createJobs({ eg, paths, events, log, notifier, runProbe, detectVersion, settings, now = Date.now, runAutopilot = realRunAutopilot, isIdle = () => claudeIdle(eg?.paths?.claudeHome, now()) }) {
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
  let autopilotRetryAt = null;
  let autopilotAbort = null;
  let changeTimer = null;
  const changed = new Set();

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

  /** 同步連續失敗超過 24 小時才發 Windows 通知（通知器負責 24 小時去重） */
  function onSyncFailed(error) {
    const t = now();
    state.syncFailingSince ??= iso(t);
    if (t - Date.parse(state.syncFailingSince) >= SYNC_ALERT_MS) {
      notifier.notify({ key: 'sync-failed', title: 'Engram 憶跡', body: `已超過 24 小時沒有成功同步，請開啟管理介面查看原因：${error.message}`, page: 'devices' });
    }
  }

  /** 失敗的備註；錯誤沒有英文訊息時不附 en，介面會退回中文 */
  const failNote = (f) => ({ note: `${f.code}：${f.message}`, ...(f.en?.message ? { en: { note: `${f.code}: ${f.en.message}` } } : {}) });

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
      events.emit('sync', { state: 'end', ok: !failure, reason, at: iso(now()), result: res ?? null, ...(failure ? { error: failure } : {}) });
      if (isLocked(res)) {
        syncRetryAt = now() + LOCK_RETRY_MS;
        return { ok: true, note: '另一個同步正在進行，1 分鐘後重試', en: { note: 'Another sync is in progress, retrying in 1 minute' } };
      }
      emitStatus();
      if (failure) {
        onSyncFailed(failure);
        return { ok: false, ...failNote(failure) };
      }
      state.syncFailingSince = null;
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
      return { ok: true, note: summarizeSync(res, { network: false }).join(' '), en: { note: summarizeSyncEn(res, { network: false }).join(' ') } };
    },

    async health() {
      // 1.4.0：先更新讀取統計（從對話紀錄增量計算、每天同步一次摘要）與確認紀錄的起點，再做健康檢查。失敗不影響健康檢查
      if (typeof eg.usage?.refresh === 'function') await eg.usage.refresh().catch((err) => log.warn('usage', err));
      if (typeof eg.review?.baseline === 'function') await eg.review.baseline().catch((err) => log.warn('review', err));
      if (typeof eg.review?.prune === 'function') await eg.review.prune().catch((err) => log.warn('review', err));
      if (typeof eg.dream?.ensureReadable === 'function') await eg.dream.ensureReadable().catch((err) => log.warn('dream', err));
      // 放著沒完成的對話回顧：匯出的文字 14 天後清除
      if (typeof eg.dream?.cleanup === 'function') await eg.dream.cleanup().catch((err) => log.warn('dream', err));
      const findings = (await eg.health()) ?? [];
      const high = findings.filter((f) => f.severity === 'high');
      events.emit('finding', { at: iso(now()), findings });
      if (high.length) {
        // 同一組高等級發現 24 小時內只通知一次；出現新的發現時 key 不同，會再通知
        const key = `health:${high.map((f) => f.id ?? f.code).sort().join(',')}`;
        notifier.notify({ key, title: 'Engram 憶跡', body: `有 ${high.length} 項需要你處理：${high[0].title ?? high[0].code}`, page: 'inbox' });
      }
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
      const rc = eg.identity.reconcile ? await eg.identity.reconcile() : { changed: [], deferred: [] };
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
      if (!eg.collisions) return { ok: true, note: '引擎不支援', en: { note: 'Not supported by the engine' } };
      const mode = (await eg.settings?.get?.())?.collisionRename ?? 'ask';
      if (mode !== 'auto') return { ok: true, note: mode === 'ask' ? '設定為詢問：在收件匣一鍵改名' : '已關閉（設定）', en: { note: mode === 'ask' ? 'Set to ask: rename in one click from the inbox' : 'Turned off (setting)' } };
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
      return { ok: true, note: `改名 ${r.renamed.length}${waiting}`, en: { note: `Renamed ${r.renamed.length}${waitingEn}` } };
    },

    /** 自動駕駛（1.5.0）：AI 判斷並處理收件匣、整理、對話回顧。排程觸發時要電腦閒置，避免和使用者搶 Claude 的用量 */
    async curate(reason) {
      if (userPaused()) return { ok: true, note: '已暫停（設定）', en: { note: 'Paused (setting)' } };
      const on = (await eg.settings?.get?.())?.autopilot === 'on';
      if (!on) return { ok: true, note: '未開啟', en: { note: 'Turned off' } };
      const last = Date.parse(state.jobs.curate.lastRunAt ?? '');
      if (reason === 'schedule' && Number.isFinite(last) && now() - last < AUTOPILOT_FORCE_MS && !(await isIdle())) {
        return { ok: true, defer: true, note: '電腦使用中，30 分鐘後再試', en: { note: 'The computer is in use; trying again in 30 minutes' } };
      }
      autopilotAbort = new AbortController();
      try {
        const r = await runAutopilot(eg, { notifier, log, reason, signal: autopilotAbort.signal, onProgress: (run) => events.emit('autopilot', { id: run.id, status: run.status, summary: summarize(run) }) });
        if (r.skipped === 'busy') return { ok: true, note: '另一輪正在執行', en: { note: 'Another run is in progress' } };
        if (r.skipped === 'off') return { ok: true, note: '未開啟', en: { note: 'Turned off' } };
        const sm = r.run?.summary ?? { changes: 0, rejected: 0, costUsd: 0 };
        events.emit('autopilot', { id: r.run?.id, status: r.run?.status, summary: sm });
        emitStatus();
        return {
          ok: r.ok,
          note: r.ok ? `處理 ${sm.changes} 項、不執行 ${sm.rejected} 項（約當 US$${sm.costUsd}）` : `失敗：${r.run?.error?.message ?? ''}`,
          en: { note: r.ok ? `${sm.changes} handled, ${sm.rejected} not carried out (about US$${sm.costUsd})` : `Failed: ${r.run?.error?.message ?? ''}` },
        };
      } finally {
        autopilotAbort = null;
      }
    },
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
    try {
      const r = await RUNNERS[id](reason);
      defer = !!r?.defer;
      result = { ok: r?.ok !== false, ms: now() - t0, note: r?.note ?? '', ...(r?.en ? { en: r.en } : {}) };
    } catch (err) {
      result = { ok: false, ms: now() - t0, ...failNote(toErrorInfoI18n(err)) };
    }
    if (id === 'curate') autopilotRetryAt = defer ? now() + AUTOPILOT_RETRY_MS : null;
    // 延後（例如電腦使用中）：不算執行過，保留上次執行時間，只記結果
    if (defer) Object.assign(state.jobs[id], { lastResult: result });
    else Object.assign(state.jobs[id], { lastRunAt: iso(t0), lastResult: result });
    save();
    log[result.ok ? 'info' : 'warn'](id, `${result.ok ? '完成' : '失敗'}（${reason}，${result.ms} ms）${result.note ? `：${result.note}` : ''}`);
    return result;
  }

  function scheduleWatch(delay = QUIET_MS) {
    if (!enabled('watch')) return;
    clearTimeout(watchTimer);
    watchDueAt = now() + delay;
    watchTimer = setTimeout(() => runJob('watch', 'quiet'), delay);
    watchTimer.unref?.();
  }

  /** vault 有檔案變更：推送 change 事件（1 秒內合併），並在安靜 30 秒後做本機 commit。 */
  function onVaultChange(name) {
    const rel = String(name ?? '').replace(/\\/g, '/');
    if (rel === '.git' || rel.startsWith('.git/')) return;
    if (rel) changed.add(rel);
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

  async function tick() {
    const t = now();
    await syncAutopilotEnabled();
    if (lastTickAt !== null && detectClockJump(lastTickAt, t)) {
      log.info('clock', `偵測到時鐘跳躍 ${Math.round((t - lastTickAt) / 1000)} 秒（可能剛從睡眠恢復），立即同步`);
      syncRetryAt = null;
      if (enabled('sync')) runJob('sync', 'resume');
    }
    lastTickAt = t;
    for (const id of ['sync', 'health', 'probe', 'curate', 'rename']) {
      if (!running.has(id) && isDue(id, t)) runJob(id, 'schedule');
    }
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
      startWatcher();
      tickTimer = setInterval(() => tick().catch((err) => log.error('tick', err)), TICK_MS);
      tickTimer.unref?.();
      if (enabled('sync')) runJob('sync', 'startup');
      if (isDue('health', now())) runJob('health', 'catch-up');
      if (enabled('bind')) runJob('bind', 'startup');
    },
    /** 停止計時器與監看，等執行中的工作（例如同步）做完再返回，避免中途結束 git 操作 */
    async stop() {
      autopilotAbort?.abort();
      clearInterval(tickTimer);
      clearTimeout(watchTimer);
      clearTimeout(changeTimer);
      watcher?.close();
      watcher = null;
      again.clear();
      await Promise.allSettled([...running.values()]);
      return saving;
    },
    run: runJob,
    toggle(id, on) {
      if (!JOB_DEFS[id]) throw new CliError('E_NOT_FOUND', `沒有這個工作：${id}`).withEn(`No such job: ${id}`);
      state.jobs[id].enabled = !!on;
      // 自動駕駛的開關就是設定的 autopilot
      if (id === 'curate') {
        eg?.settings?.set?.({ autopilot: on ? 'on' : 'off' })
          .then(() => (eg?.machine && eg?.paths?.vault ? setEnabledState(eg, !!on) : null))
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
