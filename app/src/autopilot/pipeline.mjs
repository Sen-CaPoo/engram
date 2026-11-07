// 自動駕駛的共用流程（1.5.0）：LLM 呼叫（含預算）、把 LLM 提出的項目變成整理記錄並執行。
//
// 每一項依序經過：
//   1. 只准動 LLM 看過全文的記憶（snapshot），版本（base）由引擎依當時讀到的內容填上
//   2. 護欄：指令型內容檢查、風險分級、被復原太多次而暫停的類別、對話回顧寫進全域／單機要有使用者說的話當證據
//   3. 中、高風險或有可疑處 → 審核員（第二次 LLM 呼叫）；不同意或審核失敗 → 不執行
//   4. 單輪上限
// 通過的項目寫成整理計畫，交給既有的 createFromPlan 驗證（金鑰、版本、釘選、格式、同名），
// 驗證不過的項目剔除後重試，再自動採用並 applyRecord（備份、逐步記錄、可逐項復原）。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { revOf } from '../cli/commands/safe.mjs';
import { scopeOfRef } from '../core/memories.mjs';
import { parseMemoryFile } from '../core/frontmatter.mjs';
import { applyRecord } from '../tidy/apply.mjs';
import { createFromPlan, CORE_REF } from '../tidy/plan.mjs';
import { markReady, setDecisions, updateRecord } from '../tidy/store.mjs';
import { charge } from './budget.mjs';
import { CORE_ADD_CHARS, CORE_ADD_LINES, MAX_MERGE, MAX_OPS, SHARED, addedLines, categoriesOf, categoryOf, costOf, instructionFlags, riskOf } from './guard.mjs';

const SCOPE_RE = /^(global|machine(:[a-z0-9][a-z0-9-]{0,63})?|project:[a-z0-9][a-z0-9-]{0,63})$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const one = (t, max = 200) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
import { MODELS } from './llm.mjs';
import { REVIEW_SCHEMA, reviewPrompt } from './prompts.mjs';

const MAX_PROMPT_CHARS = 400_000;
const REVIEW_BATCH_CHARS = 120_000;

export const keyOfScope = (sc) => (!sc ? null : sc.kind === 'project' ? `project:${sc.pid}` : sc.kind === 'machine' ? `machine:${sc.mid}` : sc.kind);
export const scopeKeyOfRef = (ref) => (ref === CORE_REF ? 'core' : keyOfScope(scopeOfRef(ref)));

/**
 * LLM 呼叫器：記帳、這一輪的預算、用量上限時停止後續呼叫。
 * @returns {(label, { model?, schema, prompt }) => Promise<{ ok, data?, error? }>}
 */
export function createCaller({ judge, local, run, budgetUsd, log, signal }) {
  const state = { spent: 0, stopped: null };
  const call = async (label, { model = MODELS.main, schema, prompt }) => {
    if (signal?.aborted) state.stopped = 'cancelled';
    if (state.stopped) return { ok: false, error: { code: 'E_STOPPED', message: { budget: '這一輪的預算用完了', cancelled: '這一輪已停止' }[state.stopped] ?? '已達 Claude 的用量上限' } };
    if (budgetUsd - state.spent < 0.3) { state.stopped = 'budget'; return { ok: false, error: { code: 'E_STOPPED', message: '這一輪的預算用完了' } }; }
    if (prompt.length > MAX_PROMPT_CHARS) return { ok: false, error: { code: 'E_TOO_LARGE', message: `內容太長（${prompt.length} 字），這次略過` } };
    const r = await judge({ model, schema, prompt, signal, maxBudgetUsd: Math.max(0.5, Math.min(3, budgetUsd - state.spent)) });
    if (signal?.aborted) state.stopped = 'cancelled';
    state.spent += r.usage?.costUsd ?? 0;
    await charge(local, model, r.usage).catch(() => {});
    run.calls.push({ label, model, ms: r.ms ?? 0, input: r.usage?.input ?? 0, output: r.usage?.output ?? 0, costUsd: r.usage?.costUsd ?? 0, ok: r.ok, ...(r.ok ? {} : { error: r.error?.message?.slice(0, 300) }) });
    if (!r.ok && r.error?.code === 'E_LLM_LIMIT') state.stopped = 'limit';
    if (!r.ok) log?.warn?.('autopilot', `${label} 失敗：${r.error?.code} ${r.error?.message}`);
    return r;
  };
  call.state = state;
  return call;
}

