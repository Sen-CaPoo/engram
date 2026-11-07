// 自動駕駛的一輪（1.5.0）。由常駐程式的排程、介面的「立即執行」或 engram autopilot run 啟動。
// 順序：金鑰 → 規則卡片 → 同步衝突（主機）→ 要判斷的卡片 → 待你確認 → 有卡片的範圍整理 → 對話回顧 → 定期整理。
// 每一輪：先同步拿到另一台的變更、依預算呼叫 LLM、所有變更經過護欄與審核員、結束時同步並寫執行紀錄。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../cli/fsutil.mjs';
import { encodePath } from '../cli/probe/index.mjs';
import { undoItem } from '../tidy/apply.mjs';
import { readRecord } from '../tidy/store.mjs';
import { runBudget } from './budget.mjs';
import { changeCap } from './guard.mjs';
import { createClaudeJudge } from './llm.mjs';
import { createCaller } from './pipeline.mjs';
import { acquireRunLock, allFeedback, electHost, listRuns, newRunId, pausedCategories, pruneRuns, readMachineState, readRun, recordUndoFeedback, updateMachineState, writeRun } from './state.mjs';
import { judgedCards, ruleCards } from './tasks/cards.mjs';
import { resolveConflicts } from './tasks/conflicts.mjs';
import { curateScope, planScopes } from './tasks/curate.mjs';
import { dreamProject, dreamTargets } from './tasks/dream.mjs';
import { auditReviews } from './tasks/review.mjs';
import { secretCards } from './tasks/secrets.mjs';

const DAY = 86_400_000;
export const workRoot = (local) => path.join(local, 'autopilot', 'work');

/** 回饋與暫停的類別（給人看的名稱） */
export const CATEGORY_LABEL = {
  update: '改寫', move: '搬移', archive: '封存', merge: '合併', create: '新增', split: '拆分', promote: '升為全域', core: '核心準則',
  'dream-create': '對話回顧新增', 'dream-update': '對話回顧改寫', vault: '金鑰移到保管區', 'not-secret': '標記不是金鑰', confirm: '代你確認', revert: '退回寫入',
};
export const categoryLabel = (c) => CATEGORY_LABEL[c] ?? (String(c).startsWith('conflict-') ? '衝突處理' : String(c).startsWith('card-') ? `收件匣 ${String(c).slice(5)}` : c);

/** 把這一輪的結果整理成一句話與數字 */
export function summarize(run) {
  const done = run.actions.filter((a) => a.status === 'done' && a.kind !== 'dismiss');
  const by = (k) => done.filter((a) => a.task === k).length;
  const failed = run.actions.filter((a) => a.status === 'failed').length;
  const cost = run.calls.reduce((n, c) => n + (c.costUsd ?? 0), 0);
  return {
    changes: done.length,
    dismissed: run.actions.filter((a) => a.kind === 'dismiss').length,
    rejected: run.rejected.length,
    failed,
    byTask: { curate: by('curate'), dream: by('dream'), cards: by('cards'), conflicts: by('conflicts'), secrets: by('secrets'), review: by('review') },
    calls: run.calls.length,
    costUsd: Math.round(cost * 10000) / 10000,
  };
}

/**
 * 執行一輪。不丟例外（錯誤記在執行紀錄裡）。
 * @param {object} eg 引擎
 * @param {{ judge?, notifier?, log?, reason?, force?, signal?, now?: () => number, onProgress?: (run) => void }} o
 */
