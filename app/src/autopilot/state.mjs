// 自動駕駛的狀態（1.5.0）。
// - 每台電腦一份同步的狀態檔 vault/machines/<mid>/autopilot.json：啟用時間、上次執行、復原回饋；
//   1.6.0 加上範圍整理紀錄（scopes）與審核員的拒絕（reviewRejects）。
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

const DAY = 86_400_000;
/** 同一類動作在這段時間內被復原幾次就暫停（只記錄、不執行） */
export const PAUSE_AFTER_UNDOS = 2;
export const PAUSE_WINDOW_MS = 60 * DAY;
const FEEDBACK_MAX = 100;
const REJECTS_MAX = 200;
const SCOPE_KEY_RE = /^(global|core|machine:[a-z0-9][a-z0-9-]{0,63}|project:[a-z0-9][a-z0-9-]{0,63})$/;
const SCOPES_MAX = 500;
const KNOWN = new Set(['v', 'enabledAt', 'lastRunAt', 'lastRunId', 'feedback', 'scopes', 'reviewRejects']);
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

function normalize(j) {
  // 不認得的欄位原樣保留（之後的版本新增的欄位，不會在這一版改寫狀態檔時被丟掉）；數量或大小超過上限就整批不留，避免檔案被塞大
  let extra = {};
  if (j && typeof j === 'object' && !Array.isArray(j)) for (const [k, val] of Object.entries(j)) if (!KNOWN.has(k) && val !== undefined) extra[k] = val;
  if (Object.keys(extra).length > EXTRA_KEYS_MAX || JSON.stringify(extra).length > EXTRA_BYTES_MAX) extra = {};
  return {
    ...extra,
    v: 1,
    enabledAt: j?.enabledAt ?? null,
    lastRunAt: j?.lastRunAt ?? null,
    lastRunId: j?.lastRunId ?? null,
    feedback: Array.isArray(j?.feedback) ? j.feedback.filter((f) => f && typeof f.category === 'string').slice(-FEEDBACK_MAX) : [],
    scopes: normalizeScopes(j?.scopes),
    reviewRejects: normalizeRejects(j?.reviewRejects),
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

/** 開關改變時更新這台的啟用時間：關閉時清掉；重新開啟時從現在算起 */
export async function setEnabledState(eg, on, now = Date.now()) {
  const cur = await readMachineState(eg.paths.vault, eg.machine.id);
  if (on ? cur.enabledAt : !cur.enabledAt) return cur;
  return updateMachineState(eg, (s) => { s.enabledAt = on ? new Date(now).toISOString() : null; return s; }, on ? 'autopilot on' : 'autopilot off');
}

/** 使用者復原了自動駕駛的一項：記成回饋（同步，兩台共用），之後的判斷會參考 */
export async function recordUndoFeedback(eg, { category, ref = null, title = '', reason = '', run = null }, now = Date.now()) {
  return updateMachineState(eg, (s) => {
    s.feedback.push({ at: new Date(now).toISOString(), category: String(category).slice(0, 40), ref: ref ? String(ref).slice(0, 200) : null, title: String(title).slice(0, 200), reason: String(reason).slice(0, 300), ...(run ? { run: String(run).slice(0, 40) } : {}) });
    s.feedback = s.feedback.slice(-FEEDBACK_MAX);
    return s;
  }, `autopilot feedback ${category}`);
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
    if (f.resume) continue;
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
    s.feedback = s.feedback.slice(-FEEDBACK_MAX);
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