/** 讀記憶（含遮蔽後要給 LLM 看的內容）放進 snapshot；含疑似金鑰的不給全文 */
export async function snap(eg, snapshot, ref) {
  if (snapshot.has(ref)) return snapshot.get(ref);
  let raw;
  let shown;
  if (ref === CORE_REF) {
    raw = (await eg.core.read()).text ?? '';
    shown = (await eg.secrets.preview(CORE_REF).catch(() => ({ after: raw }))).after;
  } else {
    try { raw = (await eg.memories.read(ref)).raw; } catch (err) { if (err?.code === 'E_NOT_FOUND') return null; throw err; }
    shown = (await eg.secrets.preview(ref)).after;
  }
  const fm = ref === CORE_REF ? {} : parseMemoryFile(raw).data ?? {};
  const s = { ref, raw, rev: revOf(raw), shown, redacted: shown !== raw, pinned: fm?.metadata?.engram?.pinned === true, scope: scopeKeyOfRef(ref) };
  snapshot.set(ref, s);
  return s;
}

const refsOfOp = (o) => (o.op === 'merge' ? [...(o.refs ?? []), o.into].filter(Boolean) : o.op === 'create' ? [] : o.op === 'core' ? [CORE_REF] : [o.ref].filter(Boolean));

/**
 * 把 LLM 的項目整理成計畫項目；只准動 snapshot 裡有全文的記憶。
 * @returns {{ items: object[], dropped: { title, why }[] }}
 */