export async function runAutopilot(eg, { judge, notifier, log, reason = 'manual', force = false, signal, now = Date.now, onProgress } = {}) {
  const local = eg.paths.local;
  const settings = await eg.settings.get();
  if (settings.autopilot !== 'on' && !force) return { ok: true, skipped: 'off' };
  const id = newRunId(new Date(now()));
  const lock = await acquireRunLock(local, id, now());
  if (!lock) return { ok: false, skipped: 'busy' };
  const run = { v: 1, id, reason, machine: eg.machine.id, startedAt: new Date(now()).toISOString(), status: 'running', pid: process.pid, host: null, budget: null, actions: [], rejected: [], skipped: [], notes: [], calls: [], records: [] };
  const save = async () => { await writeRun(local, run).catch(() => {}); onProgress?.(run); };
  const workDir = path.join(workRoot(local), id);
  try {
    await save();
    // 上一輪被中斷（程序被關掉）：標成中斷
    for (const r of await listRuns(local, { limit: 5 })) if (r.status === 'running' && r.id !== id && r.pid !== process.pid) await writeRun(local, { ...r, status: 'interrupted' }).catch(() => {});
    if (settings.autopilot === 'on') {
      const st = await readMachineState(eg.paths.vault, eg.machine.id);
      if (!st.enabledAt) await updateMachineState(eg, (s) => { s.enabledAt = new Date(now()).toISOString(); return s; }, 'autopilot on');
    }
    // 先拿到另一台的變更
    const s0 = await eg.sync().catch((err) => ({ ok: false, error: { message: err.message } }));
    if (s0?.ok === false) run.notes.push({ task: 'run', note: `開始前同步失敗，先用本機的內容處理：${s0.error?.message ?? ''}`.slice(0, 300) });
    const host = await electHost(eg.paths.vault, eg.machine.id, now());
    const isHost = host.host === eg.machine.id || (settings.autopilot !== 'on' && !host.host);
    run.host = { mid: host.host, label: host.label, self: isHost };
    const budget = await runBudget(local, settings.autopilotBudget, now());
    run.budget = budget;
    if (budget.run <= 0) {
      run.notes.push({ task: 'run', note: `這個月的預算（約當 US$${budget.monthly}）已用完，下個月再繼續` });
      run.status = 'done';
      return { ok: true, run };
    }
    await fsp.mkdir(workDir, { recursive: true });
    const call = createCaller({ judge: judge ?? createClaudeJudge({ cwd: workRoot(local) }), local, run, budgetUsd: budget.run, log, signal });
    const feedback = await allFeedback(eg.paths.vault, now());
    const paused = pausedCategories(feedback, now());
    if (paused.length) run.notes.push({ task: 'run', note: `暫停中的類別（被你復原過多次）：${paused.map(categoryLabel).join('、')}` });
    const memCount = (await eg.memories.list()).length;
    const ctx = { eg, call, run, mid: eg.machine.id, isHost, feedback, paused, cap: { left: changeCap(memCount) }, workDir, log, now: now(), findings: [] };
    const refresh = async () => { ctx.findings = (await eg.health().catch(() => [])) ?? []; };
    const stopped = () => !!call.state.stopped || signal?.aborted;
    const step = async (name, fn) => {
      if (stopped()) return;
      try { await fn(); } catch (err) {
        run.skipped.push({ task: name, why: `${err?.code ?? 'E_INTERNAL'}：${String(err?.message ?? err).slice(0, 400)}` });
        log?.warn?.('autopilot', err);
      }
      await save();
    };
    await refresh();
    await step('secrets', () => secretCards(ctx));
    await step('cards', async () => { await refresh(); await ruleCards(ctx); });
    if (isHost) await step('conflicts', () => resolveConflicts(ctx));
    await step('cards', async () => { await refresh(); await judgedCards(ctx); });
    await step('review', async () => { await refresh(); await auditReviews(ctx); });
    await refresh();
    const scopes = await planScopes(ctx).catch(() => []);
    for (const sc of scopes.filter((x) => x.sev < 3)) await step('curate', () => curateScope(ctx, sc));
    for (const t of await dreamTargets(ctx).catch(() => [])) await step('dream', () => dreamProject(ctx, t));
    for (const sc of scopes.filter((x) => x.sev >= 3)) await step('curate', () => curateScope(ctx, sc));
    if (call.state.stopped) run.notes.push({ task: 'run', note: call.state.stopped === 'budget' ? '這一輪的預算用完了，其餘的下一輪處理' : call.state.stopped === 'cancelled' ? '常駐程式結束，這一輪提前停止' : '已達 Claude 的用量上限，其餘的下一輪處理' });
    // 收尾：更新收件匣、把變更推到另一台
    await eg.health().catch(() => null);
    const s1 = await eg.sync().catch((err) => ({ ok: false, error: { message: err.message } }));
    if (s1?.ok === false) run.notes.push({ task: 'run', note: `結束時同步失敗，下次同步會再推送：${s1.error?.message ?? ''}`.slice(0, 300) });
    run.status = 'done';
    return { ok: true, run };
  } catch (err) {
    run.status = 'failed';
    run.error = { code: err?.code ?? 'E_INTERNAL', message: String(err?.message ?? err).slice(0, 500) };
    log?.error?.('autopilot', err);
    return { ok: false, run };
  } finally {
    run.endedAt = new Date(now()).toISOString();
    run.summary = summarize(run);
    if (run.status === 'running') run.status = 'failed';
    await save();
    await updateMachineState(eg, (s) => { s.lastRunAt = run.endedAt; s.lastRunId = run.id; return s; }, 'autopilot run').catch(() => {});
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    await cleanupClaudeProject(eg, local).catch(() => {});
    await pruneRuns(local).catch(() => {});
    await digest(eg, notifier, now()).catch(() => {});
    await lock.release();
  }
}

/** claude -p 會為工作資料夾建立空的專案紀錄資料夾（--no-session-persistence 也會）；空的就清掉 */
async function cleanupClaudeProject(eg, local) {
  const dir = path.join(eg.paths.claudeHome, 'projects', encodePath(path.resolve(workRoot(local))));
  if (!fs.existsSync(dir)) return;
  await fsp.rmdir(path.join(dir, 'memory')).catch(() => {});
  await fsp.rmdir(dir).catch(() => {});
}

