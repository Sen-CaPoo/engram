// 自動駕駛的狀態（1.5.0）。
// - 每台電腦一份同步的狀態檔 vault/machines/<mid>/autopilot.json：啟用時間、上次執行、復原回饋；
//   1.6.0 加上範圍整理紀錄（scopes）與審核員的拒絕（reviewRejects）；2.0.0 加上撞到用量上限的時間與重置時間（limit）。
//   每台只寫自己的檔案，兩台同時更新也不會衝突；讀取時彙整所有電腦。
// - 1.6.0：多台電腦完全平等，沒有主機。每台都整理共用記憶、處理衝突；靠同步的整理紀錄避免重複處理，
//   靠寫入時比對版本（整理記錄的 base）與同步時的衝突處理避免互相覆蓋。
// - 本機的執行紀錄 local/autopilot/runs/<run>.json（不同步）：這一輪做了什麼、為什麼、怎麼復原。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readJson, writeJsonAtomic } from '../cli/fsutil.mjs';
import { commitPaths, listMachineIds, machineDir } from '../core/vault.mjs';
import { redactSecrets } from '../core/secrets.mjs';

const DAY = 86_400_000;
/** 同一類動作在這段時間內被復原幾次就暫停（只記錄、不執行） */
export const PAUSE_AFTER_UNDOS = 2;
export const PAUSE_WINDOW_MS = 60 * DAY;
const FEEDBACK_MAX = 100;
/** 回饋紀錄裡的「使用者的糾正」（2.0.0 Q9）另外最多留幾筆：不能擠掉復原紀錄 */
const CORRECTIONS_MAX = 50;
const REJECTS_MAX = 200;
const SCOPE_KEY_RE = /^(global|core|machine:[a-z0-9][a-z0-9-]{0,63}|project:[a-z0-9][a-z0-9-]{0,63})$/;
const SCOPES_MAX = 500;
const KNOWN = new Set(['v', 'enabledAt', 'lastRunAt', 'lastRunId', 'feedback', 'scopes', 'reviewRejects', 'limit', 'graduate']);
/** 記憶畢業（2.0.0 P5）的去向；看過的記憶（ref → 內容的 git blob sha 前 12 碼）與畢業的項目各自最多留幾筆 */
export const GRADUATE_TO = ['core', 'guardrail', 'env', 'archive'];
const GRADUATE_SEEN_MAX = 400;
const GRADUATE_ITEMS_MAX = 100;
/** 用量上限的重置時間最遠接受到多久之後（週上限最多 7 天；更遠的值當成錯誤，免得一個壞掉的同步檔讓排程永遠不啟動） */
export const MAX_RESET_MS = 8 * DAY;
const EXTRA_KEYS_MAX = 20;
const EXTRA_BYTES_MAX = 16 * 1024;
const RUNS_KEEP_DAYS = 90;

