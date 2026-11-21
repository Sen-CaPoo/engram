// 自動駕駛的共用流程（1.5.0）：LLM 呼叫（含預算）、把 LLM 提出的項目變成整理記錄並執行。
//
// 每一項依序經過：
//   1. 只准動 LLM 看過全文的記憶（snapshot），版本（base）由引擎依當時讀到的內容填上
//   2. 護欄：指令型內容檢查、風險分級、被復原太多次而暫停的類別、對話回顧寫進全域／單機要有使用者說的話當證據
//   3. 中、高風險或有可疑處 → 審核員（第二次 LLM 呼叫）；不同意或審核失敗 → 不執行
//   4. 一輪最多改動的記憶筆數（安全上限，與金額無關；1.6.0 拿掉的是每輪的金額上限）
// 通過的項目寫成整理計畫，交給既有的 createFromPlan 驗證（金鑰、版本、釘選、格式、同名），
// 驗證不過的項目剔除後重試，再自動採用並 applyRecord（備份、逐步記錄、可逐項復原）。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../cli/fsutil.mjs';
import { revOf } from '../cli/commands/safe.mjs';
import { scopeOfRef } from '../core/memories.mjs';
import { parseMemoryFile } from '../core/frontmatter.mjs';
import { applyRecord } from '../tidy/apply.mjs';
import { createFromPlan, CORE_REF } from '../tidy/plan.mjs';
import { markReady, setDecisions, updateRecord } from '../tidy/store.mjs';
import { charge } from './budget.mjs';
import { CORE_ADD_CHARS, CORE_ADD_LINES, MAX_MERGE, MAX_OPS, SHARED, addedLines, categoriesOf, categoryOf, costOf, crossSplits, instructionFlags, isSplit, riskOf, shrunk } from './guard.mjs';
import { opsFingerprint } from '../core/holding.mjs';

/** 程式偵測到改寫後內文大幅變短時的旗標（審核員的提示詞也用這個字） */
export const SHRINK_FLAG = '大幅刪減';

const SCOPE_RE = /^(global|machine(:[a-z0-9][a-z0-9-]{0,63})?|project:[a-z0-9][a-z0-9-]{0,63})$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const one = (t, max = 200) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
import { MODELS } from './llm.mjs';
import { REVIEW_SCHEMA, reviewPrompt } from './prompts.mjs';

const MAX_PROMPT_CHARS = 400_000;
const REVIEW_BATCH_CHARS = 120_000;

export const keyOfScope = (sc) => (!sc ? null : sc.kind === 'project' ? `project:${sc.pid}` : sc.kind === 'machine' ? `machine:${sc.mid}` : sc.kind);
export const scopeKeyOfRef = (ref) => (ref === CORE_REF ? 'core' : keyOfScope(scopeOfRef(ref)));

const STOPPED_MESSAGE = { budget: '這個月的預算用完了', cancelled: '這一輪已停止', auth: 'Claude Code 的登入已到期，請重新登入', limit: '已達 Claude 的用量上限', busy: 'Claude 暫時忙碌（過載或速率限制）' };
const STOP_CODES = { E_LLM_LIMIT: 'limit', E_LLM_AUTH: 'auth', E_LLM_BUSY: 'busy' };

/**
 * LLM 呼叫器：記帳、本月剩下的預算（budgetUsd，1.6.0 起沒有每輪上限）、用量上限時停止後續呼叫。
 * 2.0.0：登入失效（E_LLM_AUTH）與暫時性的忙碌（E_LLM_BUSY）也停止整輪；state.message 留下停止時的訊息（解析用量上限的重置時間用）。
 * 每次呼叫另有 US$3 的上限（--max-budget-usd），避免單次呼叫失控。
 * @returns {(label, { model?, schema, prompt }) => Promise<{ ok, data?, error? }>}
 */
