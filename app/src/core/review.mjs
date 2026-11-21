// 待你確認的寫入（1.4.0）：Anthropic 的記憶研究指出，每次都載入的那一層是風險最高的路徑——
// 一筆寫錯（或被對話中的惡意內容誘導寫入）的記憶，會在每個專案、每台電腦的每次對話裡被讀到。
// 範圍：全域記憶、這台電腦的單機記憶、核心準則（core/CORE.md、core/rules/*.md）。專案記憶不列（Claude Code 自動記憶本來就由 Claude 寫）。
// 紀錄：machines/<mid>/reviewed/<ref 雜湊>-<sha>.json（{ ref, sha, at }：確認時內容的 git blob sha 與時間）。任何一台確認過的版本都算確認；
// 舊版內容用 git cat-file 取回做差異。每台只寫自己的資料夾，不會衝突；每筆一個檔，記憶的變更與它的確認紀錄在同一個 commit，
// 單獨復原某一次變更時，確認紀錄跟著回到那之前，也不會和之後其他記憶的確認紀錄衝突。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJson, readText, writeJson } from './fsx.mjs';
import { git } from './git.mjs';
import { listMachineIds, machineDir } from './vault.mjs';

export const REVIEWED_DIR = 'reviewed';
const INDEX_RE = /^(INDEX|MEMORY)\.md$/i;

