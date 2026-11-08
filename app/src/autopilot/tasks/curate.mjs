// 自動駕駛：範圍整理（1.5.0）。對應 /engram:tidy：重複、過時、範圍放錯、過大、frontmatter、連結、核心準則精簡。
// 觸發：該範圍有還沒看過的收件匣卡片，或內容在上次整理之後變過、而且距離上次整理超過 7 天。
// 1.6.0：每台電腦都整理全域、核心準則、所有專案與自己的單機記憶（不再只有主機）。
// 「上次整理」看所有電腦的同步紀錄（machines/<mid>/autopilot.json 的 scopes）：任何一台整理過同一個版本、
// 也看過目前所有的卡片，這台就跳過——不重複花錢，也不會兩台輪流改同一批記憶。
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJson } from '../../cli/fsutil.mjs';
import { CORE_REF } from '../../tidy/plan.mjs';
import { MAX_REVIEW_DEFERRALS, commitItems, fillBases, keyOfScope, noteReviewDeferral, normalizeItems, scopeKeyOfRef, screen, snap } from '../pipeline.mjs';
import { CURATE_SCHEMA, curatePrompt } from '../prompts.mjs';
import { allScopeMarks } from '../state.mjs';

const DAY = 86_400_000;
export const CURATE_CODES = ['H01', 'H07', 'H08', 'H09', 'H10', 'H11', 'H12', 'H16', 'H21', 'H22'];
const FULL_CHARS = 150_000;
const REVISIT_MS = 7 * DAY;

/** 1.5.0 的本機整理紀錄（只讀：當成這台的紀錄一起比較；1.6.0 起寫在同步的狀態檔） */
const legacyFile = (local) => path.join(local, 'autopilot', 'scopes.json');

/** 卡片屬於哪個範圍 */
function cardScope(f) {
  if (f.code === 'H16') return 'core';
  if (f.code === 'H01') return f.pid ? `project:${f.pid}` : null;
  const r = (f.refs ?? []).find((x) => scopeKeyOfRef(x));
  return r ? scopeKeyOfRef(r) : null;
}

const sha1 = (t) => createHash('sha1').update(String(t ?? '').replace(/\r\n/g, '\n')).digest('hex');

/**
 * 範圍目前內容的指紋：每筆記憶的 ref＋全文雜湊（核心準則看全文）。1.6.0 起要跨電腦比對，
 * 不能用修改時間——沒有 metadata.modified 的檔案會退回檔案 mtime，而每台電腦 git pull 之後的 mtime 都不同。
 */
export async function scopeFingerprint(eg, key, all) {
  // 讀不到（例如防毒或編輯器暫時鎖住檔案）時回傳 null：這一輪略過這個範圍、也不記為整理過，免得把錯的版本同步給其他電腦
  if (key === 'core') { const t = await eg.core.read().then((c) => c.text ?? '').catch(() => null); return t === null ? null : sha1(t).slice(0, 12); }
  const refs = (all ?? await eg.memories.list()).filter((m) => keyOfScope(m.scope) === key).map((m) => m.ref).sort();
  const parts = [];
  for (const ref of refs) {
    const text = await fsp.readFile(path.join(eg.paths.vault, ...ref.split('/')), 'utf8').catch(() => null);
    if (text === null) return null;
    parts.push(`${ref}@${sha1(text)}`);
  }
  return sha1(parts.join('|')).slice(0, 12);
}

