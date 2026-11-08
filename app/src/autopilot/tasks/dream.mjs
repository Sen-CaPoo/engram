// 自動駕駛：對話回顧（1.5.0）。對應 /engram:dream：拿這台電腦的對話紀錄驗證專案記憶、補上漏記的事。
// 每段對話交給分析（無工具的 LLM），再彙整成計畫；寫進全域或單機的內容要有使用者自己說的話當證據。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../../cli/fsutil.mjs';
import { allBindingViews, readBindings } from '../../core/vault.mjs';
import { MAX_REVIEW_DEFERRALS, commitItems, fillBases, noteReviewDeferral, normalizeItems, screen, snap } from '../pipeline.mjs';
import { DREAM_ANALYZE_SCHEMA, DREAM_PLAN_SCHEMA, dreamAnalyzePrompt, dreamPlanPrompt } from '../prompts.mjs';

/** 一個專案一輪最多回顧幾個對話（由舊到新；舊的先被 Claude Code 清除） */
export const SESSIONS_PER_RUN = 8;
/** 同一個對話分析失敗（不是預算或用量上限造成的）幾次之後就不再重試，免得最舊的幾個壞掉的對話卡住整個專案 */
export const MAX_SESSION_FAILS = 3;
const failFile = (local) => path.join(local, 'autopilot', 'dream-fails.json');

/** 這台電腦綁定、有還沒回顧的對話的專案（快被清除的優先） */
export async function dreamTargets(ctx) {
  const { eg } = ctx;
  if (typeof eg.dream?.status !== 'function') return [];
  const pids = [...new Set(allBindingViews(await readBindings(eg.paths.vault, eg.machine.id)).map((v) => v.pid).filter(Boolean))];
  const projects = new Map((await eg.projects.list()).map((p) => [p.pid, p]));
  const out = [];
  for (const pid of pids) {
    const p = projects.get(pid);
    if (!p || p.archived || p.mergedInto) continue;
    const st = await eg.dream.status(pid).catch(() => null);
    if (st?.pending) out.push({ pid, name: p.name ?? pid, pending: st.pending, expires: st.expiresInDays ?? 999 });
  }
  return out.sort((a, b) => a.expires - b.expires || b.pending - a.pending);
}

/** 登入失效、網路、預算或用量上限：不是對話本身的問題，不計入放棄次數 */
export function infraFailure(err) {
  const code = err?.code;
  if (['E_STOPPED', 'E_LLM_LIMIT', 'E_LLM_SPAWN'].includes(code)) return true;
  const msg = String(err?.message ?? '');
  // E_LLM_OUTPUT 的訊息會夾帶模型的回覆內容（可能剛好談到登入、認證）：只有「整段輸出都解析不了」時才看訊息
  const checkable = code === 'E_LLM' || (code === 'E_LLM_OUTPUT' && msg.startsWith('無法解析 claude 的輸出'));
  if (!checkable) return false;
  return /\b(401|403|429|502|503|529)\b|invalid api key|\/login\b|not logged in|please log ?in|authentication (failed|error|required)|oauth token|\bunauthori[sz]ed\b|\bE(CONNRESET|CONNREFUSED|TIMEDOUT|NOTFOUND|AI_AGAIN)\b|unable to connect|connection (error|refused|closed|reset)|ConnectionRefused|ConnectionClosed|FailedToOpenSocket|request timed out|fetch failed|getaddrinfo|socket hang up|network error|proxy error|certificate|\boverloaded\b/i.test(msg);
}