export const RUN_ID_RE = /^ap-\d{8}-\d{6}-[a-z0-9]{4}$/;
const pad = (n) => String(n).padStart(2, '0');
export function newRunId(now = new Date()) {
  const d = now;
  const tail = [...randomBytes(4)].map((b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  return `ap-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${tail}`;
}

const stateRel = (mid) => `machines/${mid}/autopilot.json`;
const stateFile = (vault, mid) => path.join(machineDir(vault, mid), 'autopilot.json');

/** 範圍整理紀錄：{ key: { fp, at, cards } }（同步的檔案，格式不對的一律丟掉） */
function normalizeScopes(s) {
  const out = {};
  if (!s || typeof s !== 'object' || Array.isArray(s)) return out;
  // 超過上限時留最近整理的（已經不存在的專案、合併掉的範圍自然被擠掉）
  const rows = Object.entries(s).filter(([k, v]) => SCOPE_KEY_RE.test(k) && v && typeof v.fp === 'string' && typeof v.at === 'string')
    .sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, SCOPES_MAX);
  for (const [k, v] of rows) out[k] = { fp: v.fp.slice(0, 40), at: v.at.slice(0, 40), cards: Array.isArray(v.cards) ? v.cards.filter((c) => typeof c === 'string').map((c) => c.slice(0, 120)).slice(0, 200) : [] };
  return out;
}

/** 審核員的拒絕：[{ ref, sha, at, reason }] */
function normalizeRejects(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((x) => x && typeof x.ref === 'string' && typeof x.sha === 'string' && /^[0-9a-f]{40}$/.test(x.sha))
    .map((x) => ({ ref: x.ref.slice(0, 300), sha: x.sha, at: typeof x.at === 'string' ? x.at.slice(0, 40) : '', reason: String(x.reason ?? '').slice(0, 300), ...(typeof x.held === 'string' && /^[a-z-]{1,40}$/.test(x.held) ? { held: x.held } : {}) }))
    .slice(-REJECTS_MAX);
}

/** 撞到用量上限的紀錄（2.0.0）：{ at, resetAt }，兩個都要是看得懂的時間，否則不留 */
function normalizeLimit(x) {
  if (!x || typeof x !== 'object') return null;
  const ok = (v) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
  return ok(x.at) && ok(x.resetAt) ? { at: x.at, resetAt: x.resetAt } : null;
}

/**
 * 記憶畢業的紀錄（2.0.0 P5）：{ at（上次執行）, seen: { ref: 判斷時內容的 sha 前 12 碼 }, waiting: { ref: sha 前 12 碼 }, items: [{ ref, title, to, at }] }。
 * waiting（第三輪審查 B）：判斷成適合寫進核心準則、但目前內容不是使用者或起點確認的（要使用者確認之後才寫）；使用者確認之前不再看。
 * 格式不對的欄位不留；全部都沒有時 null。
 */
function normalizeGraduate(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const ok = (v) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
  const shaMap = (m, re) => {
    const out = {};
    const raw = m && typeof m === 'object' && !Array.isArray(m) ? Object.entries(m) : [];
    for (const [ref, sha] of raw.slice(-GRADUATE_SEEN_MAX)) if (ref.length <= 300 && typeof sha === 'string' && re.test(sha)) out[ref] = sha;
    return out;
  };
  const seen = shaMap(x.seen, /^[0-9a-f]{12}$/);
  // waiting 的值可以帶想要的去向（第四輪審查 F-05：:core 或 :guardrail；第三輪寫的沒有，當成 core）
  const waiting = shaMap(x.waiting, /^[0-9a-f]{12}(?::(?:core|guardrail))?$/);
  const items = (Array.isArray(x.items) ? x.items : []).filter((i) => i && typeof i.ref === 'string' && GRADUATE_TO.includes(i.to) && ok(i.at))
    .map((i) => ({ ref: i.ref.slice(0, 300), title: String(i.title ?? '').slice(0, 120), to: i.to, at: i.at })).slice(-GRADUATE_ITEMS_MAX);
  const at = ok(x.at) ? x.at : null;
  return at || items.length || Object.keys(seen).length || Object.keys(waiting).length ? { at, seen, ...(Object.keys(waiting).length ? { waiting } : {}), items } : null;
}

/** 回饋與暫停的類別（給人看的名稱） */
export const CATEGORY_LABEL = {
  update: '改寫', move: '搬移', archive: '封存', merge: '合併', create: '新增', split: '拆分', promote: '升為全域', core: '核心準則',
  'dream-create': '對話回顧新增', 'dream-update': '對話回顧改寫', vault: '金鑰移到保管區', 'not-secret': '標記不是金鑰', confirm: '代你確認', revert: '退回寫入', rename: '撞名資料夾改名', verify: '確認仍正確',
  guardrail: '畢業成護欄規則', env: '畢業成環境設定',
};
export const categoryLabel = (c) => CATEGORY_LABEL[c] ?? (String(c).startsWith('conflict-') ? '衝突處理' : String(c).startsWith('card-') ? `收件匣 ${String(c).slice(5)}` : c);

/** waiting 的一個值：內容的 sha 前 12 碼，與想要的去向（core 或 guardrail；沒寫的是 core） */
export const waitingSha = (v) => (typeof v === 'string' ? v.split(':')[0] : null);
export const waitingTo = (v) => (typeof v === 'string' && v.endsWith(':guardrail') ? 'guardrail' : 'core');

/** 所有電腦的記憶畢業紀錄合起來的 seen 與 waiting（ref → 內容的 sha 前 12 碼；同一筆以後面的電腦為準） */
export function graduateMarks(states) {
  const seen = {};
  const waiting = {};
  for (const s of states) {
    Object.assign(seen, s.graduate?.seen ?? {});
    Object.assign(waiting, s.graduate?.waiting ?? {});
  }
  return { seen, waiting };
}

/** 回饋紀錄的上限：復原（與恢復）留最近 FEEDBACK_MAX 筆，糾正另外留最近 CORRECTIONS_MAX 筆；依時間排序 */
function trimFeedback(list) {
  const undo = list.filter((f) => f.kind !== 'correction').slice(-FEEDBACK_MAX);
  const corr = list.filter((f) => f.kind === 'correction').slice(-CORRECTIONS_MAX);
  return [...undo, ...corr].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
}

function normalize(j) {
  // 不認得的欄位原樣保留（之後的版本新增的欄位，不會在這一版改寫狀態檔時被丟掉）；數量或大小超過上限就整批不留，避免檔案被塞大
  let extra = {};
  if (j && typeof j === 'object' && !Array.isArray(j)) for (const [k, val] of Object.entries(j)) if (!KNOWN.has(k) && val !== undefined) extra[k] = val;
  if (Object.keys(extra).length > EXTRA_KEYS_MAX || JSON.stringify(extra).length > EXTRA_BYTES_MAX) extra = {};
  const limit = normalizeLimit(j?.limit);
  const graduate = normalizeGraduate(j?.graduate);
  return {
    ...extra,
    v: 1,
    enabledAt: j?.enabledAt ?? null,
    lastRunAt: j?.lastRunAt ?? null,
    lastRunId: j?.lastRunId ?? null,
    feedback: Array.isArray(j?.feedback) ? trimFeedback(j.feedback.filter((f) => f && typeof f.category === 'string')) : [],
    scopes: normalizeScopes(j?.scopes),
    reviewRejects: normalizeRejects(j?.reviewRejects),
    ...(limit ? { limit } : {}),
    ...(graduate ? { graduate } : {}),
  };
}

export async function readMachineState(vault, mid) {
  return normalize(await readJson(stateFile(vault, mid), null));
}

/** 改這台電腦的狀態檔並 commit（action autopilot）；回傳新狀態 */
export async function updateMachineState(eg, fn, subject = 'autopilot state') {
  const mid = eg.machine.id;
  const work = async () => {
    const cur = await readMachineState(eg.paths.vault, mid);
    const next = normalize((await fn(cur)) ?? cur);
    await writeJsonAtomic(stateFile(eg.paths.vault, mid), next);
    await commitPaths(eg.paths.vault, [stateRel(mid)], subject, { action: 'autopilot', mid }).catch(() => null);
    return next;
  };
  // 和同步、自動存檔共用 vault 的寫入鎖（同時 git add／commit 會撞到 index.lock）
  return typeof eg.locked === 'function' ? eg.locked('autopilot.state', work) : work();
}

/** 所有電腦的狀態與上線時間 */
export async function allMachineStates(vault) {
  const out = [];
  for (const mid of await listMachineIds(vault)) {
    const m = await readJson(path.join(machineDir(vault, mid), 'machine.json'), null);
    // 狀態檔的欄位先展開：同步來的檔案就算夾帶 mid、label 也蓋不掉資料夾名稱與 machine.json 的值
    out.push({ ...(await readMachineState(vault, mid)), mid, label: m?.label ?? mid, lastSeenAt: m?.lastSeenAt ?? null });
  }
  return out;
}

/**
 * 開啟自動駕駛的電腦（依開啟時間排序）。1.6.0 起多台平等、沒有主機：這份清單只用來顯示。
 * @returns {Promise<{ mid, label, self, enabledAt, lastSeenAt, lastRunAt }[]>}
 */
export async function enabledMachines(vault, selfMid) {
  const states = await allMachineStates(vault);
  return states.filter((s) => s.enabledAt)
    .sort((a, b) => String(a.enabledAt).localeCompare(String(b.enabledAt)) || a.mid.localeCompare(b.mid))
    .map((s) => ({ mid: s.mid, label: s.label, self: s.mid === selfMid, enabledAt: s.enabledAt, lastSeenAt: s.lastSeenAt, lastRunAt: s.lastRunAt }));
}

/**
 * 所有電腦的範圍整理紀錄，每個範圍取最近的一筆：{ key: { fp, at, cards, mid } }。
 * legacy：1.5.0 的本機紀錄 local/autopilot/scopes.json（{ key: { fp, at } }），當成這台的紀錄一起比較。
 */
export async function allScopeMarks(vault, { legacy = null, selfMid = null } = {}) {
  const out = {};
  const take = (k, v, mid) => {
    if (!SCOPE_KEY_RE.test(k) || !v || typeof v.fp !== 'string') return;
    const cur = out[k];
    if (!cur || String(v.at ?? '') > String(cur.at ?? '')) out[k] = { fp: v.fp, at: String(v.at ?? ''), cards: Array.isArray(v.cards) ? v.cards : [], mid };
  };
  for (const s of await allMachineStates(vault)) for (const [k, v] of Object.entries(s.scopes)) take(k, v, s.mid);
  if (legacy && typeof legacy === 'object') for (const [k, v] of Object.entries(legacy)) take(k, { ...v, cards: Array.isArray(v?.cards) ? v.cards : [] }, selfMid);
  return out;
}

/** 這一輪整理過的範圍併進這台的紀錄（同一個範圍以新的為準；上限由 normalize 依時間修剪） */
export const mergeScopeMarks = (scopes, marks) => normalizeScopes({ ...(scopes ?? {}), ...(marks ?? {}) });

/** 所有電腦記下的審核員拒絕 */
export async function allReviewRejects(vault) {
  const out = [];
  for (const s of await allMachineStates(vault)) for (const r of s.reviewRejects) out.push({ ...r, mid: s.mid });
  return out;
}

/**
 * 記下審核員不同意確認的一份內容（ref＋sha）。同一份內容之後每一輪、每一台都不再判斷，留給使用者。
 * held：因為某類處理暫停中才沒有執行（例如退回被暫停）——只在那一類仍暫停時有效，使用者恢復後會重新判斷
 */
export async function recordReviewReject(eg, { ref, sha, reason = '', held = null }, now = Date.now()) {
  return updateMachineState(eg, (s) => {
    if (!s.reviewRejects.some((x) => x.ref === ref && x.sha === sha && (x.held ?? null) === held)) s.reviewRejects.push({ ref, sha, at: new Date(now).toISOString(), reason: String(reason).slice(0, 300), ...(held ? { held } : {}) });
    s.reviewRejects = s.reviewRejects.slice(-REJECTS_MAX);
    return s;
  }, 'autopilot review reject');
}

// ───────── 用量上限（2.0.0）─────────

const limitFile = (local) => path.join(local, 'autopilot', 'limit.json');

/**
 * 記下撞到用量上限：本機的 local/autopilot/limit.json，以及同步的 machines/<mid>/autopilot.json 的 limit
 * （同一個 Claude 帳號的上限兩台共用，另一台看到之後也等重置再啟動）。同步的檔案寫入失敗不影響本機的紀錄。
 */
export async function recordLimit(eg, { at, resetAt }, log) {
  const rec = { at: new Date(at).toISOString(), resetAt: new Date(resetAt).toISOString() };
  await writeJsonAtomic(limitFile(eg.paths.local), rec);
  await updateMachineState(eg, (s) => { s.limit = rec; return s; }, 'autopilot limit').catch((err) => log?.warn?.('autopilot', `用量上限的紀錄寫入失敗：${err?.message ?? err}`));
  return rec;
}

/**
 * 排程要等到什麼時候（毫秒）：這台的本機紀錄與所有電腦同步的紀錄裡，還沒到的最晚重置時間；沒有時 null。
 * 已經過了、看不懂、或在 MAX_RESET_MS 之後的值不算。
 */
export async function limitUntil(local, vault, now = Date.now()) {
  const times = [Date.parse((await readJson(limitFile(local), null))?.resetAt ?? '')];
  for (const s of await allMachineStates(vault)) times.push(Date.parse(s.limit?.resetAt ?? ''));
  const ok = times.filter((t) => Number.isFinite(t) && t > now && t - now <= MAX_RESET_MS);
  return ok.length ? Math.max(...ok) : null;
}

/**
 * 目前還沒到期的用量上限紀錄（2.0.0，自動駕駛頁顯示「幾點之後自動繼續」）：{ at, resetAt, machine } 或 null。
 * 和 limitUntil 用同一組紀錄（這台的本機紀錄與所有電腦同步的紀錄），取重置時間最晚的那一筆；machine 是撞到上限的電腦 id。
 */
export async function activeLimit(local, vault, selfMid, now = Date.now()) {
  const rows = [];
  const own = await readJson(limitFile(local), null);
  if (own) rows.push({ ...own, machine: selfMid });
  for (const s of await allMachineStates(vault)) if (s.limit) rows.push({ ...s.limit, machine: s.mid });
  const ok = rows.map((r) => ({ at: r.at, resetAt: r.resetAt, machine: r.machine, t: Date.parse(r.resetAt ?? '') }))
    .filter((r) => typeof r.at === 'string' && Number.isFinite(r.t) && r.t > now && r.t - now <= MAX_RESET_MS)
    .sort((a, b) => b.t - a.t);
  return ok.length ? { at: ok[0].at, resetAt: ok[0].resetAt, machine: ok[0].machine } : null;
}

/** 開關改變時更新這台的啟用時間：關閉時清掉；重新開啟時從現在算起 */
export async function setEnabledState(eg, on, now = Date.now()) {
  const cur = await readMachineState(eg.paths.vault, eg.machine.id);
  if (on ? cur.enabledAt : !cur.enabledAt) return cur;
  return updateMachineState(eg, (s) => { s.enabledAt = on ? new Date(now).toISOString() : null; return s; }, on ? 'autopilot on' : 'autopilot off');
}

/**
 * 使用者復原了自動駕駛的一項：記成回饋（同步，兩台共用），之後的判斷會參考。
 * 2.0.0 第二輪審查 R7：同步的紀錄只留類別、記憶的 ref 與標題（標題在本機遮蔽疑似金鑰）；理由常引用使用者在對話裡的話
 * （對話回顧、待你確認看過使用者要求的退回），只留在這台電腦的執行紀錄（產品決定：不同步對話原文）。reason 參數不再寫入。
 */
export async function recordUndoFeedback(eg, { category, ref = null, title = '', run = null }, now = Date.now()) {
  return updateMachineState(eg, (s) => {
    s.feedback.push({ at: new Date(now).toISOString(), category: String(category).slice(0, 40), ref: ref ? String(ref).slice(0, 200) : null, title: redactSecrets(String(title)).text.slice(0, 200), reason: '', ...(run ? { run: String(run).slice(0, 40) } : {}) });
    s.feedback = trimFeedback(s.feedback);
    return s;
  }, `autopilot feedback ${category}`);
}

// ───────── 使用者的糾正（2.0.0 Q9）─────────
// 對話回顧從對話抽出使用者糾正 Claude 的話，當成學習訊號（取代沒有人按的「復原」）。
// 同步的回饋紀錄（kind: 'correction'）只記固定的分類（about，第二輪審查 N2）、日期與引句的雜湊；使用者的原話只留在這台電腦
// （local/autopilot/corrections.json）：產品決定「不同步對話原文」。整理與回顧的提示詞帶上最近 20 筆的原話。
// 第三輪審查 N2 殘留：LLM 寫的主題不進提示詞、本機也不留（主題可能被對話裡的文字誘導，原話是驗證過出自使用者的）。

const correctionsFile = (local) => path.join(local, 'autopilot', 'corrections.json');
const LOCAL_CORRECTIONS_MAX = 100;

/**
 * 記下糾正（同一則以 key 去重，延後的對話批次重新分析也不會重複）。rows：[{ key, about（同步的固定分類）, date, quote? }]
 * @returns {Promise<number>} 新記下的筆數
 */
export async function recordCorrections(eg, rows, { run = null, now = Date.now() } = {}) {
  const have = new Set((await readMachineState(eg.paths.vault, eg.machine.id)).feedback.filter((f) => f.kind === 'correction').map((f) => f.key));
  const fresh = rows.filter((r) => r?.key && !have.has(r.key) && (have.add(r.key), true));
  // 原話只存本機
  const local = (await readJson(correctionsFile(eg.paths.local), null)) ?? {};
  let localChanged = false;
  for (const r of rows) if (r?.key && r.quote && !local[r.key]) { local[r.key] = { quote: String(r.quote).slice(0, 300), date: r.date ?? null, at: new Date(now).toISOString() }; localChanged = true; }
  if (localChanged) {
    const keep = Object.entries(local).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, LOCAL_CORRECTIONS_MAX);
    await writeJsonAtomic(correctionsFile(eg.paths.local), Object.fromEntries(keep));
  }
  if (!fresh.length) return 0;
  await updateMachineState(eg, (s) => {
    for (const r of fresh) s.feedback.push({ at: new Date(now).toISOString(), kind: 'correction', category: 'correction', key: String(r.key).slice(0, 40), date: typeof r.date === 'string' ? r.date.slice(0, 10) : null, ref: null, title: String(r.about ?? '').slice(0, 200), reason: '', ...(run ? { run: String(run).slice(0, 40) } : {}) });
    s.feedback = trimFeedback(s.feedback);
    return s;
  }, 'autopilot corrections');
  return fresh.length;
}

