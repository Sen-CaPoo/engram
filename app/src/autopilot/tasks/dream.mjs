// 自動駕駛：對話回顧（1.5.0）。對應 /engram:dream：拿這台電腦的對話紀錄驗證專案記憶、補上漏記的事。
// 每段對話交給分析（無工具的 LLM），再彙整成計畫；寫進全域或單機的內容要有使用者自己說的話當證據。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { allBindingViews, readBindings } from '../../core/vault.mjs';
import { commitItems, fillBases, normalizeItems, screen, snap } from '../pipeline.mjs';
import { DREAM_ANALYZE_SCHEMA, DREAM_PLAN_SCHEMA, dreamAnalyzePrompt, dreamPlanPrompt } from '../prompts.mjs';

/** 一個專案一輪最多回顧幾個對話（由舊到新；舊的先被 Claude Code 清除） */
export const SESSIONS_PER_RUN = 8;

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

export async function dreamProject(ctx, target) {
  const { eg, call, run, mid, feedback, paused, cap } = ctx;
  const m = await eg.dream.prepare({ pid: target.pid, max: SESSIONS_PER_RUN });
  const withText = m.sessions.filter((s) => s.files.length);
  if (!withText.length) {
    await eg.dream.done(m.id);
    run.notes.push({ task: 'dream', pid: target.pid, note: `${m.sessions.length} 個對話沒有內容，記為已回顧` });
    return;
  }
  const memoriesText = await fsp.readFile(path.join(m.dir, 'memories.md'), 'utf8').catch(() => '');
  const findings = [];
  const skipped = [];
  for (const s of withText) {
    let ok = true;
    for (const f of s.files) {
      const transcript = await fsp.readFile(path.join(m.dir, ...f.split('/')), 'utf8');
      const r = await call(`回顧 ${target.name} ${String(s.sid).slice(0, 8)}`, { schema: DREAM_ANALYZE_SCHEMA, prompt: dreamAnalyzePrompt({ memories: memoriesText, transcript, projectName: target.name }) });
      if (!r.ok) { ok = false; break; }
      findings.push({ session: String(s.sid).slice(0, 8), file: f, ...r.data });
    }
    if (!ok) skipped.push(String(s.sid));
  }
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
  for (const row of m.memories) await snap(eg, snapshot, row.ref);
  for (const [k, v] of snapshot) if (v.redacted) snapshot.delete(k);
  const others = (await eg.memories.list()).filter((x) => x.scope?.kind === 'global' || (x.scope?.kind === 'machine' && x.scope.mid === mid) || (x.scope?.kind === 'project' && x.scope.pid === target.pid))
    .filter((x) => !snapshot.has(x.ref)).map((x) => ({ ref: x.ref, description: x.description }));
  const r = await call(`回顧彙整 ${target.name}`, { schema: DREAM_PLAN_SCHEMA, prompt: dreamPlanPrompt({ projectName: target.name, pid: target.pid, memories: memoriesText, findings, others, feedback: feedback.slice(-30) }) });
  if (!r.ok) { run.skipped.push({ task: 'dream', pid: target.pid, why: r.error?.message ?? '彙整失敗' }); return; }
  // 建議只能落在這個專案、全域、這台電腦（plan.mjs 也會再檢查）
  const scoped = (Array.isArray(r.data.items) ? r.data.items : []).map((it) => ({ ...it, ops: (it.ops ?? []).map((o) => (o.op === 'create' && (o.scope === 'project' || !o.scope) ? { ...o, scope: `project:${target.pid}` } : o)) }));
  const { items, dropped } = normalizeItems(scoped, snapshot, { mid });
  for (const d of dropped) run.rejected.push({ task: 'dream', pid: target.pid, title: d.title, why: d.why });
  fillBases(items, snapshot);
  const transcript = await eg.dream.text(m.id).catch(() => '');
  const { approved, rejected } = await screen(call, items, snapshot, { dream: { pid: target.pid, transcript }, paused, cap: cap.left, mid });
  for (const x of rejected) run.rejected.push({ task: 'dream', pid: target.pid, ...x });
  let rec = null;
  if (approved.length) {
    const res = await commitItems(eg, { items: approved, scopeKey: `project:${target.pid}`, summary: String(r.data.summary ?? ''), dir: path.join(ctx.workDir, `dream-${target.pid}`), task: 'dream', runId: run.id, dream: { id: m.id }, skipped: skipped.map((s) => s.slice(0, 8)) });
    for (const x of res.invalid) run.rejected.push({ task: 'dream', pid: target.pid, ...x });
    rec = res.record;
    if (rec) run.records.push(rec);
    for (const x of res.results) {
      run.actions.push({ task: 'dream', pid: target.pid, kind: 'tidy', ...x });
      if (x.status === 'done') cap.left--;
    }
  }
  // 沒有建立記錄（沒有通過的建議）：仍記為已回顧，這批對話不必再分析
  if (!rec) await eg.dream.done(m.id, { skip: skipped });
  run.notes.push({ task: 'dream', pid: target.pid, note: `回顧了 ${withText.length - skipped.length} 個對話${m.remaining ? `，還有 ${m.remaining} 個下一輪處理` : ''}` });
}
