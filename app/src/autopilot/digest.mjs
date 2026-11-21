// 每週摘要（2.0.0 Q8）：成果導向的一週摘要，存成 local/autopilot/digest/<週一日期>.json（只在這台電腦），保留最近 12 週。
// 格式（GET /api/digest，和管理介面約定）：
//   { week, generatedAt, learned: { created: [{ ref, title }], updated: [{ ref, title }] }, graduated: [{ ref, title, to }],
//     graduation: { candidates, needsConfirm, unconfirmed }, holding: { held, withCore }, preferences: { used, pending, candidates },
//     guardrails: { blocked, hinted, falseBlocks }, recall: { surfaced, opened },
//     env: { findings: [{ code, title }] }, autopilot: { runs, costUsd, stopped: [{ at, reason: limit|auth|budget|busy }] }, previous: [week, …] }
//   graduation 與 preferences.candidates 是第三輪審查 B 加的（之前存的週沒有這兩個欄位）。
// - 一週是本地時間的週一 00:00 到下週一 00:00；檔名與 week 是那個週一的日期。
// - 只存已經結束的週（定稿）；這一週還沒結束時即時算出、不存檔。
// - 自動駕駛關閉時照樣產生（護欄、召回、環境的數字不依賴自動駕駛），但不發通知；開啟時每週通知一則一句話的成果。
// - 不含對話原文與疑似金鑰：記憶只列 ref 與名稱（過遮蔽），保留區只有數字，停止原因只有代碼。
// 資料來源：記憶庫的 git 歷史（新增與更新的記憶，兩台電腦都算）、同步的自動駕駛狀態（畢業的項目，兩台都算）、
// 保留區、本機的護欄與召回紀錄（local/usage/）、環境健檢的快取、本機的自動駕駛執行紀錄。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { localDate, readJson, writeJsonAtomic } from '../cli/fsutil.mjs';
import { E, EngramError } from '../core/errors.mjs';
import { cachedEnvFindings } from '../core/envhealth.mjs';
import { parseMemoryFile } from '../core/frontmatter.mjs';
import { git } from '../core/git.mjs';
import { scopeOfRef } from '../core/memories.mjs';
import { redactSecrets } from '../core/secrets.mjs';
import { allMachineStates, listRuns } from './state.mjs';
import { preferenceItems } from './prompts.mjs';

export const DIGEST_KEEP_WEEKS = 12;
const DAY = 86_400_000;
const WEEK_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 一份摘要最多列幾筆新增與更新的記憶（各自） */
const LIST_MAX = 200;
/** 會改記憶內容的 commit（其他像整理索引、搬移、綁定、確認紀錄、讀取統計的不算「學到」）；沒有標記的（手動 commit）也算 */
const CONTENT_ACTIONS = new Set(['create', 'edit', 'autosave', 'merge', 'restore', 'resolve']);
/** 通知、環境發現第一次出現的時間：local/autopilot/digest.json（1.5.0 的每週通知也用這個檔，舊的 at 欄位不再使用） */
const stateFile = (local) => path.join(local, 'autopilot', 'digest.json');
const digestDir = (local) => path.join(local, 'autopilot', 'digest');
const fileOf = (local, week) => path.join(digestDir(local), `${week}.json`);
const ENV_SEEN_MAX = 200;

/** 這個時間所在那一週的週一（本地日期 YYYY-MM-DD） */
export function weekOf(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localDate(d);
}