/**
 * 最近的糾正：[{ at, date, quote }]，新的在後。只有這台電腦記下原話的才列（原話在記下時驗證過出自使用者，quoteFromUser）；
 * 不帶任何主題文字（第三輪審查 N2 殘留：舊版本機紀錄裡的主題、同步紀錄裡的 title 都不用），提示詞的段落標題就是固定的分類。
 */
export async function recentCorrections(local, feedback, n = 20) {
  const quotes = (await readJson(correctionsFile(local), null)) ?? {};
  return feedback.filter((f) => f.kind === 'correction' && typeof quotes[f.key]?.quote === 'string' && quotes[f.key].quote).slice(-n)
    .map((f) => ({ at: f.at, date: f.date ?? null, quote: quotes[f.key].quote }));
}

/** 所有電腦的回饋（新的在後） */
export async function allFeedback(vault, now = Date.now()) {
  const list = [];
  for (const s of await allMachineStates(vault)) for (const f of s.feedback) list.push({ ...f, mid: s.mid });
  return list.filter((f) => now - (Date.parse(f.at) || 0) <= 365 * DAY).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/**
 * 被復原太多次而暫停的類別：60 天內被復原 2 次以上（同一輪的復原只算一次）。
 * 使用者按「恢復」會記一筆 resume，之前的復原就不再計入。
 */
export function pausedCategories(feedback, now = Date.now()) {
  const resumedAt = new Map();
  for (const f of feedback) if (f.resume) resumedAt.set(f.category, Math.max(resumedAt.get(f.category) ?? 0, Date.parse(f.at) || 0));
  const runs = new Map();
  for (const f of feedback) {
    // 使用者的糾正（2.0.0 Q9）是學習訊號，不是復原：不會讓任何類別暫停
    if (f.resume || f.kind === 'correction') continue;
    const t = Date.parse(f.at) || 0;
    if (now - t > PAUSE_WINDOW_MS || t <= (resumedAt.get(f.category) ?? 0)) continue;
    if (!runs.has(f.category)) runs.set(f.category, new Set());
    runs.get(f.category).add(f.run ?? f.at);
  }
  return [...runs].filter(([, s]) => s.size >= PAUSE_AFTER_UNDOS).map(([k]) => k).sort();
}

/** 恢復一個暫停中的類別 */
export async function resumeCategory(eg, category, now = Date.now()) {
  return updateMachineState(eg, (s) => {
    s.feedback.push({ at: new Date(now).toISOString(), category: String(category).slice(0, 40), resume: true, title: '使用者恢復', reason: '' });
    s.feedback = trimFeedback(s.feedback);
    return s;
  }, `autopilot resume ${category}`);
}

// ───────── 本機執行紀錄 ─────────

export const runsDir = (local) => path.join(local, 'autopilot', 'runs');
const runFile = (local, id) => path.join(runsDir(local), `${id}.json`);

export async function writeRun(local, run) {
  run.updatedAt = new Date().toISOString();
  await writeJsonAtomic(runFile(local, run.id), run);
  return run;
}

export async function readRun(local, id) {
  if (!RUN_ID_RE.test(String(id ?? ''))) return null;
  return readJson(runFile(local, id), null);
}

export async function listRuns(local, { limit = 50 } = {}) {
  const names = (await fsp.readdir(runsDir(local)).catch(() => [])).filter((n) => n.endsWith('.json') && RUN_ID_RE.test(n.slice(0, -5)));
  const out = [];
  for (const n of names.sort().reverse().slice(0, limit)) {
    const r = await readJson(path.join(runsDir(local), n), null);
    if (r?.id) out.push(r);
  }
  return out;
}

export async function pruneRuns(local, now = Date.now()) {
  let removed = 0;
  for (const n of await fsp.readdir(runsDir(local)).catch(() => [])) {
    if (!n.endsWith('.json') || !RUN_ID_RE.test(n.slice(0, -5))) continue;
    const f = path.join(runsDir(local), n);
    const st = await fsp.stat(f).catch(() => null);
    if (st && now - st.mtimeMs > RUNS_KEEP_DAYS * DAY) { await fsp.rm(f, { force: true }).catch(() => {}); removed++; }
  }
  return removed;
}

// ───────── 執行鎖（一輪可能跑很久，不能用 mtime 判斷殘留：記下 pid，程序不在了才算殘留）─────────

const lockFile = (local) => path.join(local, 'autopilot', 'run.lock');

export function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/** 取得執行鎖；已經有一輪在跑時回傳 null */
export async function acquireRunLock(local, runId, now = Date.now()) {
  const f = lockFile(local);
  await fsp.mkdir(path.dirname(f), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await fsp.open(f, 'wx');
      await fh.writeFile(JSON.stringify({ pid: process.pid, run: runId, at: new Date(now).toISOString() }));
      await fh.close();
      // 釋放時只刪自己的鎖（逾時被接手後，不能刪掉別人的）
      return { release: async () => { if ((await readJson(f, null))?.run === runId) await fsp.rm(f, { force: true }).catch(() => {}); } };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const text = await fsp.readFile(f, 'utf8').catch(() => null);
      let cur = null;
      try { cur = text ? JSON.parse(text) : null; } catch { cur = null; }
      const st = await fsp.stat(f).catch(() => null);
      // 剛建立、還沒寫入內容（另一個程序正在寫）：不算殘留
      if (!cur && st && Date.now() - st.mtimeMs < 10_000) return null;
      // 鎖檔壞掉、持有的程序已結束、或超過 6 小時：視為殘留
      if (!cur || !alive(cur.pid) || now - (Date.parse(cur.at) || 0) > 6 * 3600_000) {
        // 接手權：獨占建立 run.lock.takeover，同時只有一個程序能接手；接手權本身殘留超過 30 秒就清掉
        const tk = `${f}.takeover`;
        const tst = await fsp.stat(tk).catch(() => null);
        if (tst && Date.now() - tst.mtimeMs > 30_000) await fsp.rm(tk, { force: true }).catch(() => {});
        const nonce = randomBytes(6).toString('hex');
        try { const h = await fsp.open(tk, 'wx'); await h.writeFile(nonce); await h.close(); } catch { return null; }
        try {
          // 接手權內重讀：仍是剛才判斷過期的同一份內容才刪（不是別人剛建立的新鎖）
          if (text === null || (await fsp.readFile(f, 'utf8').catch(() => null)) !== text) return null;
          await fsp.rm(f, { force: true }).catch(() => {});
        } finally {
          // 只刪自己的接手權（過期清除之後可能已經是別人的）
          if ((await fsp.readFile(tk, 'utf8').catch(() => null)) === nonce) await fsp.rm(tk, { force: true }).catch(() => {});
        }
        continue;
      }
      return null;
    }
  }
  return null;
}

export function currentLock(local) {
  try {
    const cur = JSON.parse(fs.readFileSync(lockFile(local), 'utf8'));
    return cur && alive(cur.pid) ? cur : null;
  } catch { return null; }
}