export function normalizeItems(raw, snapshot, { allowCore = false, mid, writable = () => true } = {}) {
  const items = [];
  const dropped = [];
  for (const it of Array.isArray(raw) ? raw : []) {
    const title = String(it?.title ?? '').trim().slice(0, 120) || '（沒有標題）';
    // LLM 有時會漏掉 ref 的 .md 或前後加空白：對得上 snapshot 的就補正
    const fix = (r) => { const x = String(r ?? '').trim().replace(/^\.?\//, ''); return snapshot.has(x) ? x : snapshot.has(`${x}.md`) ? `${x}.md` : x; };
    const ops = (Array.isArray(it?.ops) ? it.ops : []).map((o) => ({
      ...o,
      ...(o.ref !== undefined && o.op !== 'create' ? { ref: fix(o.ref) } : {}),
      ...(Array.isArray(o.refs) ? { refs: o.refs.map(fix) } : {}),
      ...(o.into !== undefined ? { into: fix(o.into) } : {}),
    }));
    if (!ops.length) { dropped.push({ title, why: '沒有動作' }); continue; }
    if (ops.length > MAX_OPS) { dropped.push({ title, why: `一個項目最多 ${MAX_OPS} 個動作` }); continue; }
    if (ops.some((o) => o.op === 'merge' && (o.refs?.length ?? 0) > MAX_MERGE)) { dropped.push({ title, why: `一次最多合併 ${MAX_MERGE} 筆` }); continue; }
    if (ops.filter((o) => o.op === 'core').length > 1) { dropped.push({ title, why: '一個項目最多改一次核心準則' }); continue; }
    // 結構欄位要合乎格式（這些字串會原樣出現在審核員的提示詞裡，不能夾帶換行或偽造段落）
    const badField = ops.find((o) => (o.op === 'move' && !SCOPE_RE.test(String(o.to ?? ''))) || (o.op === 'create' && (!SCOPE_RE.test(String(o.scope ?? '')) || !NAME_RE.test(String(parseMemoryFile(String(o.content ?? '')).data?.name ?? '')))));
    if (badField) { dropped.push({ title, why: badField.op === 'create' && SCOPE_RE.test(String(badField.scope ?? '')) ? `新記憶的名稱格式不正確（要是 kebab-case 英數）：${one(parseMemoryFile(String(badField.content ?? '')).data?.name, 60)}` : `動作的範圍格式不正確：${one(badField.op === 'move' ? badField.to : badField.scope, 60)}` }); continue; }
    let bad = null;
    for (const o of ops) {
      if (o.op === 'core' && !allowCore) { bad = '這個任務不能改核心準則'; break; }
      for (const r of refsOfOp(o)) {
        const s = snapshot.get(r);
        if (!s) { bad = `沒有讀過全文的記憶：${r}`; break; }
        if (s.redacted && o.op !== 'move' && o.op !== 'remove' && o.op !== 'verify') { bad = `${r} 含疑似金鑰，不能改寫`; break; }
      }
      if (bad) break;
      if (o.op === 'move' && o.to === 'machine') o.to = `machine:${mid}`;
      // 這一輪可以改的範圍（來源與目的地都要）：主機處理共用範圍，各台處理自己的單機記憶
      const scopes = [...refsOfOp(o).map(scopeKeyOfRef), ...(o.op === 'move' ? [o.to] : []), ...(o.op === 'create' ? [o.scope === 'machine' ? `machine:${mid}` : o.scope] : [])];
      const di = scopes.findIndex((k) => !k || !writable(k));
      if (di >= 0) { bad = `這台電腦這一輪不處理「${one(scopes[di] ?? '不明的範圍', 60)}」`; break; }
      if (typeof o.content === 'string') o.content = o.content.replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
    }
    if (bad) { dropped.push({ title, why: bad }); continue; }
    const creates = ops.every((o) => o.op === 'create');
    const ref = creates ? null : ((it.ref ? fix(it.ref) : '') || refsOfOp(ops[0])[0] || null);
    if (ref && !snapshot.has(ref)) { dropped.push({ title, why: `沒有讀過全文的記憶：${ref}` }); continue; }
    items.push({
      ref,
      action: String(it.action ?? 'update'),
      group: String(it.group ?? '').slice(0, 40),
      title,
      reason: String(it.reason ?? '').trim().slice(0, 4000) || '（沒有理由）',
      cards: Array.isArray(it.cards) ? it.cards.map(String).slice(0, 20) : [],
      ...(Array.isArray(it.evidence) ? { evidence: it.evidence.slice(0, 6) } : {}),
      ops,
    });
  }
  return { items, dropped };
}

/** 對話回顧的引句是不是出自【使用者】的段落（寫進全域、單機要有這種證據） */
export function quoteFromUser(transcript, quote) {
  const flat = (t) => String(t ?? '').replace(/\s+/g, '');
  const q = flat(quote);
  // 太短的引句（例如一個標點、一兩個字）幾乎一定找得到，不算證據
  if (q.length < 10 || !transcript) return false;
  // 依段落標頭切開：【使用者 …】、【Claude】。工具呼叫（  → ）與工具結果（  ← ）沒有自己的標頭，
  // 會接在前一個段落後面（包括使用者的段落）：使用者說的話只到第一個工具行為止，之後的是工具結果，不算
  const blocks = String(transcript).split(/^(?=【(?:使用者|Claude)[^】\n]*】\s*$|# 對話紀錄 )/m);
  return blocks.some((b) => {
    if (!b.startsWith('【使用者')) return false;
    const lines = b.split('\n').slice(1);
    const end = lines.findIndex((l) => /^\s*[→←]/.test(l));
    return flat((end < 0 ? lines : lines.slice(0, end)).join('\n')).includes(q);
  });
}

/** 審核員：逐批送審，回傳 Map(id → { verdict, reason, lostFacts }) */
async function review(call, candidates) {
  const out = new Map();
  let batch = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const r = await call('審核', { schema: REVIEW_SCHEMA, prompt: reviewPrompt(batch) });
    for (const c of batch) {
      const v = r.ok ? (r.data.verdicts ?? []).find((x) => String(x.id) === c.id) : null;
      out.set(c.id, v ? { verdict: v.verdict === 'approve' ? 'approve' : 'reject', reason: String(v.reason ?? '').slice(0, 500), lostFacts: (Array.isArray(v.lostFacts) ? v.lostFacts : v.lostFacts ? [v.lostFacts] : []).map(String).slice(0, 10) }
        : { verdict: 'reject', reason: r.ok ? '審核員沒有回覆這一項' : `審核失敗：${r.error?.message ?? ''}`.slice(0, 300) });
    }
    batch = [];
    size = 0;
  };
  for (const c of candidates) {
    const n = JSON.stringify(c).length;
    if (size + n > REVIEW_BATCH_CHARS && batch.length) await flush();
    batch.push(c);
    size += n;
  }
  await flush();
  return out;
}

const describeOps = (ops) => one(ops.map((o) => (o.op === 'move' ? `move ${o.ref} → ${o.to}` : o.op === 'merge' ? `merge ${o.refs?.join(' + ')} → ${o.into}` : o.op === 'create' ? `create ${o.scope}` : `${o.op} ${o.ref ?? ''}`)).join('；'), 600);

/** 新內容（create 時從 content 的 name 推出 ref） */
function afterOf(item, snapshot, mid) {
  const after = [];
  for (const o of item.ops) {
    if (o.op === 'write' || o.op === 'core') after.push({ ref: o.ref ?? CORE_REF, text: o.content });
    else if (o.op === 'merge') after.push({ ref: o.into, text: o.content });
    else if (o.op === 'create') {
      const name = one(parseMemoryFile(o.content ?? '').data?.name ?? 'new', 80);
      const sc = String(o.scope ?? '');
      const dir = sc === 'global' ? 'global' : sc.startsWith('project:') ? `projects/${sc.slice(8)}/memory` : `machines/${mid}`;
      after.push({ ref: `${dir}/${name}.md`, text: o.content });
    } else if (o.op === 'remove') after.push({ ref: o.ref, text: null });
    else if (o.op === 'move') after.push({ ref: one(`${o.to}：${o.ref}`, 200), text: snapshot.get(o.ref)?.shown });
  }
  return after;
}

/**
 * 護欄＋審核＋上限 → 決定哪些項目執行。回傳 { approved, rejected }（rejected 附原因，寫進執行紀錄）。
 * opts：{ dream?: { transcript }, paused: string[], cap: number, mid }
 */
export async function screen(call, items, snapshot, { dream = null, paused = [], cap, mid }) {
  const approved = [];
  const rejected = [];
  const candidates = [];
  const shownOf = (r) => snapshot.get(r)?.shown ?? '';
  for (const [k, it] of items.entries()) {
    it.id = `c${k + 1}`;
    for (const o of it.ops) if (o.op === 'write' && snapshot.has(o.ref)) o.before = snapshot.get(o.ref).shown;
    it.risk = riskOf(it, scopeKeyOfRef);
    it.category = categoryOf(it, { dream: !!dream });
    it.cost = costOf(it);
    // 指令型內容：一般只看新增的行；擴大到每次都會載入的範圍（寫進全域、單機、核心準則，或搬、合併進去）時整份都看，
    // 否則專案記憶裡原本就有的惡意行會被當成「不是新增」而一路擴散到全域
    const flags = [];
    const add = (list) => { for (const f of list) if (!flags.includes(f)) flags.push(f); };
    for (const o of it.ops) {
      const into = o.op === 'move' ? o.to : o.op === 'create' ? (o.scope === 'machine' ? 'machine:' : o.scope) : o.op === 'core' ? 'core' : scopeKeyOfRef(o.op === 'merge' ? o.into ?? o.refs?.[0] : o.ref);
      const widen = SHARED(into);
      if (o.op === 'move') { add(instructionFlags(shownOf(o.ref), widen ? '' : shownOf(o.ref))); continue; }
      if (typeof o.content !== 'string') continue;
      const prev = widen ? '' : o.op === 'write' ? shownOf(o.ref) : o.op === 'merge' ? (o.refs ?? []).map(shownOf).join('\n') : '';
      add(instructionFlags(o.content, prev));
    }
    it.flags = flags;
    const pausedCat = categoriesOf(it, { dream: !!dream }).find((c) => paused.includes(c));
    if (pausedCat) { rejected.push({ ...brief(it), why: `「${pausedCat}」類的處理被你復原過多次，暫停中` }); continue; }
    // 核心準則每次對話都會載入：一輪新增的內容有上限
    for (const coreOp of it.ops.filter((o) => o.op === 'core')) {
      const added = addedLines(coreOp.content, shownOf(CORE_REF));
      if (added.length > CORE_ADD_LINES || added.join('\n').length > CORE_ADD_CHARS) { it.coreTooBig = added.length; break; }
    }
    if (it.coreTooBig !== undefined) { rejected.push({ ...brief(it), why: `核心準則一輪最多新增 ${CORE_ADD_LINES} 行、${CORE_ADD_CHARS} 字（這次 ${it.coreTooBig} 行）` }); continue; }
    if (dream) {
      // 對話回顧只能把記憶搬到全域、單機或這個專案
      if (it.ops.some((o) => o.op === 'move' && String(o.to).startsWith('project:') && o.to !== `project:${dream.pid}`)) { rejected.push({ ...brief(it), why: '對話回顧不能把記憶搬到其他專案' }); continue; }
      // 碰到每次都會載入的範圍（寫入、新增、搬入，或封存、合併、搬走全域與單機的記憶），要有使用者自己說的話當證據
      const touchesShared = targetScopes(it).some(SHARED);
      for (const e of it.evidence ?? []) e.fromUser = quoteFromUser(dream.transcript, e.quote);
      if (touchesShared && !(it.evidence ?? []).some((e) => e.fromUser)) { rejected.push({ ...brief(it), why: '動到全域或單機的記憶，但證據裡沒有使用者自己說的話' }); continue; }
    }
    if (it.risk === 'low' && !flags.length) { approved.push(it); continue; }
    candidates.push(it);
  }
  if (candidates.length) {
    const verdicts = await review(call, candidates.map((it) => ({
      id: it.id, action: it.action, title: it.title, reason: it.reason, risk: it.risk, flags: it.flags, evidence: it.evidence, ops: describeOps(it.ops),
      before: [...new Set(it.ops.flatMap(refsOfOp))].map((r) => ({ ref: r, text: snapshot.get(r)?.shown })),
      after: afterOf(it, snapshot, mid),
    })));
    for (const it of candidates) {
      const v = verdicts.get(it.id);
      it.review = v;
      // 審核員同意但列出會遺失的事實：不執行
      if (v?.verdict === 'approve' && !v.lostFacts?.length) approved.push(it);
      else rejected.push({ ...brief(it), why: `審核員沒有同意：${v?.reason ?? ''}${v?.lostFacts?.length ? `（會遺失：${v.lostFacts.join('；')}）` : ''}` });
    }
  }
  // 上限（以實際動到的記憶數計）：處理卡片的優先，其次風險低的
  const rank = { low: 0, medium: 1, high: 2 };
  approved.sort((a, b) => (b.cards?.length ? 1 : 0) - (a.cards?.length ? 1 : 0) || rank[a.risk] - rank[b.risk]);
  const keep = [];
  let used = 0;
  for (const it of approved) {
    if (used + it.cost <= cap) { keep.push(it); used += it.cost; } else rejected.push({ ...brief(it), why: '超過這一輪的上限，下一輪再處理', deferred: true });
  }
  return { approved: keep, rejected };
}

/** 一個項目碰到的所有範圍（來源與目的地） */
function targetScopes(it) {
  const out = new Set();
  for (const o of it.ops) {
    if (o.op === 'create') out.add(o.scope === 'machine' ? 'machine:' : o.scope);
    else if (o.op === 'move') { out.add(o.to); out.add(scopeKeyOfRef(o.ref)); } else if (o.op === 'core') out.add('core');
    else for (const r of refsOfOp(o)) out.add(scopeKeyOfRef(r));
  }
  return [...out].filter(Boolean);
}

const brief = (it) => ({ title: it.title, reason: it.reason, action: it.action, category: it.category, risk: it.risk, refs: [...new Set(it.ops.flatMap(refsOfOp))] });

/**
 * 把通過的項目寫成計畫、建立整理記錄（驗證不過的剔除後重試）、自動採用並執行。
 * @returns {{ record: string|null, results: object[], invalid: object[] }}
 */
export async function commitItems(eg, { items, scopeKey, summary, dir, task, runId, dream = null, skipped = [], onRecord }) {
  const invalid = [];
  let list = items.slice();
  await fsp.mkdir(dir, { recursive: true });
  for (let attempt = 0; attempt < 5 && list.length; attempt++) {
    const plan = { scope: scopeKey, summary: summary.slice(0, 1000) || '自動駕駛', items: [], ...(dream ? { dream: dream.id, skipped } : {}) };
    for (const [n, it] of list.entries()) {
      const ops = [];
      for (const [k, o] of it.ops.entries()) {
        const op = { op: o.op };
        if (o.ref) op.ref = o.ref;
        if (o.op === 'move') op.to = o.to;
        if (o.op === 'create') op.scope = o.scope === 'machine' ? 'machine' : o.scope;
        if (o.op === 'merge') { op.refs = o.refs; op.into = o.into ?? o.refs?.[0]; }
        if (typeof o.content === 'string' && o.op !== 'verify' && o.op !== 'move' && o.op !== 'remove') {
          const f = `i${n + 1}-${k + 1}.md`;
          await fsp.writeFile(path.join(dir, f), o.content, 'utf8');
          op.file = f;
        }
        ops.push(op);
      }
      plan.items.push({ ...(it.ref ? { ref: it.ref } : {}), action: it.action === 'core' ? 'update' : it.action, group: it.group || undefined, title: it.title, reason: it.reason, ...(it.evidence ? { evidence: it.evidence.map((e) => ({ quote: String(e.quote ?? '').slice(0, 600), ...(e.session ? { session: String(e.session).slice(0, 80) } : {}), ...(e.date ? { date: String(e.date).slice(0, 10) } : {}), ...(typeof e.contradicts === 'boolean' ? { contradicts: e.contradicts } : {}) })) } : {}), ops });
    }
    // 版本：第一次處理一筆記憶時要帶。由引擎依 LLM 讀到的內容填上（snapshot 的 rev 已放在 o.base）
    for (const [n, it] of list.entries()) for (const [k, o] of it.ops.entries()) {
      const p = plan.items[n].ops[k];
      if (o.op === 'merge') p.bases = o.bases;
      else if (o.base) p.base = o.base;
    }
    const file = path.join(dir, `plan-${attempt}.json`);
    await fsp.writeFile(file, JSON.stringify(plan, null, 1), 'utf8');
    let rec;
    try {
      rec = await createFromPlan(eg, file, { autopilot: { run: runId, task } });
    } catch (err) {
      if (err?.code !== 'E_INVALID' || !Array.isArray(err.details)) throw err;
      const bad = new Set();
      let fatal = null;
      for (const e of err.details) {
        const m = /^第 (\d+) 項/.exec(e);
        if (m) bad.add(Number(m[1]) - 1);
        else if (!/^kept/.test(e)) fatal = e;
      }
      if (fatal || !bad.size) throw Object.assign(new Error(`整理計畫驗證失敗：${fatal ?? err.message}`), { code: 'E_INVALID' });
      for (const i of [...bad].sort((a, b) => b - a)) {
        const it = list[i];
        invalid.push({ ...brief(it), why: err.details.filter((e) => e.startsWith(`第 ${i + 1} 項`)).join('；').slice(0, 600) });
        list.splice(i, 1);
      }
      continue;
    }
    await onRecord?.(rec.id);
    // 自動採用：全部 accept → 產生執行指令 → 執行
    await setDecisions(eg.paths.local, rec.id, Object.fromEntries(rec.items.map((x) => [x.id, { decision: 'accept' }])));
    await updateRecord(eg.paths.local, rec.id, (r) => {
      for (const [n, x] of r.items.entries()) {
        const it = list[n];
        x.autopilot = { risk: it.risk, category: it.category, cards: it.cards ?? [], ...(it.flags?.length ? { flags: it.flags } : {}), ...(it.review ? { review: it.review } : {}) };
      }
    });
    await markReady(eg.paths.local, rec.id);
    // 寫進每次都會載入的範圍時不記為「使用者確認過」：下一輪的「待你確認」把關會再看一次
    const res = await applyRecord(eg, rec.id, { reviewed: false });
    const results = res.record.items.map((x, n) => ({ record: rec.id, item: x.id, title: x.title, reason: x.reason, action: x.action, category: list[n]?.category, risk: list[n]?.risk, cost: list[n]?.cost ?? 1, cards: list[n]?.cards ?? [], refs: [...new Set((list[n]?.ops ?? []).flatMap(refsOfOp))], review: list[n]?.review ?? null, status: x.result?.status ?? 'unknown', undo: x.result?.undo ?? [], ...(x.result?.message ? { message: x.result.message } : {}) }));
    return { record: rec.id, results, invalid };
  }
  return { record: null, results: [], invalid };
}

/** 依 snapshot 補上版本 */
export function fillBases(items, snapshot) {
  for (const it of items) {
    const seen = new Set();
    for (const o of it.ops) {
      if (o.op === 'merge') {
        o.bases = (o.refs ?? []).map((r) => (seen.has(r) ? null : snapshot.get(r)?.rev ?? null));
        (o.refs ?? []).forEach((r) => seen.add(r));
      } else if (o.op !== 'create') {
        const r = o.op === 'core' ? CORE_REF : o.ref;
        if (r && !seen.has(r)) o.base = snapshot.get(r)?.rev;
        if (r) seen.add(r);
        if (o.op === 'core') o.ref = CORE_REF;
      }
    }
  }
  return items;
}