/** 每週摘要通知：距離上次通知 7 天以上、而且這段期間有做事 */
async function digest(eg, notifier, now) {
  if (!notifier?.notify) return;
  const file = path.join(eg.paths.local, 'autopilot', 'digest.json');
  const st = (await readJson(file, null)) ?? {};
  const since = Date.parse(st.at ?? '') || 0;
  if (since && now - since < 7 * DAY) return;
  const runs = (await listRuns(eg.paths.local, { limit: 60 })).filter((r) => Date.parse(r.startedAt) > since);
  const done = runs.flatMap((r) => r.actions ?? []).filter((a) => a.status === 'done' && a.kind !== 'dismiss' && !a.undone);
  if (!since) { await writeJsonAtomic(file, { at: new Date(now).toISOString() }); return; }
  if (!done.length) return;
  const n = (t) => done.filter((a) => a.task === t).length;
  const parts = [['整理', n('curate')], ['對話回顧', n('dream')], ['收件匣', n('cards') + n('review')], ['衝突', n('conflicts')], ['金鑰', n('secrets')]].filter(([, k]) => k).map(([l, k]) => `${l} ${k}`);
  notifier.notify({ key: `autopilot-digest:${new Date(now).toISOString().slice(0, 10)}`, title: 'Engram 憶跡・自動駕駛', body: `這週自動處理了 ${done.length} 項（${parts.join('、')}），全部可以在「自動駕駛」頁復原。`, page: 'autopilot' });
  await writeJsonAtomic(file, { at: new Date(now).toISOString() });
}

// ───────── 復原 ─────────

/**
 * 復原一輪裡的一項（index）或整輪（index 省略，依相反順序）。被復原的記成回饋，之後的判斷會避開；
 * 同一類被復原 2 次以上就暫停。
 */
export async function undoRun(eg, runId, index) {
  const local = eg.paths.local;
  const run = await readRun(local, runId);
  if (!run) throw Object.assign(new Error(`找不到自動駕駛的執行紀錄：${runId}`), { code: 'E_NOT_FOUND' });
  const targets = index === undefined ? run.actions.map((a, i) => i).reverse() : [Number(index)];
  const results = [];
  for (const i of targets) {
    const a = run.actions[i];
    if (!a || a.status !== 'done' || a.undone || !(a.undo?.length || a.kind === 'tidy')) { if (index !== undefined) results.push({ index: i, ok: false, message: '這一項沒有可以復原的變更' }); continue; }
    try {
      if (a.kind === 'tidy') await undoItem(eg, a.record, a.item);
      else for (const sha of [...a.undo].reverse()) await eg.undo(sha);
      a.undone = new Date().toISOString();
      results.push({ index: i, ok: true });
      await recordUndoFeedback(eg, { category: a.category ?? a.kind, ref: a.refs?.[0] ?? null, title: a.title, reason: a.reason }).catch(() => {});
    } catch (err) {
      results.push({ index: i, ok: false, message: String(err?.message ?? err).slice(0, 300) });
      if (index === undefined) break; // 整輪復原：中間失敗就停，避免後面的復原蓋掉前面的狀態
    }
  }
  await writeRun(local, run);
  return { ok: results.every((r) => r.ok), results };
}

/** 使用者在記憶整理頁復原了自動駕駛記錄的一項：同步標到執行紀錄、記回饋 */
export async function noteTidyUndo(eg, recordId, itemId) {
  const rec = await readRecord(eg.paths.local, recordId).catch(() => null);
  if (rec?.kind !== 'autopilot' || !rec.autopilot?.run) return;
  const run = await readRun(eg.paths.local, rec.autopilot.run);
  const a = run?.actions.find((x) => x.kind === 'tidy' && x.record === recordId && x.item === itemId);
  if (!run || !a || a.undone) return;
  a.undone = new Date().toISOString();
  await writeRun(eg.paths.local, run);
  await recordUndoFeedback(eg, { category: a.category ?? 'update', ref: a.refs?.[0] ?? null, title: a.title, reason: a.reason }).catch(() => {});
}

/** 狀態（介面、CLI）：開關、主機、本月用量、上次與最近的執行 */
export async function autopilotStatus(eg, { now = Date.now() } = {}) {
  const settings = await eg.settings.get();
  const host = await electHost(eg.paths.vault, eg.machine.id, now);
  const budget = await runBudget(eg.paths.local, settings.autopilotBudget, now);
  const feedback = await allFeedback(eg.paths.vault, now);
  const runs = await listRuns(eg.paths.local, { limit: 30 });
  return {
    enabled: settings.autopilot === 'on',
    budget: { monthly: budget.monthly, used: Math.round(budget.used * 10000) / 10000, remaining: Math.round(budget.remaining * 10000) / 10000 },
    host: { mid: host.host, label: host.label, self: host.host === eg.machine.id, enabled: host.enabled },
    paused: pausedCategories(feedback, now),
    feedback: feedback.slice(-20),
    running: runs.find((r) => r.status === 'running' && r.pid && (() => { try { process.kill(r.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } })()) ?? null,
    runs: runs.map((r) => ({ id: r.id, reason: r.reason, startedAt: r.startedAt, endedAt: r.endedAt ?? null, status: r.status, summary: r.summary ?? null, host: r.host ?? null })),
  };
}