/** 這一輪要整理哪些範圍（依優先順序） */
export async function planScopes(ctx) {
  const { eg, mid, findings, now } = ctx;
  const legacy = await readJson(legacyFile(eg.paths.local), null);
  const marks = await allScopeMarks(eg.paths.vault, { legacy, selfMid: mid });
  const all = await eg.memories.list();
  const projects = (await eg.projects.list({ includeArchived: false })).filter((p) => !p.mergedInto);
  // 多台平等：每台都看全域、核心準則、所有專案，以及自己的單機記憶（別台的單機記憶由那台處理）。
  // 開始前同步失敗（ctx.shared === false）時只整理自己的單機記憶，不拿過期的內容改共用記憶
  const keys = ctx.shared === false ? [`machine:${mid}`] : ['global', 'core', `machine:${mid}`, ...projects.map((p) => `project:${p.pid}`)];
  const cardsBy = new Map();
  for (const f of findings.filter((x) => CURATE_CODES.includes(x.code))) {
    const k = cardScope(f);
    if (!k || !keys.includes(k)) continue;
    if (!cardsBy.has(k)) cardsBy.set(k, []);
    cardsBy.get(k).push(f);
  }
  const out = [];
  for (const k of keys) {
    const mems = k === 'core' ? [] : all.filter((m) => keyOfScope(m.scope) === k);
    if (k !== 'core' && !mems.length) continue;
    const fp = await scopeFingerprint(eg, k, all);
    if (fp === null) continue;
    const cards = cardsBy.get(k) ?? [];
    const last = marks[k];
    // 任何一台已經整理過這個版本、也看過目前所有的卡片（處理了或判斷不必處理）→ 跳過
    if (last && last.fp === fp && cards.every((c) => last.cards.includes(c.id))) continue;
    const stale = !last || (last.fp !== fp && now - (Date.parse(last.at) || 0) >= REVISIT_MS);
    if (!cards.length && !stale) continue;
    const sev = cards.some((c) => c.severity === 'high') ? 0 : cards.some((c) => c.severity === 'medium') ? 1 : cards.length ? 2 : 3;
    out.push({ key: k, cards, mems, fp, sev, project: projects.find((p) => `project:${p.pid}` === k) ?? null });
  }
  const order = (k) => (k === 'global' ? 0 : k === 'core' ? 1 : k.startsWith('machine') ? 2 : 3);
  return out.sort((a, b) => a.sev - b.sev || order(a.key) - order(b.key));
}

/**
 * 記下這個範圍整理過了：指紋取「整理之後」的內容（別台同步後看到的就是這個版本，不必再整理一次），
 * cards 是這次看過的卡片。一輪結束時由 run.mjs 一次寫進同步的狀態檔。
 */
async function markScope(ctx, sc) {
  const fp = await scopeFingerprint(ctx.eg, sc.key).catch(() => null);
  if (fp === null) return; // 讀不到目前的內容：不記，下一輪再看
  ctx.scopeMarks[sc.key] = { fp, at: new Date(ctx.clock?.() ?? ctx.now).toISOString(), cards: sc.cards.map((c) => c.id) };
}

