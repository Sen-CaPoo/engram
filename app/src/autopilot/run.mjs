// 自動駕駛的一輪（1.5.0）。由常駐程式的排程、介面的「立即執行」或 engram autopilot run 啟動。
// 順序：金鑰 → 規則卡片 → 同步衝突 → 要判斷的卡片 → 待你確認 → 保留區重審（2.0.0）→ 有卡片的範圍整理 → 對話回顧 → 定期整理。
// 每一輪：先同步拿到另一台的變更、依本月預算呼叫 LLM、所有變更經過護欄與審核員、結束時同步並寫執行紀錄。
// 1.6.0：多台平等（沒有主機），每台都處理共用記憶與衝突；沒有每輪的金額上限，只看本月剩下的。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { localDate, localTime, readJson, writeFileAtomic } from '../cli/fsutil.mjs';
import { encodePath } from '../cli/probe/index.mjs';
import { undoItem } from '../tidy/apply.mjs';
import { readRecord } from '../tidy/store.mjs';
import { runBudget } from './budget.mjs';
import { changeCap } from './guard.mjs';
import { createClaudeJudge, parseResetAt } from './llm.mjs';
import { createCaller } from './pipeline.mjs';
import { refreshDigest } from './digest.mjs';
import { preferencesBlock } from './prompts.mjs';
import { CATEGORY_LABEL, MAX_RESET_MS, acquireRunLock, activeLimit, alive, allFeedback, categoryLabel, enabledMachines, limitUntil, listRuns, mergeScopeMarks, newRunId, pausedCategories, pruneRuns, readMachineState, readRun, recentCorrections, recordLimit, recordUndoFeedback, resumeCategory, updateMachineState, writeRun } from './state.mjs';

export { resumeCategory };
import { judgedCards, ruleCards } from './tasks/cards.mjs';
import { resolveConflicts } from './tasks/conflicts.mjs';
import { curateScope, planScopes } from './tasks/curate.mjs';
import { dreamProject, dreamTargets } from './tasks/dream.mjs';
import { graduateMemories, undoGraduation } from './tasks/graduate.mjs';
import { reviewHolding } from './tasks/holding.mjs';
import { auditReviews } from './tasks/review.mjs';
import { holdVault, secretCards } from './tasks/secrets.mjs';

const DAY = 86_400_000;
/** 用量上限的訊息裡解析不到重置時間時，等多久（Claude 的上限以 5 小時為一期） */
const LIMIT_FALLBACK_MS = 5 * 3600_000;
export const workRoot = (local) => path.join(local, 'autopilot', 'work');

/** 用量上限的重置時間：解析不到、已經過了或太遠時用 5 小時後 */
export function limitResetAt(message, now) {
  const t = parseResetAt(message, now);
  return t && t > now && t - now <= MAX_RESET_MS ? t : now + LIMIT_FALLBACK_MS;
}

// 回饋與暫停的類別（給人看的名稱）：定義在 state.mjs（提示詞也要用），這裡照舊匯出
export { CATEGORY_LABEL, categoryLabel };

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
    byTask: { curate: by('curate'), dream: by('dream'), cards: by('cards'), conflicts: by('conflicts'), secrets: by('secrets'), review: by('review'), graduate: by('graduate') },
    calls: run.calls.length,
    costUsd: Math.round(cost * 10000) / 10000,
    // 2.0.0：這一輪為什麼提前停止（用量上限、登入失效、本月預算用完、暫時忙碌）；正常完成或被中斷時 null
    stopped: ['limit', 'auth', 'budget', 'busy'].includes(run.stopped) ? run.stopped : null,
    // 2.0.0：這一輪新進保留區的筆數（沒有執行的提案連同完整內容；同一個提案已經在保留區、只是更新的不算）
    held: (run.held ?? []).filter((x) => !x.merged).length,
    // 2.0.0 Q7：每種工作（secrets、cards、conflicts、review、holding、curate、dream）的呼叫次數與約當金額
    callsByTask: callsByTask(run.calls),
  };
}