export function createCaller({ judge, local, run, budgetUsd, log, signal }) {
  const state = { spent: 0, stopped: null, message: '' };
  const call = async (label, { model = MODELS.main, schema, prompt }) => {
    if (signal?.aborted) state.stopped = 'cancelled';
    if (state.stopped) return { ok: false, error: { code: 'E_STOPPED', message: STOPPED_MESSAGE[state.stopped] ?? STOPPED_MESSAGE.limit } };
    if (budgetUsd - state.spent < 0.3) { state.stopped = 'budget'; return { ok: false, error: { code: 'E_STOPPED', message: '這個月的預算用完了' } }; }
    if (prompt.length > MAX_PROMPT_CHARS) return { ok: false, error: { code: 'E_TOO_LARGE', message: `內容太長（${prompt.length} 字），這次略過` } };
    const r = await judge({ model, schema, prompt, signal, maxBudgetUsd: Math.max(0.5, Math.min(3, budgetUsd - state.spent)) });
    if (signal?.aborted) state.stopped = 'cancelled';
    state.spent += r.usage?.costUsd ?? 0;
    await charge(local, model, r.usage).catch(() => {});
    // task：這次呼叫屬於哪一種工作（run.mjs 的每一步設定 state.task；2.0.0 Q7 執行紀錄的 summary.callsByTask 用）
    run.calls.push({ task: state.task ?? 'other', label, model, ms: r.ms ?? 0, input: r.usage?.input ?? 0, output: r.usage?.output ?? 0, costUsd: r.usage?.costUsd ?? 0, ok: r.ok, ...(r.ok ? {} : { error: r.error?.message?.slice(0, 300) }) });
    if (!r.ok && STOP_CODES[r.error?.code]) {
      state.stopped = STOP_CODES[r.error.code];
      state.message = String(r.error.message ?? '');
    }
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
 * 證據只留認得的欄位。fromUser、context 由程式產生（對話回顧比對引句、存進保留區時擷取上下文），
 * 只有從保留區重審時（keepEvidence）才沿用，LLM 自己填的一律不算。
 */
function cleanEvidence(list, keepEvidence) {
  return list.slice(0, 6).filter((e) => e && typeof e === 'object').map((e) => ({
    quote: String(e.quote ?? ''),
    ...(e.session !== undefined ? { session: String(e.session) } : {}),
    ...(e.date !== undefined ? { date: String(e.date) } : {}),
    ...(typeof e.contradicts === 'boolean' ? { contradicts: e.contradicts } : {}),
    ...(keepEvidence ? { fromUser: e.fromUser === true, ...(typeof e.context === 'string' && e.context ? { context: e.context } : {}) } : {}),
  }));
}

/**
 * 把 LLM 的項目整理成計畫項目；只准動 snapshot 裡有全文的記憶。
 * 2.0.0：只因為「這台電腦這一輪不處理這個範圍」而剔除的項目，dropped 裡附上整理好的項目（crossScope、item），呼叫端存進保留區。
 * @returns {{ items: object[], dropped: { title, why, crossScope?, item? }[] }}
 */
export function normalizeItems(raw, snapshot, { allowCore = false, mid, writable = () => true, keepEvidence = false } = {}) {
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
    let outside = null;
    for (const o of ops) {
      if (o.op === 'core' && !allowCore) { bad = '這個任務不能改核心準則'; break; }
      for (const r of refsOfOp(o)) {
        const s = snapshot.get(r);
        if (!s) { bad = `沒有讀過全文的記憶：${r}`; break; }
        if (s.redacted && o.op !== 'move' && o.op !== 'remove' && o.op !== 'verify') { bad = `${r} 含疑似金鑰，不能改寫`; break; }
      }
      if (bad) break;
      if (o.op === 'move' && o.to === 'machine') o.to = `machine:${mid}`;
      // 這一輪可以改的範圍（來源與目的地都要）：由呼叫端決定（共用範圍每台都能改，別台的單機記憶不能改）
      // 2.0.0：範圍不行時先記下、繼續檢查其他動作；整項只有這個問題時存進保留區（cross-scope），輪到能處理的那一輪再審
      const scopes = [...refsOfOp(o).map(scopeKeyOfRef), ...(o.op === 'move' ? [o.to] : []), ...(o.op === 'create' ? [o.scope === 'machine' ? `machine:${mid}` : o.scope] : [])];
      const di = scopes.findIndex((k) => !k || !writable(k));
      if (di >= 0 && !outside) outside = `這台電腦這一輪不處理「${one(scopes[di] ?? '不明的範圍', 60)}」`;
      if (typeof o.content === 'string') o.content = o.content.replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
    }
    if (bad) { dropped.push({ title, why: bad }); continue; }
    const creates = ops.every((o) => o.op === 'create');
    const ref = creates ? null : ((it.ref ? fix(it.ref) : '') || refsOfOp(ops[0])[0] || null);
    if (ref && !snapshot.has(ref)) { dropped.push({ title, why: `沒有讀過全文的記憶：${ref}` }); continue; }
    const item = {
      ref,
      action: String(it.action ?? 'update'),
      group: String(it.group ?? '').slice(0, 40),
      title,
      reason: String(it.reason ?? '').trim().slice(0, 4000) || '（沒有理由）',
      cards: Array.isArray(it.cards) ? it.cards.map(String).slice(0, 20) : [],
      ...(Array.isArray(it.evidence) ? { evidence: cleanEvidence(it.evidence, keepEvidence) } : {}),
      ops,
    };
    if (outside) { dropped.push({ title, why: outside, crossScope: true, item }); continue; }
    items.push(item);
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

/** 審核員：逐批送審，回傳 Map(id → { verdict: 'approve'|'reject'|'trim', reason, lostFacts, keep? }) */
async function review(call, candidates, preferences = '') {
  const out = new Map();
  let batch = [];
  let size = 0;
  const list = (x) => (Array.isArray(x) ? x : x ? [x] : []).map(String).slice(0, 10);
  const flush = async () => {
    if (!batch.length) return;
    const r = await call('審核', { schema: REVIEW_SCHEMA, prompt: reviewPrompt(batch, { preferences }) });
    for (const c of batch) {
      const v = r.ok ? (r.data.verdicts ?? []).find((x) => String(x.id) === c.id) : null;
      // 2.0.0 Q4：trim＝核心事實有依據、細節沒有依據（keep 是有依據的部分）；其他看不懂的判斷都當成不同意
      const verdict = v?.verdict === 'approve' || v?.verdict === 'trim' ? v.verdict : 'reject';
      // failed：審核員沒有給判斷（呼叫失敗、預算用完、被停止、漏回這一項）——不是不同意，下一輪要再審
      out.set(c.id, v ? { verdict, reason: String(v.reason ?? '').slice(0, 500), lostFacts: list(v.lostFacts), ...(verdict === 'trim' ? { keep: list(v.keep).map((k) => k.slice(0, 300)) } : {}) }
        : { verdict: 'reject', failed: true, reason: r.ok ? '審核員沒有回覆這一項' : `審核失敗：${r.error?.message ?? ''}`.slice(0, 300) });
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
    // 2.0.0 WP9 記憶畢業：新增的護欄規則、環境設定原樣給審核員看；原記憶只在 frontmatter 記下去向
    else if (o.op === 'guardrail') after.push({ ref: 'guardrails/rules.json（新增一條提醒規則）', text: o.content });
    else if (o.op === 'env') after.push({ ref: 'env/profile.json（新增一項環境設定）', text: o.content });
    else if (o.op === 'graduate') after.push({ ref: o.ref, text: o.content });
  }
  return after;
}

/**
 * 護欄＋審核＋上限 → 決定哪些項目執行。回傳 { approved, rejected }（rejected 附原因，寫進執行紀錄）。
 * opts：{ dream?: { pid, transcript }, paused: string[], cap: number, roundCap?: number, mid, hold?, preferences? }（preferences：使用者的偏好，給審核員看）
 * - cap 是這一輪還剩下的改動筆數（放不下的延後）；roundCap 是一整輪的上限：一項就超過它的，哪一輪都放不下，存進保留區（2.0.0）
 * - dismissed：使用者在保留區標成「不需要」的提案指紋（opsFingerprint，90 天內；第二輪審查 R6），同樣的提案直接略過
 * - dream.transcript 是 null（從保留區重審，原對話已經清掉）時，沿用存下來的 fromUser（當初由程式比對對話得出）
 * - hold(item, why)：2.0.0，拒絕而且不是延後的項目交給它（存進保留區），回傳的編號記在 rejected 的 holding；
 *   存不進去時改成延後（不能讓提案就此消失）
 * - memoryNames(scopeKeys)：2.0.0 Q4，回傳 { 範圍: [現有記憶的名稱] }，給審核員確認提到的記憶存在（memoryNamesOf）
 * - 審核員回覆 trim（核心事實有依據、細節沒有依據）時：不執行，rejected 帶 grounded: true 與 keep，item 也標上，hold 存進保留區
 */
export async function screen(call, items, snapshot, { dream = null, paused = [], cap, roundCap, mid, hold = null, preferences = '', memoryNames = null, dismissed = null }) {
  const approved = [];
  const rejected = [];
  const candidates = [];
  const toHold = [];
  const reject = (it, why, extra = {}) => {
    const e = { ...brief(it), why, ...extra };
    rejected.push(e);
    if (!extra.deferred) toHold.push({ it, e });
  };
  const shownOf = (r) => snapshot.get(r)?.shown ?? '';
  for (const [k, it] of items.entries()) {
    it.id = `c${k + 1}`;
    // 對話回顧的引句是否出自使用者：先算好（之後任何一個關卡拒絕，存進保留區的也是程式比對的結果）
    if (dream) for (const e of it.evidence ?? []) e.fromUser = typeof dream.transcript === 'string' ? quoteFromUser(dream.transcript, e.quote) : e.fromUser === true;
    for (const o of it.ops) if (o.op === 'write' && snapshot.has(o.ref)) o.before = snapshot.get(o.ref).shown;
    it.risk = riskOf(it, scopeKeyOfRef);
    it.category = categoryOf(it, { dream: !!dream });
    it.cost = costOf(it);
    // 指令型內容：一般只看新增的行；擴大到每次都會載入的範圍（寫進全域、單機、核心準則，或搬、合併進去）時整份都看，
    // 否則專案記憶裡原本就有的惡意行會被當成「不是新增」而一路擴散到全域
    const flags = [];
    const add = (list) => { for (const f of list) if (!flags.includes(f)) flags.push(f); };
    for (const o of it.ops) {
      // 記憶畢業記下去向（graduate）：內文沒變，只多了 frontmatter 的兩個欄位；新增的護欄規則與環境設定（guardrail、env）整段都看
      if (o.op === 'graduate') continue;
      const into = o.op === 'move' ? o.to : o.op === 'create' ? (o.scope === 'machine' ? 'machine:' : o.scope) : o.op === 'core' ? 'core' : scopeKeyOfRef(o.op === 'merge' ? o.into ?? o.refs?.[0] : o.ref);
      const widen = SHARED(into);
      if (o.op === 'move') { add(instructionFlags(shownOf(o.ref), widen ? '' : shownOf(o.ref))); continue; }
      if (typeof o.content !== 'string') continue;
      const prev = widen ? '' : o.op === 'write' ? shownOf(o.ref) : o.op === 'merge' ? (o.refs ?? []).map(shownOf).join('\n') : '';
      add(instructionFlags(o.content, prev));
      // 2.0.0：改寫後內文比原本短 30% 以上：一定送審核員，提醒逐一確認被拿掉的內容
      if (o.op === 'write' && snapshot.has(o.ref) && shrunk(shownOf(o.ref), o.content)) add([SHRINK_FLAG]);
    }
    it.flags = flags;
    // 2.0.0 第二輪審查 R6：使用者在保留區標成「不需要」的同一個提案（90 天內）：略過，不送審、不執行、不再存進保留區
    if (dismissed?.has(opsFingerprint(it.ops, mid))) { rejected.push({ ...brief(it), why: DISMISSED_WHY.zh, en: { why: DISMISSED_WHY.en }, dismissed: true }); continue; }
    // 2.0.0：依使用者的偏好不拆分記憶
    if (isSplit(it, shownOf)) { reject(it, '依使用者的偏好不拆分記憶'); continue; }
    const pausedCat = categoriesOf(it, { dream: !!dream }).find((c) => paused.includes(c));
    if (pausedCat) { reject(it, `「${pausedCat}」類的處理被你復原過多次，暫停中`); continue; }
    // 核心準則每次對話都會載入：一輪新增的內容有上限
    for (const coreOp of it.ops.filter((o) => o.op === 'core')) {
      const added = addedLines(coreOp.content, shownOf(CORE_REF));
      if (added.length > CORE_ADD_LINES || added.join('\n').length > CORE_ADD_CHARS) { it.coreTooBig = added.length; break; }
    }
    if (it.coreTooBig !== undefined) { reject(it, `核心準則一輪最多新增 ${CORE_ADD_LINES} 行、${CORE_ADD_CHARS} 字（這次 ${it.coreTooBig} 行）`); continue; }
    if (dream) {
      // 對話回顧只能把記憶搬到全域、單機或這個專案
      if (it.ops.some((o) => o.op === 'move' && String(o.to).startsWith('project:') && o.to !== `project:${dream.pid}`)) { reject(it, '對話回顧不能把記憶搬到其他專案'); continue; }
      // 碰到每次都會載入的範圍（寫入、新增、搬入，或封存、合併、搬走全域與單機的記憶），要有使用者自己說的話當證據
      const touchesShared = !it.ops.every((o) => o.op === 'verify') && targetScopes(it).some(SHARED);
      if (touchesShared && !(it.evidence ?? []).some((e) => e.fromUser)) { reject(it, '動到全域或單機的記憶，但證據裡沒有使用者自己說的話'); continue; }
    }
    // 2.0.0：一項動到的記憶數超過一整輪的上限，哪一輪都放不下：不送審、不延後，存進保留區留給使用者
    if (Number.isFinite(roundCap) && it.cost > roundCap) { reject(it, `超過自動處理的範圍，留給你決定（一輪最多改動 ${roundCap} 筆記憶，這一項動到 ${it.cost} 筆）`); continue; }
    if (it.risk === 'low' && !flags.length) { approved.push(it); continue; }
    candidates.push(it);
  }
  // 2.0.0 第二輪審查 R5：拆到不同項目的拆分（一項新增、另一項封存或大幅刪減來源）：相關的項目一起拒絕，不送審
  const pool = [...approved, ...candidates];
  const split = new Set([...crossSplits(pool, shownOf)].map((i) => pool[i]));
  if (split.size) {
    for (const list of [approved, candidates]) for (let i = list.length - 1; i >= 0; i--) if (split.has(list[i])) list.splice(i, 1);
    for (const it of split) reject(it, '依使用者的偏好不拆分記憶（新增的內容來自另一個項目封存、合併掉或大幅刪減的記憶）');
  }
  if (candidates.length) {
    const verdicts = await review(call, candidates.map((it) => ({
      id: it.id, action: it.action, title: it.title, reason: it.reason, risk: it.risk, flags: it.flags, ops: describeOps(it.ops),
      evidence: (it.evidence ?? []).map(({ context, ...e }) => e),
      // 2.0.0 Q4：每則引句前後的對話（對話回顧當下從原文取；保留區重審時用存下來的那份）與相關範圍內現有記憶的名稱
      context: (it.evidence ?? []).map((e) => ({ quote: e.quote, text: typeof dream?.transcript === 'string' ? userContextOf(dream.transcript, e.quote) : (e.context ?? '') })).filter((x) => x.text),
      memoryNames: typeof memoryNames === 'function' ? memoryNames(namesScopes(it, mid)) : {},
      before: [...new Set(it.ops.flatMap(refsOfOp))].map((r) => ({ ref: r, text: snapshot.get(r)?.shown })),
      after: afterOf(it, snapshot, mid),
    })), preferences);
    for (const it of candidates) {
      const v = verdicts.get(it.id);
      it.review = v;
      // 審核員同意但列出會遺失的事實：不執行
      if (v?.verdict === 'approve' && !v.lostFacts?.length) approved.push(it);
      // 審核沒有完成（不是不同意）：標成延後，這個範圍不記為整理過，下一輪再審
      else if (!v || v.failed) reject(it, `審核沒有完成，下一輪再處理：${v?.reason ?? '審核失敗'}`, { deferred: true, reviewIncomplete: true });
      // 2.0.0 Q4：核心事實有依據、細節沒有依據：不執行（程式不自動刪改內容），存進保留區並註明，由使用者決定
      else if (v.verdict === 'trim') {
        it.grounded = true;
        it.keep = v.keep ?? [];
        reject(it, `核心事實有依據，但部分細節沒有依據，不執行：${v.reason}${it.keep.length ? `（有依據的部分：${it.keep.join('；')}）` : ''}`.slice(0, 1000), { grounded: true, keep: it.keep });
      } else reject(it, `審核員沒有同意：${v?.reason ?? ''}${v?.lostFacts?.length ? `（會遺失：${v.lostFacts.join('；')}）` : ''}`);
    }
  }
  // 上限（以實際動到的記憶數計）：處理卡片的優先，其次風險低的
  const rank = { low: 0, medium: 1, high: 2 };
  approved.sort((a, b) => (b.cards?.length ? 1 : 0) - (a.cards?.length ? 1 : 0) || rank[a.risk] - rank[b.risk]);
  const keep = [];
  let used = 0;
  for (const it of approved) {
    if (used + it.cost <= cap) { keep.push(it); used += it.cost; } else reject(it, '超過這一輪最多改動的記憶筆數，下一輪再處理', { deferred: true });
  }
  // 沒有執行的提案連同完整內容存進保留區（2.0.0）
  if (hold) {
    for (const { it, e } of toHold) {
      try {
        const hid = await hold(it, e.why);
        if (hid) e.holding = hid;
      } catch (err) {
        e.deferred = true;
        e.why = `${e.why}（存進保留區失敗，下一輪再處理：${String(err?.message ?? err).slice(0, 200)}）`;
      }
    }
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

/** 審核員要看現有記憶名稱的範圍（2.0.0 Q4）：項目碰到的範圍；新增到「這台電腦」換成實際的範圍，核心準則看全域的名稱 */
function namesScopes(it, mid) {
  return [...new Set(targetScopes(it).map((k) => (k === 'machine:' || k === 'machine' ? `machine:${mid}` : k === 'core' ? 'global' : k)))];
}

/**
 * 現有記憶的名稱，依範圍分組（2.0.0 Q4，給 screen 的 memoryNames）：回傳 (scopeKeys) => { 範圍: [名稱] }。
 * 名稱是檔名（不含 .md）：[[名稱]] 連結用的就是它。
 */
export async function memoryNamesOf(eg) {
  const by = new Map();
  for (const m of await eg.memories.list().catch(() => [])) {
    const k = keyOfScope(m.scope);
    if (!k) continue;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(path.posix.basename(m.ref, '.md'));
  }
  for (const list of by.values()) list.sort();
  return (keys) => Object.fromEntries(keys.filter(Boolean).map((k) => [k, by.get(k) ?? []]));
}

/** 之前標成「不需要」而略過的原因（執行紀錄的 why；en.why 是英文介面用的） */
export const DISMISSED_WHY = {
  zh: '你之前在保留區把同一個提案標成「不需要」（90 天內），這次略過',
  en: 'You marked the same proposal as not needed in the holding area within the last 90 days, so it was skipped this time',
};

const brief = (it) => ({ title: it.title, reason: it.reason, action: it.action, category: it.category, risk: it.risk, refs: [...new Set(it.ops.flatMap(refsOfOp))], ...(it.holdingId ? { holding: it.holdingId } : {}) });

/**
 * 引句在對話文字裡的前後各約 n 字（2.0.0：存進保留區時擷取，原對話之後會被清掉）。
 * 引句與對話的空白、換行不一定一樣：去掉空白後比對，再對回原文的位置。找不到時回傳空字串。
 */
export function contextOf(transcript, quote, n = 600) {
  const t = String(transcript ?? '');
  const q = String(quote ?? '').replace(/\s+/g, '');
  if (!t || q.length < 4) return '';
  const chars = [];
  const pos = [];
  for (let i = 0; i < t.length; i++) if (!/\s/.test(t[i])) { chars.push(t[i]); pos.push(i); }
  const at = chars.join('').indexOf(q);
  if (at < 0) return '';
  return t.slice(Math.max(0, pos[at] - n), Math.min(t.length, pos[at + q.length - 1] + 1 + n));
}

/**
 * 只取【使用者】段落的上下文（審查 U1）：Claude 的回覆、工具呼叫（→）與工具結果（← 與它接著的行）都是外部可控的文字，
 * 不給審核員看。段落標頭（含時間）保留。引句不在使用者的段落裡時回傳空字串。
 */
export function userContextOf(transcript, quote, n = 600) {
  const out = [];
  let user = false;
  for (const line of String(transcript ?? '').split('\n')) {
    if (/^【使用者[^】\n]*】\s*$/.test(line)) { user = true; out.push(line); continue; }
    // Claude 的段落、下一份對話紀錄的開頭、工具呼叫與結果：之後到下一個使用者段落為止都不算（工具結果可能有好幾行）
    if (/^【Claude】\s*$/.test(line) || /^# 對話紀錄 /.test(line) || /^\s*[→←]/.test(line)) { user = false; continue; }
    if (user) out.push(line);
  }
  return contextOf(out.join('\n'), quote, n);
}

/**
 * 把沒有執行的項目連同完整的動作與證據存進保留區（2.0.0），回傳保留區編號（引擎沒有保留區時 null）。
 * o：{ task, pid?, kind?, why, transcript? }。對話回顧給 transcript：引句是否出自使用者由程式重新比對，每則再存前後的上下文。
 */
export async function holdItem(ctx, it, { task, pid = null, kind = 'rejected', why = '', transcript = null }) {
  const { eg, run, mid } = ctx;
  if (typeof eg.holding?.add !== 'function') return null;
  const dream = task === 'dream';
  const create = it.ops.find((o) => o.op === 'create');
  const scope = it.ref ? scopeKeyOfRef(it.ref) : create ? (create.scope === 'machine' ? `machine:${mid}` : create.scope) : null;
  const r = await eg.holding.add({
    task, pid, kind, run: run?.id, ref: it.ref ?? null, title: it.title, reason: it.reason, why,
    action: it.action, category: it.category ?? categoryOf(it, { dream }), risk: it.risk ?? riskOf(it, scopeKeyOfRef), scope, flags: it.flags ?? [],
    // 2.0.0 Q4：審核員認為核心事實有依據（trim），keep 是有依據的部分
    ...(it.grounded ? { grounded: true, keep: it.keep ?? [] } : {}),
    // 2.0.0 WP9：記憶畢業的提案（去向與要寫進去的內容），使用者採用時照這份執行
    ...(it.graduate ? { graduate: it.graduate } : {}),
    ops: it.ops.map((o) => ({
      op: o.op,
      ...(o.ref ? { ref: o.ref } : {}),
      ...(o.op === 'move' || o.op === 'graduate' ? { to: o.to } : {}),
      ...(o.op === 'create' ? { scope: o.scope === 'machine' ? `machine:${mid}` : o.scope } : {}),
      ...(o.op === 'merge' ? { refs: o.refs, into: o.into ?? o.refs?.[0], bases: o.bases ?? [] } : {}),
      ...(o.base ? { base: o.base } : {}),
      ...(typeof o.content === 'string' ? { content: o.content } : {}),
    })),
    evidence: (it.evidence ?? []).map((e) => ({
      quote: e.quote, session: e.session, date: e.date,
      fromUser: typeof transcript === 'string' ? quoteFromUser(transcript, e.quote) : false,
      ...(typeof transcript === 'string' ? { context: userContextOf(transcript, e.quote) } : {}),
    })),
  });
  // 第二輪審查 R6：使用者標成「不需要」的同一個提案：沒有新增，不算存進保留區
  if (r.dismissed) return null;
  run?.held?.push({ id: r.id, title: it.title, kind, ...(r.local ? { local: true } : {}), ...(r.merged ? { merged: true } : {}) });
  return r.id;
}

/**
 * normalizeItems 剔除的項目寫進執行紀錄（entry 是共同欄位，例如 { task, scope }）；只因為範圍而剔除的存進保留區（cross-scope）。
 * 回傳有沒有存失敗的：失敗時呼叫端當成延後（不把這批記為處理過），提案不能就此消失。
 */
export async function recordDropped(ctx, dropped, snapshot, { entry, task, pid = null, transcript = null }) {
  let failed = false;
  for (const d of dropped) {
    const e = { ...entry, title: d.title, why: d.why };
    if (d.crossScope) {
      try {
        fillBases([d.item], snapshot);
        const hid = await holdItem(ctx, d.item, { task, pid, kind: 'cross-scope', why: d.why, transcript });
        if (hid) e.holding = hid;
      } catch (err) {
        failed = true;
        e.why = `${d.why}（存進保留區失敗，下一輪再處理：${String(err?.message ?? err).slice(0, 200)}）`;
      }
    }
    ctx.run.rejected.push(e);
  }
  return failed;
}

/**
 * 自動駕駛寫進每次都會載入的範圍時，這一項要不要直接記為確認過（2.0.0 Q6）：審核員明確同意、而且沒有指令型的可疑處
 * （程式旗標裡只有「大幅刪減」的算沒有）。沒送審的（低風險）維持原狀，由「待你確認」把關。
 */
function autoConfirm(it) {
  return it?.review?.verdict === 'approve' && !it.review.failed && !(it.flags ?? []).some((f) => f !== SHRINK_FLAG) && targetScopes(it).some(SHARED);
}

/**
 * 把通過的項目寫成計畫、建立整理記錄（驗證不過的剔除後重試）、自動採用並執行。
 * results 的 confirmed: true（2.0.0 Q6）：這一項寫進每次都會載入的範圍、審核員同意過，已記為確認過（每週摘要列出）。
 * @returns {{ record: string|null, results: object[], invalid: object[] }}
 */
export async function commitItems(eg, { items, scopeKey, summary, dir, task, runId, dream = null, skipped = [], onRecord, hold = null }) {
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
        const e = { ...brief(it), why: err.details.filter((x) => x.startsWith(`第 ${i + 1} 項`)).join('；').slice(0, 600) };
        // 2.0.0：驗證不過的提案也存進保留區（hold 由呼叫端給），內容不會因為這一輪結束就消失
        if (hold) {
          try { const hid = await hold(it, e.why); if (hid) e.holding = hid; } catch (err2) { e.why = `${e.why}（存進保留區失敗：${String(err2?.message ?? err2).slice(0, 200)}）`; }
        }
        invalid.push(e);
        list.splice(i, 1);
      }
      continue;
    }
    // 第二個參數：每一項對應的整理記錄項目與保留區編號（保留區重審先記下來，執行完來不及標成採用就中斷時，下一輪認得是自己寫的）
    await onRecord?.(rec.id, list.map((it, n) => ({ item: rec.items[n]?.id ?? null, holding: it.holdingId ?? null })));
    // 自動採用：全部 accept → 產生執行指令 → 執行
    await setDecisions(eg.paths.local, rec.id, Object.fromEntries(rec.items.map((x) => [x.id, { decision: 'accept' }])));
    await updateRecord(eg.paths.local, rec.id, (r) => {
      for (const [n, x] of r.items.entries()) {
        const it = list[n];
        x.autopilot = { risk: it.risk, category: it.category, cards: it.cards ?? [], ...(it.flags?.length ? { flags: it.flags } : {}), ...(it.review ? { review: it.review } : {}) };
      }
    });
    await markReady(eg.paths.local, rec.id);
    // 寫進每次都會載入的範圍時，一般不記為「使用者確認過」：下一輪的「待你確認」把關會再看一次。
    // 2.0.0 Q6：審核員已經同意過的項目記為確認過（不必再審一次）；有指令型可疑處的仍留在待你確認（「大幅刪減」不算）
    const confirmed = new Set(rec.items.filter((x, n) => autoConfirm(list[n])).map((x) => x.id));
    const res = await applyRecord(eg, rec.id, { reviewed: false, reviewedItems: confirmed });
    const results = res.record.items.map((x, n) => ({ record: rec.id, item: x.id, title: x.title, reason: x.reason, action: x.action, category: list[n]?.category, risk: list[n]?.risk, cost: list[n]?.cost ?? 1, cards: list[n]?.cards ?? [], refs: [...new Set((list[n]?.ops ?? []).flatMap(refsOfOp))], review: list[n]?.review ?? null, status: x.result?.status ?? 'unknown', undo: x.result?.undo ?? [], ...(x.result?.message ? { message: x.result.message } : {}), ...(list[n]?.holdingId ? { holding: list[n].holdingId } : {}), ...(confirmed.has(x.id) && x.result?.status === 'done' ? { confirmed: true } : {}) }));
    return { record: rec.id, results, invalid };
  }
  return { record: null, results: [], invalid };
}

/** 審核連續幾輪沒有完成就不再延後（當作看過），避免同一批每輪重新花錢、最後又在審核失敗 */
export const MAX_REVIEW_DEFERRALS = 3;
const deferralsFile = (local) => path.join(local, 'autopilot', 'deferrals.json');

const DEFERRAL_STALE_MS = 7 * 86_400_000;

/**
 * 記錄「審核沒有完成」造成的延後（每台各自計算，不同步）。deferred=false 時清掉計數。
 * tag：這次處理的內容版本（範圍指紋）；版本不同或上次延後已超過 7 天就從 1 重算，舊內容累積的次數不算到新內容上。
 * @returns {Promise<number>} 同一個版本連續第幾次（清掉時回傳 0）
 */
export async function noteReviewDeferral(local, key, deferred, { tag = '', now = Date.now() } = {}) {
  const st = (await readJson(deferralsFile(local), null)) ?? {};
  if (!deferred) {
    if (st[key]) { delete st[key]; await writeJsonAtomic(deferralsFile(local), st).catch(() => {}); }
    return 0;
  }
  const cur = st[key] && typeof st[key] === 'object' ? st[key] : null;
  const same = cur && cur.tag === tag && now - (Date.parse(cur.at) || 0) < DEFERRAL_STALE_MS;
  st[key] = { n: same ? (Number(cur.n) || 0) + 1 : 1, tag, at: new Date(now).toISOString() };
  await writeJsonAtomic(deferralsFile(local), st).catch(() => {});
  return st[key].n;
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