/** 週一日期 → { week, start, end }（毫秒，本地時間的週一 00:00 到下週一 00:00）；不是有效的週一日期時 null */
export function parseWeek(week) {
  const m = WEEK_RE.exec(String(week ?? ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (localDate(d) !== week || d.getDay() !== 1) return null;
  const end = new Date(d);
  end.setDate(end.getDate() + 7);
  return { week, start: d.getTime(), end: end.getTime() };
}

const title = (t) => redactSecrets(String(t ?? '').replace(/\s+/g, ' ').trim()).text.slice(0, 120);
const inRange = (t, r) => Number.isFinite(t) && t >= r.start && t < r.end;

/** 記憶檔（索引與核心準則不算） */
function isMemory(ref) {
  return !!scopeOfRef(ref) && /\.md$/i.test(ref) && !/(^|\/)(INDEX|MEMORY)\.md$/i.test(ref);
}

async function show(vault, rev) {
  const r = await git(['show', rev], { cwd: vault, allowFail: true });
  return r.code === 0 ? r.stdout : null;
}

/**
 * 這週新增與更新的記憶（記憶庫的 git 歷史，兩台電腦的都算）。新增：這週第一次出現、週末還在的；更新：這週之前就有、
 * 內文在這週有改變的（只改 frontmatter 的不算，例如釘選、記下驗證日期或畢業的去向）。名稱取週末那一版的 frontmatter。
 */
async function learnedIn(vault, r) {
  const res = await git(['log', '--no-merges', '--no-renames', '--reverse', `--since=${new Date(r.start).toISOString()}`, `--until=${new Date(r.end - 1).toISOString()}`, '--format=%x1e%H%x1f%B%x1f', '--name-status', '--', 'global', 'projects', 'machines'], { cwd: vault, allowFail: true });
  if (res.code !== 0) return { created: [], updated: [] };
  // ref → { first: 這週第一個碰到它的 commit, last: 最後一個, added: 這週新增 }
  const touched = new Map();
  for (const rec of res.stdout.split('\x1e')) {
    if (!rec.trim()) continue;
    const [sha, body = '', files = ''] = rec.split('\x1f');
    const action = /^Engram-Action:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? null;
    if (action !== null && !CONTENT_ACTIONS.has(action)) continue;
    for (const line of files.split('\n')) {
      const m = /^([AMD])\t(.+)$/.exec(line.trim());
      if (!m || !isMemory(m[2])) continue;
      const e = touched.get(m[2]) ?? { first: sha.trim(), added: false };
      if (m[1] === 'A' && !touched.has(m[2])) e.added = true;
      e.last = sha.trim();
      e.deleted = m[1] === 'D';
      touched.set(m[2], e);
    }
  }
  const created = [];
  const updated = [];
  for (const [ref, e] of touched) {
    if (e.deleted || created.length + updated.length >= LIST_MAX * 2) continue;
    const after = await show(vault, `${e.last}:${ref}`);
    if (after === null) continue;
    const name = title(parseMemoryFile(after).data?.name ?? path.posix.basename(ref, '.md'));
    if (e.added) { if (created.length < LIST_MAX) created.push({ ref, title: name }); continue; }
    const before = await show(vault, `${e.first}^:${ref}`);
    if (before === null) { if (created.length < LIST_MAX) created.push({ ref, title: name }); continue; }
    if (parseMemoryFile(before).body.trim() !== parseMemoryFile(after).body.trim() && updated.length < LIST_MAX) updated.push({ ref, title: name });
  }
  return { created, updated };
}

/** 本機的命中紀錄（local/usage/<kind>/<UTC 日期>.jsonl）裡時間在這一週的每一行 */
async function usageRows(local, kind, r) {
  const dir = path.join(local, 'usage', kind);
  const from = new Date(r.start - DAY).toISOString().slice(0, 10);
  const to = new Date(r.end + DAY).toISOString().slice(0, 10);
  const rows = [];
  // 情境召回的 mod 每個程序各寫 <日期>.<程序代號>.jsonl（WP4a）：同一天的檔都要算
  for (const n of (await fsp.readdir(dir).catch(() => [])).filter((x) => /^\d{4}-\d{2}-\d{2}(?:\.[A-Za-z0-9_-]{1,40})?\.jsonl$/.test(x) && x.slice(0, 10) >= from && x.slice(0, 10) <= to).sort()) {
    const text = await fsp.readFile(path.join(dir, n), 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o && typeof o === 'object' && inRange(Date.parse(o.at ?? ''), r)) rows.push(o);
    }
  }
  return rows;
}

/** 情境召回帶出的次數，與其中之後被打開的（同一場對話讀過那筆記憶；和召回頁的算法相同） */
async function recallIn(local, r) {
  const rows = (await usageRows(local, 'recall', r)).filter((x) => typeof x.ref === 'string' && typeof x.session === 'string');
  const reads = (await readJson(path.join(local, 'usage', 'reads.json'), null)) ?? {};
  const seen = new Set();
  for (const list of Object.values(reads.seen ?? {})) for (const k of Array.isArray(list) ? list : []) seen.add(k);
  let opened = 0;
  for (const p of new Set(rows.map((x) => `${x.session}\u0000${x.ref}`))) if (seen.has(p)) opened++;
  return { surfaced: rows.length, opened };
}

async function guardrailsIn(local, r) {
  const rows = await usageRows(local, 'guardrails', r);
  const n = (k) => rows.filter((x) => x.kind === k).length;
  return { blocked: n('block'), hinted: n('hint'), falseBlocks: n('falseBlock') };
}

/** 這一週畢業的項目（所有電腦同步的自動駕駛狀態） */
async function graduatedIn(vault, r) {
  const out = [];
  for (const s of await allMachineStates(vault).catch(() => [])) {
    for (const it of s.graduate?.items ?? []) if (inRange(Date.parse(it.at), r)) out.push({ at: it.at, ref: it.ref, title: title(it.title), to: it.to });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).map(({ at, ...x }) => x);
}

/** 這一週這台電腦的自動駕駛：執行幾輪、約當金額、因為用量上限、登入、預算或 Claude 暫時忙碌（busy）而停止的時間與原因 */
async function autopilotIn(local, r) {
  const runs = (await listRuns(local, { limit: 1000 })).filter((x) => inRange(Date.parse(x.startedAt), r));
  const cost = runs.reduce((n, x) => n + (Number(x.summary?.costUsd) || 0), 0);
  return {
    runs: runs.length,
    costUsd: Math.round(cost * 10000) / 10000,
    stopped: runs.filter((x) => ['limit', 'auth', 'budget', 'busy'].includes(x.summary?.stopped)).map((x) => ({ at: x.endedAt ?? x.startedAt, reason: x.summary.stopped })).sort((a, b) => a.at.localeCompare(b.at)),
  };
}

/** 環境健檢的發現：第一次出現的時間記在 digest.json 的 envSeen（每次產生摘要時更新），這一週第一次出現、現在仍在的列出 */
async function envIn(eg, r, st, now) {
  const off = (await eg.settings?.get?.().catch(() => null))?.envHealth === 'off';
  if (off) return { findings: [] };
  const list = await cachedEnvFindings({ local: eg.paths.local }, now).catch(() => []);
  return { findings: list.filter((f) => inRange(Date.parse(st.envSeen?.[f.id] ?? ''), r)).map((f) => ({ code: String(f.code), title: title(f.title) })) };
}

/** 記下目前的環境發現第一次出現的時間（只留還在的，最多 200 筆） */
async function trackEnv(eg, st, now) {
  const list = await cachedEnvFindings({ local: eg.paths.local }, now).catch(() => []);
  const prev = st.envSeen && typeof st.envSeen === 'object' ? st.envSeen : {};
  const next = {};
  for (const f of list.slice(0, ENV_SEEN_MAX)) next[f.id] = typeof prev[f.id] === 'string' ? prev[f.id] : new Date(now).toISOString();
  const changed = JSON.stringify(next) !== JSON.stringify(prev);
  st.envSeen = next;
  return changed;
}

/**
 * 記憶畢業的現況（第三輪審查 B，產生摘要時的狀態；和記憶畢業用同一個 graduationPool）：
 * { candidates（下一次記憶畢業可以看的筆數）, needsConfirm（想寫進核心準則、要你確認的筆數）, unconfirmed（還沒確認過、不會被看的筆數）}
 */
async function graduationNow(eg) {
  try {
    const { graduationPool } = await import('./tasks/graduate.mjs');
    const p = await graduationPool(eg, eg.machine?.id);
    return { candidates: p.pool.length, needsConfirm: p.waiting.size, unconfirmed: p.unconfirmed };
  } catch {
    return { candidates: 0, needsConfirm: 0, unconfirmed: 0 };
  }
}

/** 算出一週的摘要（不含 previous） */
async function build(eg, r, st, now) {
  const held = typeof eg.holding?.list === 'function' ? await eg.holding.list({ status: 'held' }).catch(() => []) : [];
  const prefs = await preferenceItems(eg).catch(() => null);
  return {
    week: r.week,
    generatedAt: new Date(now).toISOString(),
    learned: await learnedIn(eg.paths.vault, r),
    graduated: await graduatedIn(eg.paths.vault, r),
    graduation: await graduationNow(eg),
    holding: { held: held.length, withCore: held.filter((h) => h.grounded === true).length },
    // 第二輪審查 R1、N1：偏好區塊採用與還沒採用（等使用者本人確認）的筆數，產生摘要時的狀態；
    // 第三輪審查 B：candidates 是偏好面板「常用、但還沒由你確認」的筆數
    preferences: { used: prefs?.used.length ?? 0, pending: prefs?.pending.length ?? 0, candidates: prefs?.candidates?.length ?? 0 },
    guardrails: await guardrailsIn(eg.paths.local, r),
    recall: await recallIn(eg.paths.local, r),
    env: await envIn(eg, r, st, now),
    autopilot: await autopilotIn(eg.paths.local, r),
  };
}

/** 存下來的週（新的在前） */
export async function listDigests(local) {
  return (await fsp.readdir(digestDir(local)).catch(() => [])).filter((n) => n.endsWith('.json') && parseWeek(n.slice(0, -5))).map((n) => n.slice(0, -5)).sort().reverse();
}

const readState = async (local) => {
  const st = (await readJson(stateFile(local), null)) ?? {};
  return { notified: Array.isArray(st.notified) ? st.notified.filter((w) => parseWeek(w)) : [], envSeen: st.envSeen && typeof st.envSeen === 'object' ? st.envSeen : {} };
};

/** 已經結束的一週：算出並存檔（定稿），只留最近 DIGEST_KEEP_WEEKS 週 */
async function finalize(eg, r, st, now) {
  const d = await build(eg, r, st, now);
  await fsp.mkdir(digestDir(eg.paths.local), { recursive: true });
  await writeJsonAtomic(fileOf(eg.paths.local, r.week), d);
  for (const w of (await listDigests(eg.paths.local)).slice(DIGEST_KEEP_WEEKS)) await fsp.rm(fileOf(eg.paths.local, w), { force: true }).catch(() => {});
  return d;
}

/**
 * 讀一週的摘要（week 省略時是最近一週：存下來的最新一份；還沒有任何一份時是這一週到目前為止）。
 * 存下來的直接讀；上一週還沒存（剛結束）就算出並存檔；這一週即時算、不存檔。更早而沒有存的回 E_NOT_FOUND。
 */
export async function getDigest(eg, week, { now = Date.now() } = {}) {
  const local = eg.paths.local;
  if (week !== undefined && week !== null && week !== '' && !parseWeek(week)) {
    throw new EngramError(E.INVALID, `週的日期要寫成那一週的週一（YYYY-MM-DD）：${String(week).slice(0, 40)}`, '例如 engram autopilot digest 2026-11-16').withEn(`The week must be the Monday of that week (YYYY-MM-DD): ${String(week).slice(0, 40)}`, 'For example: engram autopilot digest 2026-11-16');
  }
  const stored = await listDigests(local);
  const current = weekOf(now);
  const last = weekOf(now - 7 * DAY);
  const target = week || stored[0] || current;
  let d = stored.includes(target) ? await readJson(fileOf(local, target), null) : null;
  if (!d) {
    const r = parseWeek(target);
    const st = await readState(local);
    if (target === current) d = await build(eg, r, st, now);
    else if (target === last) d = await finalize(eg, r, st, now);
    else throw new EngramError(E.NOT_FOUND, `沒有 ${target} 這一週的摘要`, stored.length ? `有摘要的週：${stored.join('、')}` : '摘要在每週結束之後產生').withEn(`There is no digest for the week of ${target}`, stored.length ? `Weeks with a digest: ${stored.join(', ')}` : 'A digest is made after each week ends');
  }
  return { ...d, previous: (await listDigests(local)).filter((w) => w < target) };
}

/**
 * 通知的一句話（學到幾件、保留區幾件待看、護欄擋下幾次）；這一週什麼都沒有時 null。
 * 第三輪審查 B：有其他成果時附上「要你確認之後才能寫進核心準則」的筆數；只有這一項的週不另外通知。
 */
export function digestSentence(d) {
  const learned = (d.learned?.created?.length ?? 0) + (d.learned?.updated?.length ?? 0);
  const held = d.holding?.held ?? 0;
  const blocked = d.guardrails?.blocked ?? 0;
  if (!learned && !held && !blocked && !(d.graduated?.length)) return null;
  const wait = d.graduation?.needsConfirm ?? 0;
  return {
    zh: `上週學到 ${learned} 件、保留區有 ${held} 件待你看、護欄擋下 ${blocked} 次${d.graduated?.length ? `，${d.graduated.length} 筆記憶畢業` : ''}${wait ? `；${wait} 筆常用的記憶要你確認之後才能寫進核心準則或成為護欄規則` : ''}。`,
    en: `Last week: learned ${learned}, ${held} held for you to look at, guardrails blocked ${blocked} times${d.graduated?.length ? `, ${d.graduated.length} memories graduated` : ''}${wait ? `; ${wait} frequently used ${wait === 1 ? 'memory needs' : 'memories need'} your confirmation before ${wait === 1 ? 'it' : 'they'} can go into the core rules or become guardrail rules` : ''}.`,
  };
}

/**
 * 每天（健康檢查）與每輪自動駕駛結束時呼叫：更新環境發現第一次出現的時間；上一週剛結束時產生它的摘要（定稿）；
 * 自動駕駛開啟時每週通知一則（點開到每週摘要頁）。關閉時照樣產生摘要，但不通知。
 * @returns {Promise<{ week: string, created: boolean, notified: boolean }>}
 */
export async function refreshDigest(eg, { notifier, now = Date.now() } = {}) {
  const local = eg.paths.local;
  const st = await readState(local);
  let dirty = await trackEnv(eg, st, now);
  const last = weekOf(now - 7 * DAY);
  const r = parseWeek(last);
  let d = await readJson(fileOf(local, last), null);
  let created = false;
  // 還沒存、或是在那一週結束之前存的（不完整）：重新算出並定稿
  if (!d || !(Date.parse(d.generatedAt) >= r.end)) { d = await finalize(eg, r, st, now); created = true; }
  let notified = false;
  const on = (await eg.settings?.get?.().catch(() => null))?.autopilot === 'on';
  if (on && !st.notified.includes(last)) {
    const s = digestSentence(d);
    if (s && notifier?.notify) {
      await Promise.resolve(notifier.notify({ key: `autopilot-digest:${last}`, title: 'Engram 憶跡・每週摘要', body: `${s.zh}點開看每週摘要。`, page: 'digest' })).catch(() => {});
      notified = true;
    }
    // 通知過、或這一週沒有內容：記下來（不必每天重新判斷）。有內容但這次沒有通知器（例如 engram autopilot run --wait）：不記，
    // 留給常駐程式下一次（每天的健康檢查）通知
    if (notified || !s) {
      st.notified = [...st.notified, last].slice(-DIGEST_KEEP_WEEKS);
      dirty = true;
    }
  }
  if (dirty) await writeJsonAtomic(stateFile(local), { notified: st.notified, envSeen: st.envSeen });
  return { week: last, created, notified };
}