function callsByTask(calls) {
  const out = {};
  for (const c of calls ?? []) {
    const e = (out[c.task ?? 'other'] ??= { calls: 0, costUsd: 0 });
    e.calls++;
    e.costUsd += c.costUsd ?? 0;
  }
  for (const e of Object.values(out)) e.costUsd = Math.round(e.costUsd * 10000) / 10000;
  return out;
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
  // 使用者在設定暫停了 Engram 的自動化：自動駕駛也不跑
  if (!force && ((await readJson(path.join(local, 'paused.json'), null)) ?? {}).user) return { ok: true, skipped: 'paused' };
  // 2.0.0：這台或另一台撞到 Claude 的用量上限、還沒重置：排程不啟動（同一個帳號的上限兩台共用）。手動執行照常
  if (reason === 'schedule' && !force) {
    const until = await limitUntil(local, eg.paths.vault, now()).catch(() => null);
    if (until) return { ok: true, skipped: 'limit', until: new Date(until).toISOString() };
  }
  const id = newRunId(new Date(now()));
  const lock = await acquireRunLock(local, id, now());
  if (!lock) return { ok: false, skipped: 'busy' };
  const run = { v: 1, id, reason, machine: eg.machine.id, startedAt: new Date(now()).toISOString(), status: 'running', pid: process.pid, budget: null, actions: [], rejected: [], skipped: [], notes: [], calls: [], records: [], held: [] };
  const save = async () => { await writeRun(local, run).catch(() => {}); onProgress?.(run); };
  const workDir = path.join(workRoot(local), id);
  // 這一輪整理過的範圍：分批寫進同步的狀態檔（對話回顧之前、最後一次同步之前，以及結束時保底），其他電腦就不會重複整理同一個版本
  const scopeMarks = {};
  const flushMarks = async () => {
    const batch = { ...scopeMarks };
    if (!Object.keys(batch).length) return;
    try {
      await updateMachineState(eg, (s) => { s.scopes = mergeScopeMarks(s.scopes, batch); return s; }, 'autopilot scopes');
      for (const k of Object.keys(batch)) if (scopeMarks[k] === batch[k]) delete scopeMarks[k];
    } catch (err) { log?.warn?.('autopilot', `整理紀錄寫入失敗，稍後再試：${err?.message ?? err}`); }
  };
  try {
    await save();
    // 上一輪被中斷（程序被關掉）：標成中斷
    for (const r of await listRuns(local, { limit: 5 })) if (r.status === 'running' && r.id !== id && r.pid !== process.pid) await writeRun(local, { ...r, status: 'interrupted' }).catch(() => {});
    if (settings.autopilot === 'on') {
      const st = await readMachineState(eg.paths.vault, eg.machine.id);
      if (!st.enabledAt) await updateMachineState(eg, (s) => { s.enabledAt = new Date(now()).toISOString(); return s; }, 'autopilot on').catch((err) => log?.warn?.('autopilot', err));
    }
    // 先拿到另一台的變更。同步正在進行（另一個同步或自動存檔拿著鎖）時等一下再試一次
    const trySync = () => eg.sync().catch((err) => ({ ok: false, state: 'error', error: { message: err.message } }));
    let s0 = await trySync();
    for (let i = 0; i < 6 && s0?.ok === false && ['locked', 'busy'].includes(s0.state) && !signal?.aborted; i++) { await new Promise((r) => setTimeout(r, 5000)); s0 = await trySync(); }
    // 1.6.0：每台都處理共用記憶。沒拿到另一台的最新變更（離線、登入失效、使用者暫停了同步…）時，
    // 不拿過期的內容整理共用記憶、解衝突或代為確認／退回（確認紀錄是所有電腦共用的）
    const shared = s0?.ok !== false && s0?.state !== 'paused';
    if (!shared) run.notes.push({ task: 'run', note: `開始前沒有同步（${s0?.state ?? 'error'}）：這一輪只處理這台自己的部分（單機記憶、金鑰、大量刪除的卡片、對話回顧），共用記憶的整理、同步衝突與待你確認下一輪再處理。${s0?.error?.message ?? ''}`.slice(0, 300) });
    const budget = await runBudget(local, settings.autopilotBudget, now());
    run.budget = budget;
    if (budget.run <= 0) {
      run.notes.push({ task: 'run', note: `這個月的預算（約當 US$${budget.monthly}）已用完，下個月再繼續` });
      run.stopped = 'budget';
      run.status = 'done';
      return { ok: true, run };
    }
    await fsp.mkdir(workDir, { recursive: true });
    const call = createCaller({ judge: judge ?? createClaudeJudge({ cwd: workRoot(local) }), local, run, budgetUsd: budget.run, log, signal });
    const allFb = await allFeedback(eg.paths.vault, now());
    // 2.0.0 Q9：回饋紀錄裡分成復原（提示詞的「使用者復原過的自動處理」、暫停）與使用者的糾正（最近 20 筆帶進整理與回顧彙整）
    const feedback = allFb.filter((f) => f.kind !== 'correction');
    const corrections = await recentCorrections(local, allFb, 20).catch(() => []);
    // 第四輪審查 F-10：暫停只看這台自己記下的復原（別台的狀態檔是同步來的，任何一台都能寫）
    const paused = pausedCategories(feedback.filter((f) => f.mid === eg.machine.id), now());
    if (paused.length) run.notes.push({ task: 'run', note: `暫停中的類別（被你復原過多次）：${paused.map(categoryLabel).join('、')}` });
    const memCount = (await eg.memories.list()).length;
    // 2.0.0：使用者的偏好（核心準則、確認過的回饋與偏好），整理、對話回顧彙整、審核員、待你確認的判斷都要遵守
    const preferences = await preferencesBlock(eg).catch((err) => { log?.warn?.('autopilot', `讀取使用者的偏好失敗：${err?.message ?? err}`); return ''; });
    // 第二輪審查 R6：使用者 90 天內在保留區標成「不需要」的提案（同樣的提案再被提出時直接略過）
    const dismissed = typeof eg.holding?.dismissedFingerprints === 'function' ? await eg.holding.dismissedFingerprints({ now: now() }).catch(() => new Set()) : new Set();
    const ctx = { eg, call, run, mid: eg.machine.id, feedback, corrections, paused, cap: { left: changeCap(memCount), max: changeCap(memCount) }, workDir, log, now: now(), clock: now, findings: [], save, scopeMarks, shared, preferences, dismissed };
    const refresh = async () => { ctx.findings = (await eg.health().catch(() => [])) ?? []; };
    const stopped = () => !!call.state.stopped || signal?.aborted;
    const step = async (name, fn) => {
      if (stopped()) return;
      call.state.task = name; // 這一步的呼叫記在哪一種工作（summary.callsByTask）
      try { await fn(); } catch (err) {
        run.skipped.push({ task: name, why: `${err?.code ?? 'E_INTERNAL'}：${String(err?.message ?? err).slice(0, 400)}` });
        log?.warn?.('autopilot', err);
      }
      await save();
    };
    await refresh();
    await step('secrets', () => secretCards(ctx));
    await step('cards', async () => { await refresh(); await ruleCards(ctx); });
    if (shared) await step('conflicts', () => resolveConflicts(ctx));
    await step('cards', async () => { await refresh(); await judgedCards(ctx); });
    if (shared) await step('review', async () => { await refresh(); await auditReviews(ctx); });
    // 2.0.0：保留區重審（之前沒有執行的提案再審一次），在整理之前
    await step('holding', () => reviewHolding(ctx));
    await refresh();
    const scopes = await planScopes(ctx).catch(() => []);
    for (const sc of scopes.filter((x) => x.sev < 3)) await step('curate', () => curateScope(ctx, sc));
    await flushMarks();
    for (const t of await dreamTargets(ctx).catch(() => [])) await step('dream', () => dreamProject(ctx, t));
    for (const sc of scopes.filter((x) => x.sev >= 3)) await step('curate', () => curateScope(ctx, sc));
    // 2.0.0 WP9：記憶畢業（每 7 天最多一次，所有電腦共用這個間隔；會寫共用的核心準則、規則檔與環境設定檔，開始前沒同步就不做）
    if (shared) await step('graduate', () => graduateMemories(ctx));
    // 整理紀錄在最後一次同步之前寫入，這一輪結束時就推給其他電腦
    await flushMarks();
    const stop = call.state.stopped;
    run.stopped = stop;
    if (stop === 'budget') run.notes.push({ task: 'run', note: `這個月的預算用完了（約當 US$${budget.monthly}），其餘的下個月處理；需要的話可以在「自動駕駛」頁提高每月上限` });
    else if (stop === 'cancelled') run.notes.push({ task: 'run', note: '常駐程式結束，這一輪提前停止' });
    // 暫時性的過載或速率限制：只停這一輪，排程照既有的重試間隔再試；不記用量上限（另一台照常）
    else if (stop === 'busy') run.notes.push({ task: 'run', note: 'Claude 暫時忙碌（過載或速率限制），這一輪先停止，稍後再試' });
    else if (stop === 'auth') {
      run.notes.push({ task: 'run', note: 'Claude Code 的登入已到期，請重新登入（在終端機執行 claude auth login），其餘的下一輪處理' });
      // 每天最多通知一次（通知器以鍵去重 24 小時，鍵含日期）
      await Promise.resolve(notifier?.notify?.({ key: `autopilot-auth:${localDate(new Date(now()))}`, title: 'Engram 憶跡・自動駕駛', body: 'Claude Code 的登入已到期，自動駕駛沒辦法判斷。請在終端機執行 claude auth login 重新登入，下一輪會接著處理。', page: 'autopilot' })).catch(() => {});
    } else if (stop === 'limit') {
      // 記下重置時間（本機與同步的狀態檔）：重置之前這台與另一台的排程都不啟動。在最後一次同步之前寫，這一輪結束就推給另一台
      const t = now();
      const resetAt = limitResetAt(call.state.message, t);
      await recordLimit(eg, { at: t, resetAt }, log).catch((err) => log?.warn?.('autopilot', `用量上限的紀錄寫入失敗：${err?.message ?? err}`));
      run.notes.push({ task: 'run', note: `已達 Claude 的用量上限，其餘的等 ${localTime(new Date(resetAt).toISOString())} 重置之後再處理` });
    }
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
    // 保底：還沒寫進去的整理紀錄（例如中途出錯）跟上次執行時間一起寫
    await updateMachineState(eg, (s) => { s.lastRunAt = run.endedAt; s.lastRunId = run.id; s.scopes = mergeScopeMarks(s.scopes, scopeMarks); return s; }, 'autopilot run')
      .catch((err) => log?.warn?.('autopilot', `執行狀態寫入失敗：${err?.message ?? err}`));
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    await cleanupClaudeProject(eg, local).catch(() => {});
    await pruneRuns(local).catch(() => {});
    // 2.0.0 Q8：每週摘要（上一週剛結束時產生並通知一次；常駐程式每天的健康檢查也會做，自動駕駛關閉時照樣產生）
    await refreshDigest(eg, { notifier, now: now() }).catch((err) => log?.warn?.('autopilot', `每週摘要產生失敗：${err?.message ?? err}`));
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

// ───────── 復原 ─────────

/** 復原「金鑰移到保管區」：把記憶裡的保管區標記換回原值（檔案會回到疑似金鑰、不同步的狀態） */
async function restoreFromVault(eg, ref, names) {
  const { getSecret, placeholder, PLACEHOLDER_NOTE, LEGACY_NOTES } = await import('../core/secretvault.mjs');
  const raw = ref === 'core/CORE.md' ? (await eg.core.read()).text ?? '' : (await eg.memories.read(ref)).raw;
  let text = raw;
  for (const n of names) text = text.split(placeholder(n)).join(await getSecret(eg.paths.local, n));
  if (!text.includes('<engram-secret:')) for (const note of [PLACEHOLDER_NOTE, ...LEGACY_NOTES]) text = text.split(`\n\n${note}\n`).join('\n');
  if (text === raw) throw Object.assign(new Error('記憶裡已經找不到保管區的標記（之後被修改過）'), { code: 'E_CONFLICT' });
  // 直接寫回檔案、不經過引擎的寫入（引擎會擋下金鑰；allowSecrets 則會把值記成「不是金鑰」而同步出去）：
  // 回到移入保管區之前的狀態——含疑似金鑰的檔案留在這台電腦、不同步。在 vault 鎖內比對讀取時的內容，避免蓋掉剛發生的修改
  const { safeWriteResult, sha1 } = await import('../core/fsx.mjs');
  const abs = path.join(eg.paths.vault, ...String(ref).split('/'));
  const r = await eg.locked('autopilot.restore', () => safeWriteResult(abs, text, { expectHash: sha1(raw) }));
  if (!r?.ok) throw Object.assign(new Error('記憶剛被修改，這次沒有復原；稍後再試'), { code: 'E_CONFLICT' });
}

/** 這一項能不能從自動駕駛頁復原 */
export const undoable = (a) => a?.status === 'done' && !a.undone && (a.undo?.length > 0 || a.kind === 'tidy' || (a.kind === 'rename' && !!a.renameId) || (a.kind === 'not-secret' && a.allowHashes?.length > 0) || (a.kind === 'vault' && a.vaultNames?.length > 0) || (a.kind === 'graduate' && !!a.graduate?.to));

/**
 * 復原一輪裡的一項（index）或整輪（index 省略，依相反順序）。被復原的記成回饋，之後的判斷會避開；
 * 同一類被復原 2 次以上就暫停。
 */
export async function undoRun(eg, runId, index) {
  const local = eg.paths.local;
  const run = await readRun(local, runId);
  if (!run) throw Object.assign(new Error(`找不到自動駕駛的執行紀錄：${runId}`), { code: 'E_NOT_FOUND' });
  if (run.status === 'running' && run.pid && alive(run.pid)) throw Object.assign(new Error('這一輪還在執行，等它完成再復原'), { code: 'E_LOCKED' });
  const noted = new Set();
  const targets = index === undefined ? run.actions.map((a, i) => i).reverse() : [Number(index)];
  const results = [];
  for (const i of targets) {
    const a = run.actions[i];
    if (!a || a.status !== 'done' || a.undone || !undoable(a)) { if (index !== undefined) results.push({ index: i, ok: false, message: '這一項沒有可以復原的變更' }); continue; }
    try {
      if (a.kind === 'tidy') {
        try { await undoItem(eg, a.record, a.item); } catch (err) {
          // 整理記錄被刪掉了：改用執行紀錄裡的版本復原
          if (err?.code !== 'E_NOT_FOUND' || !a.undo?.length) throw err;
          for (const sha of [...a.undo].reverse()) await eg.undo(sha);
        }
      } else if (a.kind === 'rename' && a.renameId) await eg.collisions.undo(a.renameId);
      // 2.0.0 WP9：記憶畢業：拿掉規則、設定或核心準則的那一行與記下的去向（不用 git revert：連續加的規則在 JSON 裡相鄰會衝突）
      else if (a.kind === 'graduate' && a.graduate?.to) await undoGraduation(eg, a.graduate);
      else if (a.kind === 'not-secret' && a.allowHashes?.length) { for (const h of a.allowHashes) await eg.secrets.removeAllowed(h).catch((err) => { if (err?.code !== 'E_NOT_FOUND') throw err; }); }
      else if (a.kind === 'vault' && a.vaultNames?.length) {
        // 你要拿回原文：先記下這個檔案 30 天內不再自動移回保管區（記在本機；收件匣的提醒照常顯示），再放回原值
        await holdVault(eg.paths.local, a.refs?.[0], Date.now() + 30 * DAY);
        try { await restoreFromVault(eg, a.refs?.[0], a.vaultNames); } catch (err) {
          await holdVault(eg.paths.local, a.refs?.[0], 0).catch(() => {}); // 沒放回去：撤回暫緩
          throw err;
        }
      }
      else for (const sha of [...a.undo].reverse()) await eg.undo(sha);
      a.undone = new Date().toISOString();
      results.push({ index: i, ok: true });
      // 回饋：整輪復原時每個類別只記一筆（一次整輪復原不該就把整個類別暫停）
      const cat = a.category ?? a.kind;
      if (!noted.has(cat)) { noted.add(cat); await recordUndoFeedback(eg, { category: cat, ref: a.refs?.[0] ?? null, title: a.title, run: runId }).catch(() => {}); }
    } catch (err) {
      // 失敗的記下來繼續做其他項（例如那一項已經在別處復原過、或之後又被修改）
      results.push({ index: i, ok: false, message: String(err?.message ?? err).slice(0, 300) });
    }
  }
  // 期間可能有別處（記憶整理頁）也標了復原：重新讀取後只合併這次的結果
  const latest = (await readRun(local, runId)) ?? run;
  for (const r of results) if (r.ok && latest.actions[r.index]) latest.actions[r.index].undone = run.actions[r.index].undone;
  await writeRun(local, latest);
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
  await recordUndoFeedback(eg, { category: a.category ?? 'update', ref: a.refs?.[0] ?? null, title: a.title, run: rec.autopilot.run }).catch(() => {});
}

/** 狀態（介面、CLI）：開關、開啟的電腦、本月用量、上次與最近的執行 */
export async function autopilotStatus(eg, { now = Date.now() } = {}) {
  const settings = await eg.settings.get();
  const machines = await enabledMachines(eg.paths.vault, eg.machine.id);
  const budget = await runBudget(eg.paths.local, settings.autopilotBudget, now);
  const feedback = await allFeedback(eg.paths.vault, now);
  const runs = await listRuns(eg.paths.local, { limit: 30 });
  return {
    enabled: settings.autopilot === 'on',
    budget: { monthly: budget.monthly, used: Math.round(budget.used * 10000) / 10000, remaining: Math.round(budget.remaining * 10000) / 10000 },
    machines: machines.map((x) => ({ mid: x.mid, label: x.label, self: x.self, enabledAt: x.enabledAt, lastRunAt: x.lastRunAt ?? null })),
    paused: pausedCategories(feedback.filter((f) => f.mid === eg.machine.id), now),
    feedback: feedback.filter((f) => f.kind !== 'correction').slice(-20),
    running: runs.find((r) => r.status === 'running' && r.pid && (() => { try { process.kill(r.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } })()) ?? null,
    // 2.0.0：還沒到期的用量上限（所有電腦裡重置時間最晚的那一筆）：{ at, resetAt, machine }；沒有時 null。排程要等到 resetAt 之後才自動繼續
    limit: await activeLimit(eg.paths.local, eg.paths.vault, eg.machine.id, now).catch(() => null),
    runs: runs.map((r) => ({ id: r.id, reason: r.reason, startedAt: r.startedAt, endedAt: r.endedAt ?? null, status: r.status, summary: r.summary ?? null })),
  };
}
