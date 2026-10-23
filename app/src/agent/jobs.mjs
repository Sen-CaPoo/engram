// 常駐程式的程序內排程器（ADR §07）：sync、watch、health、probe、bind、curate。
// 一個 60 秒計時器負責：到期的工作、偵測牆上時鐘跳躍（從睡眠恢復就立即同步）、每小時檢查 Claude Code 版本。
// 每個工作記錄 nextRunAt、lastRunAt、lastResult；啟用狀態與上次執行時間存在 local/agent-jobs.json。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CliError, toErrorInfo } from '../cli/errors.mjs';
import { readJsonSync, writeJsonAtomic } from '../cli/fsutil.mjs';
import { pausedFrom, userPermissionMode } from '../cli/probe/index.mjs';
import { isLocked, summarizeSync, syncFailure } from '../cli/syncresult.mjs';
import { createPendingBinder, pendingBindings } from './pending.mjs';

export const TICK_MS = 60_000;
export const SYNC_EVERY_MS = 10 * 60_000;
export const QUIET_MS = 30_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HEALTH_AT = { hour: 9, minute: 30 };
const LOCK_RETRY_MS = 60_000;
const SYNC_ALERT_MS = DAY;

export const JOB_DEFS = Object.freeze({
  sync: { label: '網路同步', schedule: '每 10 分鐘；啟動、睡眠恢復、對話結束時', enabled: true },
  watch: { label: '本機存檔', schedule: 'vault 有變更且安靜 30 秒後', enabled: true },
  health: { label: '健康檢查', schedule: '每天 09:30；錯過時於啟動後補跑', enabled: true },
  probe: { label: '相容性探測', schedule: 'Claude Code 改版時；會用你的 Claude 額度跑 6 次 Haiku 小測試（約 3 萬 token／次）', enabled: true },
  bind: { label: '背景綁定', schedule: '待切換的專案在對話結束 30 分鐘後；權限模式或探測結果改變時重新對齊', enabled: true },
  rename: { label: '撞名資料夾改名', schedule: '每小時；設定為自動時，依命名規則改名沒有對話在使用的撞名資料夾', enabled: true },
  curate: { label: '每週整理', schedule: '每週一次（第二階段）', enabled: false },
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
export function createJobs({ eg, paths, events, log, notifier, runProbe, detectVersion, settings, now = Date.now }) {
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
        return iso(Number.isFinite(last) ? last + 7 * DAY : t);
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
    return { id, label: def.label, schedule: def.schedule, enabled: st.enabled, nextRunAt: nextRunAt(id), lastRunAt: st.lastRunAt, lastResult: st.lastResult, running: running.has(id) };
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

  const RUNNERS = {
    async sync(reason) {
      if (userPaused()) return { ok: true, note: '已暫停（設定）' };
      events.emit('sync', { state: 'start', reason, at: iso(now()) });
      let res;
      try {
        res = await eg.sync(syncOptions(true));
      } catch (err) {
        res = { ok: false, state: 'error', error: toErrorInfo(err) };
      }
      const failure = syncFailure(res);
      events.emit('sync', { state: 'end', ok: !failure, reason, at: iso(now()), result: res ?? null, ...(failure ? { error: failure } : {}) });
      if (isLocked(res)) {
        syncRetryAt = now() + LOCK_RETRY_MS;
        return { ok: true, note: '另一個同步正在進行，1 分鐘後重試' };
      }
      emitStatus();
      if (failure) {
        onSyncFailed(failure);
        return { ok: false, note: `${failure.code}：${failure.message}` };
      }
      state.syncFailingSince = null;
      return { ok: true, note: summarizeSync(res).join(' ') };
    },

    async watch() {
      if (userPaused()) return { ok: true, note: '已暫停（設定）' };
      const startedAt = now();
      const res = await eg.sync(syncOptions(false));
      if (isLocked(res)) {
        scheduleWatch(QUIET_MS);
        return { ok: true, note: '另一個同步正在進行，30 秒後重試' };
      }
      const failure = syncFailure(res);
      if (failure) return { ok: false, note: `${failure.code}：${failure.message}` };
      await clearDirtyFlags(startedAt);
      return { ok: true, note: summarizeSync(res, { network: false }).join(' ') };
    },

    async health() {
      const findings = (await eg.health()) ?? [];
      const high = findings.filter((f) => f.severity === 'high');
      events.emit('finding', { at: iso(now()), findings });
      if (high.length) {
        // 同一組高等級發現 24 小時內只通知一次；出現新的發現時 key 不同，會再通知
        const key = `health:${high.map((f) => f.id ?? f.code).sort().join(',')}`;
        notifier.notify({ key, title: 'Engram 憶跡', body: `有 ${high.length} 項需要你處理：${high[0].title ?? high[0].code}`, page: 'inbox' });
      }
      return { ok: true, note: `${findings.length} 項發現，其中高 ${high.length} 項` };
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
      return { ok: result.ok, note: failed.length ? `未通過：${failed.join('、')}` : `${result.checks.length} 項全部通過` };
    },

    async bind() {
      const mode = bindingMode();
      if (userPaused() || paused().includes('bind')) {
        state.binding = { mode, deferred: 0, at: iso(now()) };
        return { ok: true, note: userPaused() ? '已暫停（設定）' : '已暫停（相容性探測未通過）' };
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
      return { ok: r.failed.length === 0, note: `${aligned}完成 ${r.done.length}、等待 ${r.waiting.length + (rc.deferred?.length ?? 0)}、失敗 ${r.failed.length}` };
    },

    /** 撞名資料夾依命名規則改名（SW-4）。只在設定為自動時；改名會重新綁定，所以背景綁定被暫停時也一併暫停 */
    async rename() {
      if (userPaused() || paused().includes('bind')) return { ok: true, note: userPaused() ? '已暫停（設定）' : '已暫停（相容性探測未通過）' };
      if (!eg.collisions) return { ok: true, note: '引擎不支援' };
      const mode = (await eg.settings?.get?.())?.collisionRename ?? 'ask';
      if (mode !== 'auto') return { ok: true, note: mode === 'ask' ? '設定為詢問：在收件匣一鍵改名' : '已關閉（設定）' };
      const r = await eg.collisions.apply({});
      if (r.renamed.length) {
        const list = r.renamed.map((x) => `${path.basename(x.from)} → ${path.basename(x.to)}`).join('、');
        log.info('rename', `依命名規則改名 ${r.renamed.length} 個撞名的資料夾：${list}`);
        events.emit('change', { at: iso(now()), kind: 'rename', items: r.renamed });
        notifier.notify({ key: `rename:${r.id}`, title: 'Engram 憶跡', body: `已依命名規則改名 ${r.renamed.length} 個撞名的資料夾：${list}。可在「裝置與同步」的變更紀錄整批還原。`, page: 'devices' });
      }
      const waiting = r.skipped.length ? `、暫不改名 ${r.skipped.length}（${[...new Set(r.skipped.map((s) => s.reason))].join('、')}）` : '';
      return { ok: true, note: `改名 ${r.renamed.length}${waiting}` };
    },

    async curate() {
      return { ok: true, note: '每週整理尚未實作（第二階段）' };
    },
  };

  // ───────── 執行與排程 ─────────

  /** 執行工作。同一個工作不會同時跑兩份；sync／watch 執行中又被觸發時，結束後再補跑一次。 */
  function runJob(id, reason = 'manual') {
    if (!JOB_DEFS[id]) throw new CliError('E_NOT_FOUND', `沒有這個工作：${id}`);
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
    try {
      const r = await RUNNERS[id](reason);
      result = { ok: r?.ok !== false, ms: now() - t0, note: r?.note ?? '' };
    } catch (err) {
      const e = toErrorInfo(err);
      result = { ok: false, ms: now() - t0, note: `${e.code}：${e.message}` };
    }
    Object.assign(state.jobs[id], { lastRunAt: iso(t0), lastResult: result });
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

  async function tick() {
    const t = now();
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
      if (!JOB_DEFS[id]) throw new CliError('E_NOT_FOUND', `沒有這個工作：${id}`);
      state.jobs[id].enabled = !!on;
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
    probe: () => state.probe,
    claudeVersion: () => state.claudeVersion,
    lastSyncAt: () => state.jobs.sync.lastRunAt,
    flush: () => saving,
  };
}
