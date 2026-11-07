// 自動駕駛：範圍整理（1.5.0）。對應 /engram:tidy：重複、過時、範圍放錯、過大、frontmatter、連結、核心準則精簡。
// 觸發：該範圍有相關的收件匣卡片，或內容在上次整理之後變過、而且距離上次整理超過 7 天。
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../../cli/fsutil.mjs';
import { CORE_REF } from '../../tidy/plan.mjs';
import { commitItems, fillBases, keyOfScope, normalizeItems, scopeKeyOfRef, screen, snap } from '../pipeline.mjs';
import { CURATE_SCHEMA, curatePrompt } from '../prompts.mjs';

const DAY = 86_400_000;
export const CURATE_CODES = ['H01', 'H07', 'H08', 'H09', 'H10', 'H11', 'H12', 'H16', 'H21', 'H22'];
const FULL_CHARS = 150_000;
const REVISIT_MS = 7 * DAY;

const stateFile = (local) => path.join(local, 'autopilot', 'scopes.json');

/** 卡片屬於哪個範圍 */
function cardScope(f) {
  if (f.code === 'H16') return 'core';
  if (f.code === 'H01') return f.pid ? `project:${f.pid}` : null;
  const r = (f.refs ?? []).find((x) => scopeKeyOfRef(x));
  return r ? scopeKeyOfRef(r) : null;
}

function fingerprint(mems) {
  return createHash('sha1').update(mems.map((m) => `${m.ref}@${m.updatedAt ?? ''}@${m.size ?? ''}`).sort().join('|')).digest('hex').slice(0, 12);
}

/** 這一輪要整理哪些範圍（依優先順序） */
export async function planScopes(ctx) {
  const { eg, isHost, mid, findings, now } = ctx;
  const st = (await readJson(stateFile(eg.paths.local), null)) ?? {};
  const all = await eg.memories.list();
  const projects = (await eg.projects.list({ includeArchived: false })).filter((p) => !p.mergedInto);
  const keys = [`machine:${mid}`];
  if (isHost) keys.unshift('global', 'core', ...projects.map((p) => `project:${p.pid}`));
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
    const fp = k === 'core' ? createHash('sha1').update((await eg.core.read()).text ?? '').digest('hex').slice(0, 12) : fingerprint(mems);
    const cards = cardsBy.get(k) ?? [];
    const last = st[k];
    const stale = !last || (last.fp !== fp && now - (Date.parse(last.at) || 0) >= REVISIT_MS);
    if (!cards.length && !stale) continue;
    if (k !== 'core' && !mems.length) continue;
    const sev = cards.some((c) => c.severity === 'high') ? 0 : cards.some((c) => c.severity === 'medium') ? 1 : cards.length ? 2 : 3;
    out.push({ key: k, cards, mems, fp, sev, project: projects.find((p) => `project:${p.pid}` === k) ?? null });
  }
  const order = (k) => (k === 'global' ? 0 : k === 'core' ? 1 : k.startsWith('machine') ? 2 : 3);
  return out.sort((a, b) => a.sev - b.sev || order(a.key) - order(b.key));
}

async function markScope(local, key, fp, now) {
  const st = (await readJson(stateFile(local), null)) ?? {};
  st[key] = { fp, at: new Date(now).toISOString() };
  await writeJsonAtomic(stateFile(local), st);
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
  if (sc.key !== 'core' && !memories.some((m) => m.full !== undefined)) { await markScope(eg.paths.local, sc.key, sc.fp, ctx.now); return; }
  const projects = (await eg.projects.list({ includeArchived: false })).map((p) => ({ pid: p.pid, name: p.name }));
  const machines = (await eg.status()).machines?.map?.((m) => ({ mid: m.id, label: m.label, self: m.id === mid })) ?? [{ mid, label: mid, self: true }];
  const goal = sc.cards.some((c) => c.code === 'H16') ? '每次對話都會載入的內容過長，請精簡核心準則（保留所有仍然有效的規則）'
    : sc.cards.some((c) => c.code === 'H01') ? '這個專案的記憶索引超過載入上限，請合併重複、封存過時、精簡過長的記憶' : null;
  const prompt = curatePrompt({
    scopeLabel: label, scopeKey: sc.key, goal, core, memories, others,
    cards: sc.cards.map((c) => ({ id: c.id, code: c.code, title: c.title, detail: c.detail, refs: c.refs })),
    projects, machines, feedback: feedback.slice(-30),
  });
  const r = await call(`整理 ${sc.key}`, { schema: CURATE_SCHEMA, prompt });
  if (!r.ok) { run.skipped.push({ task: 'curate', scope: sc.key, why: r.error?.message ?? 'LLM 失敗' }); return; }
  const { items, dropped } = normalizeItems(r.data.items, snapshot, { allowCore: sc.key === 'core', mid });
  for (const d of dropped) run.rejected.push({ task: 'curate', scope: sc.key, title: d.title, why: d.why });
  fillBases(items, snapshot);
  const { approved, rejected } = await screen(call, items, snapshot, { paused, cap: cap.left, mid });
  for (const x of rejected) run.rejected.push({ task: 'curate', scope: sc.key, ...x });
  if (approved.length) {
    const res = await commitItems(eg, { items: approved, scopeKey: sc.key === 'core' ? 'core' : sc.key, summary: String(r.data.summary ?? ''), dir: path.join(ctx.workDir, `curate-${sc.key.replace(/[^a-z0-9-]/gi, '_')}`), task: 'curate', runId: run.id });
    for (const x of res.invalid) run.rejected.push({ task: 'curate', scope: sc.key, ...x });
    if (res.record) run.records.push(res.record);
    for (const x of res.results) {
      run.actions.push({ task: 'curate', scope: sc.key, kind: 'tidy', ...x });
      if (x.status === 'done') cap.left--;
    }
  }
  // LLM 判斷不必處理的卡片：忽略 90 天（之後內容變了會再判斷一次）
  for (const d of Array.isArray(r.data.dismiss) ? r.data.dismiss : []) {
    const f = sc.cards.find((c) => c.id === String(d.card));
    if (!f) continue;
    await eg.findings.dismiss(f.id, { until: new Date(ctx.now + 90 * DAY).toISOString() }).catch(() => {});
    run.actions.push({ task: 'curate', scope: sc.key, kind: 'dismiss', card: f.id, code: f.code, title: `不處理：${f.title}`, reason: String(d.reason ?? '').slice(0, 500), status: 'done', undo: [] });
  }
  await markScope(eg.paths.local, sc.key, sc.fp, ctx.now);
}