/** 整理一個範圍：讀 → 問 LLM → 篩選 → 執行 → 記到執行紀錄 */
export async function curateScope(ctx, sc) {
  const { eg, call, run, mid, feedback, paused, cap } = ctx;
  const snapshot = new Map();
  const label = sc.key === 'global' ? '全域記憶' : sc.key === 'core' ? '核心準則' : sc.key.startsWith('machine') ? '這台電腦的單機記憶' : `專案「${sc.project?.name ?? sc.key}」`;
  // 要給全文的：卡片提到的優先（含別的範圍的重複候選），其次最近修改的；總長度有上限
  const cardRefs = [...new Set(sc.cards.flatMap((c) => c.refs ?? []).filter((r) => scopeKeyOfRef(r)))];
  const ordered = [...new Set([...cardRefs, ...sc.mems.map((m) => m.ref)])];
  const usage = new Map(sc.mems.map((m) => [m.ref, m]));
  let chars = 0;
  const memories = [];
  for (const ref of ordered) {
    const s = await snap(eg, snapshot, ref);
    if (!s) continue;
    const m = usage.get(ref) ?? {};
    const row = { ref, rev: s.rev, name: m.name ?? path.posix.basename(ref, '.md'), description: m.description ?? '', pinned: s.pinned, cards: sc.cards.filter((c) => c.refs?.includes(ref)).map((c) => c.id), reads: m.usage ? m.usage.reads : null, updatedAt: m.updatedAt };
    if (!s.redacted && chars + s.shown.length <= FULL_CHARS) { row.full = s.shown; chars += s.shown.length; } else snapshot.delete(ref);
    memories.push(row);
  }
  let core = null;
  let others = [];
  if (sc.key === 'core') {
    const s = await snap(eg, snapshot, CORE_REF);
    if (s.redacted) { snapshot.delete(CORE_REF); run.skipped.push({ task: 'curate', scope: sc.key, why: '核心準則含疑似金鑰，先處理金鑰' }); return; }
    core = s.shown;
    // 核心準則與全域記憶重複時要看得到全域記憶：給名稱與說明
    others = (await eg.memories.list({ scope: 'global' })).map((m) => ({ ref: m.ref, name: m.name, description: m.description }));
  }
  if (sc.key !== 'core' && !memories.some((m) => m.full !== undefined)) { await markScope(ctx, sc); return; }
  const projects = (await eg.projects.list({ includeArchived: false })).map((p) => ({ pid: p.pid, name: p.name }));
  const machines = (await eg.status()).devices?.map?.((m) => ({ mid: m.id, label: m.label, self: m.id === mid })) ?? [{ mid, label: mid, self: true }];
  const goal = sc.cards.some((c) => c.code === 'H16') ? '每次對話都會載入的內容過長，請精簡核心準則（保留所有仍然有效的規則）'
    : sc.cards.some((c) => c.code === 'H01') ? '這個專案的記憶索引超過載入上限，請合併重複、封存過時、精簡過長的記憶' : null;
  const prompt = curatePrompt({
    scopeLabel: label, scopeKey: sc.key, goal, core, memories, others,
    cards: sc.cards.map((c) => ({ id: c.id, code: c.code, title: c.title, detail: c.detail, refs: c.refs })),
    projects, machines, feedback: feedback.slice(-30),
  });
  const r = await call(`整理 ${sc.key}`, { schema: CURATE_SCHEMA, prompt });
  if (!r.ok) { run.skipped.push({ task: 'curate', scope: sc.key, why: r.error?.message ?? 'LLM 失敗' }); return; }
  // 共用範圍每台都可以改；別台的單機記憶只有那台能改。開始前同步失敗時只能改自己的單機記憶
  // （卡片會帶入別的範圍的記憶，不能讓 LLM 拿過期的內容把記憶搬進或合併進共用範圍）
  const writable = (k) => (ctx.shared === false ? k === `machine:${mid}` : !String(k).startsWith('machine:') || k === `machine:${mid}`);
  const { items, dropped } = normalizeItems(r.data.items, snapshot, { allowCore: sc.key === 'core', mid, writable });
  for (const d of dropped) run.rejected.push({ task: 'curate', scope: sc.key, title: d.title, why: d.why });
  fillBases(items, snapshot);
  const { approved, rejected } = await screen(call, items, snapshot, { paused, cap: cap.left, mid });
  for (const x of rejected) run.rejected.push({ task: 'curate', scope: sc.key, ...x });
  if (approved.length) {
    const res = await commitItems(eg, { items: approved, scopeKey: sc.key === 'core' ? 'core' : sc.key, summary: String(r.data.summary ?? ''), dir: path.join(ctx.workDir, `curate-${sc.key.replace(/[^a-z0-9-]/gi, '_')}`), task: 'curate', runId: run.id, onRecord: async (id) => { run.records.push(id); await ctx.save?.(); } });
    for (const x of res.invalid) run.rejected.push({ task: 'curate', scope: sc.key, ...x });
    for (const x of res.results) {
      run.actions.push({ task: 'curate', scope: sc.key, kind: 'tidy', ...x });
      if (x.status === 'done') cap.left -= x.cost ?? 1;
    }
  }
  // LLM 判斷不必處理的卡片：忽略 90 天（之後內容變了會再判斷一次）
  for (const d of Array.isArray(r.data.dismiss) ? r.data.dismiss : []) {
    const f = sc.cards.find((c) => c.id === String(d.card));
    if (!f) continue;
    await eg.findings.dismiss(f.id, { until: new Date(ctx.now + 90 * DAY).toISOString() }).catch(() => {});
    run.actions.push({ task: 'curate', scope: sc.key, kind: 'dismiss', card: f.id, code: f.code, title: `不處理：${f.title}`, reason: String(d.reason ?? '').slice(0, 500), status: 'done', undo: [] });
  }
  // 這一輪中途停止（預算用完、被停止、用量上限）或有項目超過改動上限：不記為整理過，下一輪再看
  if (call.state?.stopped || rejected.some((x) => x.deferred && !x.reviewIncomplete)) return;
  // 審核沒有完成（不是不同意）：下一輪再審；連續 MAX_REVIEW_DEFERRALS 輪都沒完成就當作看過，避免每輪空轉花錢
  if (rejected.some((x) => x.reviewIncomplete)) {
    const n = await noteReviewDeferral(eg.paths.local, sc.key, true);
    if (n < MAX_REVIEW_DEFERRALS) return;
    run.notes.push({ task: 'curate', scope: sc.key, note: `審核連續 ${n} 輪沒有完成，這個範圍先記為看過；內容改變或出現新的卡片時再整理` });
  }
  await noteReviewDeferral(eg.paths.local, sc.key, false);
  await markScope(ctx, sc);
}
