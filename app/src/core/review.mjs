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
const fileName = (ref, sha) => `${reviewKey(ref)}-${sha.slice(0, 12)}.json`;
export const reviewedRel = (mid, ref, sha) => `machines/${mid}/${REVIEWED_DIR}/${fileName(ref, sha)}`;
const FILE_RE = /^([0-9a-f]{20})-([0-9a-f]{12})\.json$/;

/** 每筆記憶，一台電腦只留最近這麼多個確認過的版本（紀錄不會無限增加）。更早的版本之後剛好又出現時，會再問一次 */
const KEEP_VERSIONS = 20;

/** 一台電腦的確認紀錄：[{ ref, sha, at, file }] */
async function machineReviews(vaultDir, mid) {
  const dir = path.join(machineDir(vaultDir, mid), REVIEWED_DIR);
  let names = [];
  try { names = (await fsp.readdir(dir)).filter((n) => FILE_RE.test(n)); } catch { return []; }
  const out = [];
  // 分批平行讀（檔案多時逐一讀太慢，一次全開又可能用光檔案代號）
  for (let i = 0; i < names.length; i += 64) {
    const rows = await Promise.all(names.slice(i, i + 64).map(async (n) => {
      const r = await readJson(path.join(dir, n), null).catch(() => null);
      if (typeof r?.ref !== 'string' || typeof r?.sha !== 'string' || fileName(r.ref, r.sha) !== n) return null; // 損壞或不符：當作沒有（偏安全）
      return { ref: r.ref, sha: r.sha, at: typeof r.at === 'string' ? r.at : '', file: n };
    }));
    for (const r of rows) if (r) out.push(r);
  }
  return out;
}

/** 所有電腦確認過的版本：ref → { shas: Set, latest: { sha, at } }（latest 是最近一次確認的版本，退回時用） */
export async function reviewedIndex(vaultDir) {
  const map = new Map();
  for (const mid of await listMachineIds(vaultDir)) {
    for (const r of await machineReviews(vaultDir, mid)) {
      const e = map.get(r.ref) ?? { shas: new Set(), latest: null };
      e.shas.add(r.sha);
      if (!e.latest || r.at > e.latest.at) e.latest = { sha: r.sha, at: r.at };
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
 * 呼叫端負責持鎖並把回傳的路徑放進同一個 commit。沒有變更時回傳 []。
 */
export async function markReviewed(ctx, refs, { at = new Date().toISOString() } = {}) {
  const want = [...new Set(refs)].filter((r) => inReviewScope(r, ctx.mid));
  if (!want.length) return [];
  const dir = path.join(machineDir(ctx.vault, ctx.mid), REVIEWED_DIR);
  const mine = await machineReviews(ctx.vault, ctx.mid);
  const changed = [];
  for (const ref of want) {
    const text = await readText(path.join(ctx.vault, ...ref.split('/')));
    // 封存或搬走的記憶：確認紀錄留著，之後從歷史還原成確認過的版本時不必再問（數量有 KEEP_VERSIONS 上限）
    if (text === null) continue;
    const sha = blobSha(text);
    if (mine.some((x) => x.ref === ref && x.sha === sha)) continue;
    await fsp.mkdir(dir, { recursive: true });
    await writeJson(path.join(dir, fileName(ref, sha)), { ref, sha, at });
    changed.push(reviewedRel(ctx.mid, ref, sha));
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

/**
 * Engram 自己做的改動與機械式的改寫（電腦清單、改名後的路徑、驗證日期、改連結、遮蔽金鑰、釘選）：
 * 改動前的內容確認過，改動後也算確認過；沒確認過的維持待確認。before：ref → 改動前的內容。
 */
export async function carryReviewed(ctx, before) {
  const all = await reviewedShas(ctx.vault);
  const keep = [...before].filter(([ref, text]) => typeof text === 'string' && inReviewScope(ref, ctx.mid) && all.get(ref)?.has(blobSha(text))).map(([ref]) => ref);
  return markReviewed(ctx, keep);
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