/** git 存放這份內容時的 blob sha（vault 的 .gitattributes 是 text=auto eol=lf，所以先把 CRLF 換成 LF） */
export function blobSha(text) {
  const buf = Buffer.from(String(text ?? '').replace(/\r\n/g, '\n'), 'utf8');
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/** 這個 ref 是不是「每次對話都會載入」、需要確認的範圍（mid：這台電腦） */
export function inReviewScope(ref, mid) {
  const p = String(ref ?? '').split('/');
  if (p.some((s) => !s || s === '.' || s === '..')) return false;
  if (p.length === 2 && p[0] === 'global') return /\.md$/i.test(p[1]) && !INDEX_RE.test(p[1]);
  if (p.length === 3 && p[0] === 'machines' && p[1] === mid) return /\.md$/i.test(p[2]) && !INDEX_RE.test(p[2]);
  if (p.length === 2 && p[0] === 'core') return p[1] === 'CORE.md';
  if (p.length === 3 && p[0] === 'core' && p[1] === 'rules') return /\.md$/i.test(p[2]);
  return false;
}

/** 範圍內目前所有的檔案（ref） */
export async function reviewScopeRefs(ctx) {
  const out = [];
  const list = async (dir, prefix) => {
    let names = [];
    try { names = (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isFile() && /\.md$/i.test(d.name)).map((d) => d.name); } catch { /* 沒有 */ }
    for (const n of names.sort()) if (inReviewScope(`${prefix}/${n}`, ctx.mid)) out.push(`${prefix}/${n}`);
  };
  await list(path.join(ctx.vault, 'global'), 'global');
  await list(machineDir(ctx.vault, ctx.mid), `machines/${ctx.mid}`);
  if (fs.existsSync(path.join(ctx.vault, 'core', 'CORE.md'))) out.push('core/CORE.md');
  await list(path.join(ctx.vault, 'core', 'rules'), 'core/rules');
  return out;
}

/** 一筆確認紀錄的檔名：ref 的雜湊＋版本 sha。只新增、不改寫：同一筆記憶每確認一個版本多一個檔，
 * 單獨復原某一次變更時不會和之後同一筆記憶的確認紀錄衝突（1.4.0 審查）。 */
export const reviewKey = (ref) => createHash('sha1').update(String(ref)).digest('hex').slice(0, 20);
// 2.0.0：同一個版本先被自動駕駛代為確認、之後才由使用者確認時，另外寫一個 -u 結尾的紀錄（不改寫原本的檔：
// 原本的檔跟著自動駕駛那次寫入的 commit，單獨復原那次寫入時不能和之後的修改衝突）
const fileName = (ref, sha, upgrade = false) => `${reviewKey(ref)}-${sha.slice(0, 12)}${upgrade ? '-u' : ''}.json`;
export const reviewedRel = (mid, ref, sha, upgrade = false) => `machines/${mid}/${REVIEWED_DIR}/${fileName(ref, sha, upgrade)}`;
const FILE_RE = /^([0-9a-f]{20})-([0-9a-f]{12})(-u)?\.json$/;

/** 每筆記憶，一台電腦只留最近這麼多個確認過的版本（紀錄不會無限增加）。更早的版本之後剛好又出現時，會再問一次 */
const KEEP_VERSIONS = 20;

/**
 * 確認的來源（2.0.0）：user（使用者在介面或 CLI 確認、--reviewed 寫入、記憶整理頁核可）、baseline（起點）、
 * request（自動駕駛在對話紀錄找到使用者的要求，而且寫入的內容與要求相符）、autopilot（其餘自動駕駛的代為確認）。
 * 舊紀錄（1.4～1.6）沒有來源：寫紀錄的那台電腦開啟自動駕駛之後寫的，當成自動駕駛代為確認（1.5／1.6 的自動駕駛
 * 「代你確認」也是寫這種紀錄）；更早的當成使用者確認（見 autopilotSince）。
 * 2.0.0 第二輪審查 R1、N1：claude（Claude 在對話裡帶 --reviewed 寫入，偵測 CLAUDECODE／CLAUDE_CODE_ENTRYPOINT）。
 * 每一種來源都讓這個版本不必再出現在「待你確認」；但只有 user 與 baseline 是偏好區塊可信的來源（TRUSTED_SOURCES）：
 * request（對話裡找到使用者的要求，相符與否只是 LLM 的判斷）、autopilot、claude 都不算使用者的規則。
 */
export const REVIEW_SOURCES = ['user', 'baseline', 'request', 'autopilot', 'claude'];
export const TRUSTED_SOURCES = ['user', 'baseline'];
const isTrusted = (by) => TRUSTED_SOURCES.includes(by);

/** 那台電腦的同步狀態檔（自動駕駛的開關與啟用時間，autopilot/state.mjs 寫入） */
const autopilotStateRel = (mid) => `machines/${mid}/autopilot.json`;
/** 記憶庫歷史裡第一次提交那台電腦自動駕駛狀態檔的時間（毫秒）：vault + mid → { at, until }。歷史不會變，找到就一直用；找不到的 1 小時後再看 */
const firstEnabledCache = new Map();
const FIRST_ENABLED_RETRY_MS = 3_600_000;

async function firstStateCommit(vaultDir, mid) {
  const key = `${vaultDir}\0${mid}`;
  const hit = firstEnabledCache.get(key);
  if (hit && (hit.at !== null || Date.now() < hit.until)) return hit.at;
  const r = await git(['log', '--diff-filter=A', '--format=%aI', '--', autopilotStateRel(mid)], { cwd: vaultDir, allowFail: true }).catch(() => null);
  const times = r?.code === 0 ? r.stdout.split('\n').map((l) => Date.parse(l.trim())).filter(Number.isFinite) : [];
  const at = times.length ? Math.min(...times) : null;
  firstEnabledCache.set(key, { at, until: Date.now() + FIRST_ENABLED_RETRY_MS });
  return at;
}

/**
 * 那台電腦從什麼時候開始用自動駕駛（毫秒；沒用過時 null）：狀態檔的 enabledAt 與記憶庫歷史裡第一次提交狀態檔的時間，取較早的。
 * enabledAt 在關閉時會被清掉、重新開啟時從那時算起（autopilot/state.mjs 的 setEnabledState），所以要看歷史：
 * 狀態檔是第一次開啟自動駕駛時建立的（之後關掉也不會刪）。
 */
async function autopilotSince(vaultDir, mid) {
  const st = await readJson(path.join(vaultDir, ...autopilotStateRel(mid).split('/')), null).catch(() => null);
  const times = [Date.parse(st?.enabledAt ?? ''), await firstStateCommit(vaultDir, mid)].filter(Number.isFinite);
  return times.length ? Math.min(...times) : null;
}

/** 一台電腦的確認紀錄：[{ ref, sha, at, by, file }] */
async function machineReviews(vaultDir, mid) {
  const dir = path.join(machineDir(vaultDir, mid), REVIEWED_DIR);
  let names = [];
  try { names = (await fsp.readdir(dir)).filter((n) => FILE_RE.test(n)); } catch { return []; }
  const out = [];
  // 分批平行讀（檔案多時逐一讀太慢，一次全開又可能用光檔案代號）
  for (let i = 0; i < names.length; i += 64) {
    const rows = await Promise.all(names.slice(i, i + 64).map(async (n) => {
      const r = await readJson(path.join(dir, n), null).catch(() => null);
      if (typeof r?.ref !== 'string' || typeof r?.sha !== 'string' || fileName(r.ref, r.sha, n.endsWith('-u.json')) !== n) return null; // 損壞或不符：當作沒有（偏安全）
      return { ref: r.ref, sha: r.sha, at: typeof r.at === 'string' ? r.at : '', by: REVIEW_SOURCES.includes(r.by) ? r.by : null, file: n };
    }));
    for (const r of rows) if (r) out.push(r);
  }
  // 沒有來源的舊紀錄：這台開始用自動駕駛之後寫的 → autopilot，更早的（或沒用過自動駕駛）→ user
  if (out.some((r) => r.by === null)) {
    const since = await autopilotSince(vaultDir, mid);
    for (const r of out) if (r.by === null) r.by = since !== null && Date.parse(r.at) > since ? 'autopilot' : 'user';
  }
  return out;
}

/**
 * 所有電腦確認過的版本：ref → { shas: Set, latest: { sha, at }, trusted: Set, trustedLatest: { sha, at }|null, sources: Map(sha → Set(來源)) }。
 * latest 是最近一次確認的版本（退回時用）；trusted 是至少有一筆由使用者本人或起點確認的版本（TRUSTED_SOURCES；偏好區塊只用這些）。
 */
export async function reviewedIndex(vaultDir) {
  const map = new Map();
  for (const mid of await listMachineIds(vaultDir)) {
    for (const r of await machineReviews(vaultDir, mid)) {
      const e = map.get(r.ref) ?? { shas: new Set(), latest: null, trusted: new Set(), trustedLatest: null, sources: new Map() };
      e.shas.add(r.sha);
      if (!e.sources.has(r.sha)) e.sources.set(r.sha, new Set());
      e.sources.get(r.sha).add(r.by);
      if (!e.latest || r.at > e.latest.at) e.latest = { sha: r.sha, at: r.at };
      if (isTrusted(r.by)) {
        e.trusted.add(r.sha);
        if (!e.trustedLatest || r.at > e.trustedLatest.at) e.trustedLatest = { sha: r.sha, at: r.at };
      }
      map.set(r.ref, e);
    }
  }
  return map;
}

/** 所有電腦確認過的版本：ref → Set<sha> */
export async function reviewedShas(vaultDir) {
  return new Map([...(await reviewedIndex(vaultDir))].map(([ref, e]) => [ref, e.shas]));
}

/**
 * 把這些 ref 目前的內容記為「這台電腦確認過」。不在範圍內的略過；檔案不存在時不動（紀錄留著）。
 * by：確認的來源（REVIEW_SOURCES），必填（第四輪審查 F-02：沒帶或不認得的值丟錯誤，不會默默變成 user，
 * 下一個漏掉來源的呼叫端會在測試裡失敗，而不是把內容記成使用者確認）。同一個版本原本只有不可信的來源（autopilot、request、claude）確認、
 * 現在由使用者或起點確認時，另外寫一個 -u 的紀錄（不改寫原本的檔；已經有不可信來源的 -u 時改寫那一個）。
 * 呼叫端負責持鎖並把回傳的路徑放進同一個 commit。沒有變更時回傳 []。
 */
export async function markReviewed(ctx, refs, { at = new Date().toISOString(), by } = {}) {
  if (!REVIEW_SOURCES.includes(by)) throw new Error(`確認紀錄要有明確的來源（${REVIEW_SOURCES.join('、')}），收到：${String(by).slice(0, 20)}`);
  const want = [...new Set(refs)].filter((r) => inReviewScope(r, ctx.mid));
  if (!want.length) return [];
  const source = by;
  const dir = path.join(machineDir(ctx.vault, ctx.mid), REVIEWED_DIR);
  const mine = await machineReviews(ctx.vault, ctx.mid);
  const changed = [];
  for (const ref of want) {
    const text = await readText(path.join(ctx.vault, ...ref.split('/')));
    // 封存或搬走的記憶：確認紀錄留著，之後從歷史還原成確認過的版本時不必再問（數量有 KEEP_VERSIONS 上限）
    if (text === null) continue;
    const sha = blobSha(text);
    const had = mine.filter((x) => x.ref === ref && x.sha === sha);
    if (had.length && (!isTrusted(source) || had.some((x) => isTrusted(x.by)))) continue;
    const upgrade = had.length > 0;
    await fsp.mkdir(dir, { recursive: true });
    await writeJson(path.join(dir, fileName(ref, sha, upgrade)), { ref, sha, at, by: source });
    changed.push(reviewedRel(ctx.mid, ref, sha, upgrade));
  }
  return changed;
}

/**
 * 每筆記憶，這台電腦只留最近 KEEP_VERSIONS 個確認過的版本；較舊的刪掉。回傳刪掉的路徑（呼叫端持鎖、自己 commit）。
 * 刻意和編輯分開成獨立的 commit：淘汰若跟著某次編輯一起 commit，復原那次編輯時可能和之後寫回的同一個紀錄檔衝突（1.4.0 審查）。
 */
export async function pruneReviews(ctx) {
  const dir = path.join(machineDir(ctx.vault, ctx.mid), REVIEWED_DIR);
  const byRef = new Map();
  for (const r of await machineReviews(ctx.vault, ctx.mid)) {
    if (!byRef.has(r.ref)) byRef.set(r.ref, []);
    byRef.get(r.ref).push(r);
  }
  const removed = [];
  for (const rows of byRef.values()) {
    if (rows.length <= KEEP_VERSIONS) continue;
    for (const r of rows.sort((a, b) => b.at.localeCompare(a.at)).slice(KEEP_VERSIONS)) {
      await fsp.rm(path.join(dir, r.file), { force: true });
      removed.push(`machines/${ctx.mid}/${REVIEWED_DIR}/${r.file}`);
    }
  }
  return removed;
}

/** 一個版本被確認過的來源裡，延續時用哪一個：使用者 > 起點 > Claude > 對話裡的要求 > 自動駕駛（可信的優先） */
const CARRY_ORDER = ['user', 'baseline', 'claude', 'request', 'autopilot'];

/**
 * Engram 自己做的改動與機械式的改寫（電腦清單、改名後的路徑、驗證日期、改連結、遮蔽金鑰、釘選、記憶畢業的去向）：
 * 改動前的內容確認過，改動後也算確認過；沒確認過的維持待確認。before：ref → 改動前的內容。
 * 來源延續原本的（第四輪審查 F-02）：起點延續成起點、使用者延續成使用者、claude／request／autopilot 延續成原本的值；
 * 同一個版本有好幾種來源時依 CARRY_ORDER 取一個。這是「在 Claude Code 裡執行的指令不產生 user」的例外：
 * 改的只是日期、連結、釘選、路徑、遮蔽這類不改變內容意思的地方，原本是使用者確認的，改完仍是使用者確認的。
 */
export async function carryReviewed(ctx, before) {
  const idx = await reviewedIndex(ctx.vault);
  const keep = [...before].filter(([ref, text]) => typeof text === 'string' && inReviewScope(ref, ctx.mid) && idx.get(ref)?.shas.has(blobSha(text)));
  const groups = new Map();
  for (const [ref, text] of keep) {
    const had = idx.get(ref).sources.get(blobSha(text)) ?? new Set();
    const by = CARRY_ORDER.find((s) => had.has(s)) ?? 'autopilot';
    if (!groups.has(by)) groups.set(by, []);
    groups.get(by).push(ref);
  }
  const out = [];
  for (const [by, refs] of groups) out.push(...await markReviewed(ctx, refs, { by }));
  return out;
}

/**
 * 還沒確認的內容：目前內容的 sha 不在任何一台電腦的確認紀錄裡。
 * @returns {Promise<{ ref: string, sha: string, previous: string|null }[]>} previous：目前內容之前，最近一次確認過的版本（新增的為 null）
 */
export async function pendingReviews(ctx) {
  const idx = await reviewedIndex(ctx.vault);
  const out = [];
  for (const ref of await reviewScopeRefs(ctx)) {
    const text = await readText(path.join(ctx.vault, ...ref.split('/')));
    if (text === null) continue;
    const sha = blobSha(text);
    const e = idx.get(ref);
    if (e?.shas.has(sha)) continue;
    const h = e ? await lastReviewedInHistory(ctx.vault, ref, sha, e.shas) : null;
    out.push({ ref, sha, previous: h === RECREATED ? null : (h ?? e?.latest?.sha ?? null) });
  }
  return out;
}

const RECREATED = Symbol('recreated');

/**
 * 從這個檔案的變更紀錄（由新到舊）找目前內容之前、最近一次確認過的版本。使用者把內容改回較早確認過的版本後
 * Claude 又改了，「上一版」與「退回」要回到使用者最後看到的那一版，不是最後寫下確認紀錄的那一版（1.4.0 審查）。
 * -m：兩台電腦同時修改後合併出來的版本只出現在合併 commit，也要看得到。
 * 這個檔案在封存之後又用同一個名稱新建時回傳 RECREATED：更早的版本屬於另一筆記憶，當成新增（退回＝封存新的這筆）。
 * 找不到時 null（呼叫端改用最後寫下的確認紀錄）。
 */
async function lastReviewedInHistory(vaultDir, ref, current, shas) {
  const r = await git(['log', '-m', '-n200', '--format=%x01%P', '--raw', '--no-abbrev', '--no-renames', '--', ref], { cwd: vaultDir, allowFail: true });
  if (r.code !== 0) return null;
  let merge = false;
  let first = true;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('\x01')) { merge = line.slice(1).trim().split(/\s+/).filter(Boolean).length > 1; continue; }
    const m = /^:\d{6} \d{6} ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])/.exec(line);
    if (!m) continue;
    // 最近一次 commit 是刪除，檔案卻在：封存後又新建、還沒 commit
    if (first && m[3] === 'D' && !merge) return RECREATED;
    first = false;
    for (const s of [m[2], m[1]]) if (s !== current && shas.has(s)) return s;
    if (m[3] === 'A' && !merge) return RECREATED;
  }
  return null;
}