export async function dreamProject(ctx, target) {
  const { eg, call, run, mid, feedback, paused, cap } = ctx;
  if (ctx.vaultBroken) return;
  let m;
  try { m = await eg.dream.prepare({ pid: target.pid, max: SESSIONS_PER_RUN }); } catch (err) {
    if (err?.code !== 'E_VAULT') throw err;
    // 保管區有解不開的項目：這一輪所有專案都不回顧（只記一次）
    ctx.vaultBroken = true;
    run.skipped.push({ task: 'dream', why: `${err.message}。${err.hint ?? ''}` });
    return;
  }
  const withText = m.sessions.filter((s) => s.files.length);
  if (!withText.length) {
    await eg.dream.done(m.id);
    run.notes.push({ task: 'dream', pid: target.pid, note: `${m.sessions.length} 個對話沒有內容，記為已回顧` });
    return;
  }
  const memoriesText = await fsp.readFile(path.join(m.dir, 'memories.md'), 'utf8').catch(() => '');
  // 記憶全文本身就太大：每段對話都會超過上限，先不消耗這批對話
  if (memoriesText.length > 250_000) {
    run.skipped.push({ task: 'dream', pid: target.pid, why: `這個專案要驗證的記憶全文太大（${Math.round(memoriesText.length / 1000)}K 字），先整理記憶再回顧` });
    return;
  }
  const findings = [];
  const skipped = [];
  const fails = (await readJson(failFile(eg.paths.local), null)) ?? {};
  for (const s of withText) {
    let ok = true;
    let budgetStop = false;
    let weight = 1;
    for (const f of s.files) {
      const transcript = await fsp.readFile(path.join(m.dir, ...f.split('/')), 'utf8');
      const r = await call(`回顧 ${target.name} ${String(s.sid).slice(0, 8)}`, { schema: DREAM_ANALYZE_SCHEMA, prompt: dreamAnalyzePrompt({ memories: memoriesText, transcript, projectName: target.name }) });
      if (!r.ok) { ok = false; budgetStop = infraFailure(r.error); weight = ['E_TOO_LARGE', 'E_LLM_OUTPUT'].includes(r.error?.code) ? 2 : 1; break; }
      findings.push({ session: String(s.sid).slice(0, 8), file: f, ...r.data });
    }
    if (ok) { delete fails[s.sid]; continue; }
    // 這個對話本身分析不了（太長、格式問題、逾時）：失敗次數到上限就當成回顧過，不再卡住
    // 對話本身的問題（太長、輸出格式不對）每次算 2；其他（逾時、模型回報錯誤）每次算 1，累積到 6 就放棄
    if (!budgetStop) fails[s.sid] = (fails[s.sid] ?? 0) + weight;
    if (!budgetStop && fails[s.sid] >= MAX_SESSION_FAILS * 2) { run.notes.push({ task: 'dream', pid: target.pid, note: `對話 ${String(s.sid).slice(0, 8)} 多次分析失敗（內容太長、格式或模型錯誤），略過不再重試` }); delete fails[s.sid]; continue; }
    skipped.push(String(s.sid));
  }
  await writeJsonAtomic(failFile(eg.paths.local), fails).catch(() => {});
  if (skipped.length === withText.length) {
    // 一份都沒分析到（預算用完或 LLM 失敗）：不記為已回顧，下一輪再分析
    run.skipped.push({ task: 'dream', pid: target.pid, why: '這一輪沒能分析任何對話（預算或 Claude 用量限制），下一輪再試' });
    return;
  }
  const anything = findings.some((f) => ['contradicted', 'outdated', 'uncertain', 'new', 'verified'].some((k) => f[k]?.length));
  if (!anything) {
    await eg.dream.done(m.id, { skip: skipped });
    run.notes.push({ task: 'dream', pid: target.pid, note: `回顧了 ${withText.length - skipped.length} 個對話，沒有需要更新的記憶` });
    return;
  }
  const snapshot = new Map();
  for (const row of m.memories) {
    const s = await snap(eg, snapshot, row.ref);
    // 分析期間被改過（使用者、Claude 或另一台電腦）：LLM 看的是舊內容，不准依舊內容覆蓋
    if (s && s.rev !== row.rev) { snapshot.delete(row.ref); run.notes.push({ task: 'dream', pid: target.pid, note: `${row.ref} 在回顧期間被修改，這次不動它` }); }
  }
  for (const [k, v] of snapshot) if (v.redacted) snapshot.delete(k);
  const others = (await eg.memories.list()).filter((x) => x.scope?.kind === 'global' || (x.scope?.kind === 'machine' && x.scope.mid === mid) || (x.scope?.kind === 'project' && x.scope.pid === target.pid))
    .filter((x) => !snapshot.has(x.ref)).map((x) => ({ ref: x.ref, description: x.description }));
  const r = await call(`回顧彙整 ${target.name}`, { schema: DREAM_PLAN_SCHEMA, prompt: dreamPlanPrompt({ projectName: target.name, pid: target.pid, memories: memoriesText, findings, others, feedback: feedback.slice(-30) }) });
  if (!r.ok) { run.skipped.push({ task: 'dream', pid: target.pid, why: r.error?.message ?? '彙整失敗' }); return; }
  // 建議只能落在這個專案、全域、這台電腦（plan.mjs 也會再檢查）
  const scoped = (Array.isArray(r.data.items) ? r.data.items : []).map((it) => ({ ...it, ops: (it.ops ?? []).map((o) => (o.op === 'create' && (o.scope === 'project' || !o.scope) ? { ...o, scope: `project:${target.pid}` } : o)) }));
  const writable = (k) => k === 'global' || k === `machine:${mid}` || k === `project:${target.pid}`;
  const { items, dropped } = normalizeItems(scoped, snapshot, { mid, writable });
  for (const d of dropped) run.rejected.push({ task: 'dream', pid: target.pid, title: d.title, why: d.why });
  fillBases(items, snapshot);
  const transcript = await eg.dream.text(m.id).catch(() => '');
  const { approved, rejected } = await screen(call, items, snapshot, { dream: { pid: target.pid, transcript }, paused, cap: cap.left, mid });
  for (const x of rejected) run.rejected.push({ task: 'dream', pid: target.pid, ...x });
  // 延後：超過改動上限、或這一輪中途停止時審核沒完成 → 這批對話下一輪重新分析。
  // 審核沒有完成（不是因為停止）連續 MAX_REVIEW_DEFERRALS 輪就不再延後，避免同一批對話每輪重新花錢分析
  const reviewDeferred = rejected.some((x) => x.reviewIncomplete);
  let deferred = rejected.some((x) => x.deferred && !x.reviewIncomplete) || (reviewDeferred && !!call.state?.stopped);
  if (!deferred && reviewDeferred) {
    const n = await noteReviewDeferral(eg.paths.local, `dream:${target.pid}`, true);
    if (n < MAX_REVIEW_DEFERRALS) deferred = true;
    else run.notes.push({ task: 'dream', pid: target.pid, note: `審核連續 ${n} 輪沒有完成，這批對話先記為已回顧` });
  }
  if (!deferred) await noteReviewDeferral(eg.paths.local, `dream:${target.pid}`, false);
  let rec = null;
  if (approved.length) {
    const res = await commitItems(eg, { items: approved, scopeKey: `project:${target.pid}`, summary: String(r.data.summary ?? ''), dir: path.join(ctx.workDir, `dream-${target.pid}`), task: 'dream', runId: run.id, ...(deferred ? {} : { dream: { id: m.id }, skipped: skipped.map((s) => s.slice(0, 8)) }), onRecord: async (id) => { run.records.push(id); await ctx.save?.(); } });
    for (const x of res.invalid) run.rejected.push({ task: 'dream', pid: target.pid, ...x });
    rec = res.record;
    for (const x of res.results) {
      run.actions.push({ task: 'dream', pid: target.pid, kind: 'tidy', ...x });
      if (x.status === 'done') cap.left -= x.cost ?? 1;
    }
  }
  // 沒有建立記錄（沒有通過的建議）：仍記為已回顧，這批對話不必再分析。有建議被延後時不記，下一輪重新分析
  if (deferred) run.notes.push({ task: 'dream', pid: target.pid, note: '有建議延後處理（超過這一輪最多改動的記憶筆數，或審核沒有完成），這批對話下一輪重新分析' });
  else if (!rec) await eg.dream.done(m.id, { skip: skipped });
  run.notes.push({ task: 'dream', pid: target.pid, note: `回顧了 ${withText.length - skipped.length} 個對話${m.remaining ? `，還有 ${m.remaining} 個下一輪處理` : ''}` });
}