/** 取回某個版本的內容（git 裡沒有這個 blob 時 null） */
export async function blobText(vaultDir, sha) {
  if (!/^[0-9a-f]{40}$/.test(String(sha ?? ''))) return null;
  const r = await git(['cat-file', 'blob', sha], { cwd: vaultDir, allowFail: true });
  return r.code === 0 ? r.stdout : null;
}

/** 起點：這台電腦第一次執行 1.4.0 時建立（只做一次，記在 local/review.json） */
export async function needsBaseline(ctx) {
  const st = await readJson(path.join(ctx.local, 'review.json'), null);
  return !st?.baselineAt;
}

/**
 * 起點要記為確認過的內容。第一台：範圍內現有的全部。之後的電腦（別台已經有確認紀錄）：只有自己的單機記憶，
 * 全域與核心準則沿用其他電腦的紀錄，不會把別台還在等確認的內容洗成確認過（1.4.0 審查）。
 */
export async function baselineRefs(ctx) {
  const refs = await reviewScopeRefs(ctx);
  let others = false;
  for (const mid of await listMachineIds(ctx.vault)) {
    if (mid !== ctx.mid && (await machineReviews(ctx.vault, mid)).length) { others = true; break; }
  }
  return others ? refs.filter((r) => r.startsWith(`machines/${ctx.mid}/`)) : refs;
}

export async function recordBaseline(ctx) {
  await writeJson(path.join(ctx.local, 'review.json'), { baselineAt: new Date().toISOString() });
}
