// 同步自我修復（S2）。同一種非離線錯誤連續 3 次後診斷「哪些檔案擋住合併、為什麼沒被提交」；
// 擋住合併的全是被扣住（疑似金鑰）的檔案時：備份 → 暫時移開 → 合併 → 放回原位。
// 不變式：本機版本絕不丟掉。一律用 copyFile／rename 搬位元組（不經過文字讀寫、不 stage、不用 reset／checkout／stash）；
// 任何一步失敗都把檔案放回原位；程序在途中被終止時，標記檔 local/heal-pending.json 讓下一輪同步一開始就放回原位。
// 放回原位時如果原位的內容不是合併剛帶進來的（這段期間有人改過），先把目前的內容另存到 local/backup 再放回。
import fs from 'node:fs';
import path from 'node:path';
import { E, EngramError } from './errors.mjs';
import { quarantine } from './conflicts.mjs';
import { readJson, writeJson } from './fsx.mjs';
import { git } from './git.mjs';
import { backupFile, backupRoot, stampOf, writeBackupMarker } from './healbackup.mjs';
import { loadAllow, scanWithAllow } from './secretallow.mjs';
import { redactSecrets } from './secrets.mjs';

export { HEAL_BACKUP_KEEP_MS, pruneHealBackups } from './healbackup.mjs';

/** 同一種錯誤連續幾次後開始診斷與修復 */
export const SELF_HEAL_AFTER = 3;
const MAX_LISTED = 50;

const iso = (t) => new Date(t).toISOString();
const markerPath = (ctx) => path.join(ctx.local, 'heal-pending.json');
const tmpRoot = (ctx) => path.join(ctx.local, 'tmp');
const within = (root, p) => {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};
/** 檔案系統操作（測試可以注入失敗，例如模擬 Windows 上檔案被防毒鎖住） */
const REAL_IO = { rename: fs.renameSync, copyFile: fs.copyFileSync };

/** 從 git merge 的錯誤訊息取出擋住合併的檔案（「本機有未提交的修改」與「未追蹤的檔案」兩種訊息格式相同：標題行後面每行一個縮排的路徑） */
export function parseOverwriteBlockers(text) {
  const out = [];
  let listing = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/would be overwritten by (merge|checkout)/i.test(line)) { listing = true; continue; }
    if (!listing) continue;
    if (/^\s+\S/.test(line)) out.push(line.trim().replace(/\\/g, '/'));
    else listing = false;
  }
  return [...new Set(out)];
}

/** 一個沒被提交的路徑為什麼沒被提交（planCommit 的分類） */
function reasonOf(plan, ref) {
  const secret = plan.secrets.find((s) => s.ref === ref);
  if (secret) return { ref, reason: 'secret', kinds: secret.kinds };
  if (plan.recent.includes(ref)) return { ref, reason: 'recent' };
  if (plan.held.some((h) => h.refs.includes(ref))) return { ref, reason: 'held-deletion' };
  if (plan.unmerged.includes(ref)) return { ref, reason: 'unmerged' };
  return { ref, reason: 'uncommitted' };
}

/** 這一輪沒被提交的所有路徑與原因：被扣住的疑似金鑰檔、剛被修改的檔案、被扣住的大量刪除、未解決的合併 */
export function describeUncommitted(plan) {
  const refs = [...plan.secrets.map((s) => s.ref), ...plan.recent, ...plan.held.flatMap((h) => h.refs), ...plan.unmerged];
  return [...new Set(refs)].slice(0, MAX_LISTED).map((ref) => reasonOf(plan, ref));
}

/** 診斷：git 指名擋住合併的檔案（blockers）、這一輪沒被提交的所有路徑（uncommitted）、已自動處理的檔案（healed） */
export function buildDiagnosis(plan, blockers = [], now = Date.now()) {
  return { at: iso(now), blockers: blockers.map((ref) => reasonOf(plan, ref)), uncommitted: describeUncommitted(plan), healed: [] };
}

/**
 * 原位目前的內容是不是合併剛帶進來的（等於 HEAD 的版本）。比對 git 的物件雜湊；
 * 不知道合併後的版本（標記檔沒有 headBlob）或算不出來時一律當成「不一樣」，寧可多備份一份。
 */
async function sameAsMerged(ctx, e) {
  if (typeof e.headBlob !== 'string' || !e.headBlob) return false;
  const r = await git(['hash-object', '--', e.ref], { cwd: ctx.vault, allowFail: true });
  return r.code === 0 && r.stdout.trim() === e.headBlob;
}

/**
 * 把暫移的檔案放回原位；回傳 { failed, preserved }。
 * 放回之前如果原位已經有檔案、而且不是合併剛帶進來的版本（這段期間被改過），先把目前的內容另存到 local/backup，再覆蓋。
 * rename 失敗時退回用備份複製（再保留原本的修改時間）。
 */
async function restoreEntries(ctx, entries, io = REAL_IO) {
  const failed = [];
  const preserved = [];
  for (const e of entries) {
    if (!fs.existsSync(e.aside)) {
      // 已經放回去了；或暫存的本機版本不見了（暫存資料夾被清掉）而原位也是空的：用備份補回，不能把它當成已經放回去
      if (fs.existsSync(e.original) || !fs.existsSync(e.backup)) continue;
      try {
        fs.mkdirSync(path.dirname(e.original), { recursive: true });
        const st = fs.statSync(e.backup);
        io.copyFile(e.backup, e.original, fs.constants.COPYFILE_EXCL);
        fs.utimesSync(e.original, st.atime, st.mtime);
      } catch (err) {
        failed.push({ ref: e.ref, error: err.message });
      }
      continue;
    }
    try {
      if (fs.existsSync(e.original) && !(await sameAsMerged(ctx, e))) {
        preserved.push({ ref: e.ref, backup: backupFile(ctx, e.original, e.ref, { source: 'heal-restore' }) });
      }
      fs.mkdirSync(path.dirname(e.original), { recursive: true });
      try {
        io.rename(e.aside, e.original);
      } catch {
        io.copyFile(e.backup, e.original);
        const st = fs.statSync(e.backup);
        fs.utimesSync(e.original, st.atime, st.mtime);
        fs.rmSync(e.aside, { force: true });
      }
    } catch (err) {
      failed.push({ ref: e.ref, error: err.message });
    }
  }
  return { failed, preserved };
}

/** 刪掉 local/tmp 裡已經空了的 heal-* 暫存資料夾（還有檔案的留著：那是還沒放回去的本機版本） */
function pruneAside(ctx) {
  const root = tmpRoot(ctx);
  let names = [];
  try { names = fs.readdirSync(root); } catch { return; }
  const hasFile = (dir) => fs.readdirSync(dir, { withFileTypes: true }).some((d) => (d.isDirectory() ? hasFile(path.join(dir, d.name)) : true));
  for (const n of names.filter((x) => x.startsWith('heal-'))) {
    const dir = path.join(root, n);
    try { if (!hasFile(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 下次再清 */ }
  }
}

/**
 * 擋住合併的檔案全是被扣住的檔案時修復。回傳 merged：是否已經合併完成（呼叫端略過原本的合併）；
 * 合併沒完成時檔案都已放回原位、維持原狀，呼叫端照常回報原本的錯誤。
 * 合併完成但檔案放不回去時丟 E_CONFLICT（標記檔留著，記下合併後 HEAD 的版本；下一輪同步會再放）：
 * 絕不能讓後面的存檔把「暫時不在」當成刪除提交出去。
 * 放回之前，如果這次合併讓同一個檔案在 HEAD 的內容和合併前不同（對方改過它），把對方的版本存進衝突隔離區
 * （vault/conflicts/cf_*，使用者或自動駕駛用既有的流程選本機、對方或合併）：「不同意不等於丟掉」，
 * 之後使用者清掉疑似金鑰再提交時，對方的修改才不會無聲無息被蓋掉。建不起來就另存到 local/backup/<時間>/theirs/。
 * @param {object} ctx
 * @param {{ blockers: string[], plan: object, merge: () => Promise<void>, headBefore?: string, theirsRef?: string, quarantineRecord?: Function, io?: { rename: Function, copyFile: Function }, now?: number }} opts
 *   merge：重新執行合併並收尾（解衝突、commit）；失敗要丟例外，並自行 abort 合併
 *   headBefore：合併前的 HEAD（判斷對方有沒有改過那個檔案）；theirsRef：對方的分支（對方的版本取自這裡，沒有就用合併後的 HEAD）
 *   quarantineRecord：建立衝突紀錄的函式（測試用，預設是 conflicts.mjs 的 quarantine）；io：搬檔案的函式（測試用，可以注入失敗）
 * @returns {Promise<{ merged: boolean, diagnosis: object }>}
 */
export async function healBlockedMerge(ctx, { blockers, plan, merge, headBefore, theirsRef, quarantineRecord = quarantine, io = REAL_IO, now = Date.now() }) {
  const diagnosis = buildDiagnosis(plan, blockers, now);
  const held = new Set(plan.secrets.map((s) => s.ref));
  if (!blockers.length || !blockers.every((b) => held.has(b))) return { merged: false, diagnosis: { ...diagnosis, note: 'not-held-files' } };

  const stamp = stampOf(now);
  const entries = blockers.map((ref) => ({
    ref,
    original: path.join(ctx.vault, ...ref.split('/')),
    backup: path.join(backupRoot(ctx), stamp, ...ref.split('/')),
    aside: path.join(tmpRoot(ctx), `heal-${stamp}`, ...ref.split('/')),
  }));
  const markerBody = (extra = {}) => ({ v: 1, at: iso(now), files: entries.map(({ ref, original, aside, backup, headBlob }) => ({ ref, original, aside, backup, ...(headBlob !== undefined ? { headBlob } : {}) })), ...extra });

  // 1. 備份並逐位元組驗證（保留相對路徑與修改時間）。這一步失敗時什麼都還沒動。
  //    資料夾裡先寫標記檔：之後的清理只刪有這個標記檔、名稱是時間戳記的資料夾（pruneHealBackups）
  try {
    writeBackupMarker(path.join(backupRoot(ctx), stamp), { now, files: blockers, source: 'heal' });
    for (const e of entries) {
      const st = fs.lstatSync(e.original);
      if (!st.isFile()) throw new Error(`不是一般檔案：${e.ref}`);
      fs.mkdirSync(path.dirname(e.backup), { recursive: true });
      fs.copyFileSync(e.original, e.backup, fs.constants.COPYFILE_EXCL);
      fs.utimesSync(e.backup, st.atime, st.mtime);
      if (!fs.readFileSync(e.original).equals(fs.readFileSync(e.backup))) throw new Error(`備份內容與原檔不一致：${e.ref}`);
    }
  } catch (err) {
    return { merged: false, diagnosis: { ...diagnosis, healFailed: `備份失敗：${err.message}` } };
  }

  // 2. 標記（程序被終止時，下一輪同步據此放回原位）→ 暫時移開 → 合併
  try {
    await writeJson(markerPath(ctx), markerBody());
    if (!fs.existsSync(markerPath(ctx))) throw new Error('寫不進標記檔');
    for (const e of entries) {
      fs.mkdirSync(path.dirname(e.aside), { recursive: true });
      io.rename(e.original, e.aside);
    }
    await merge();
  } catch (err) {
    const { failed } = await restoreEntries(ctx, entries, io);
    if (!failed.length) fs.rmSync(markerPath(ctx), { force: true });
    pruneAside(ctx);
    return { merged: false, diagnosis: { ...diagnosis, healFailed: `${err.message}`, ...(failed.length ? { restoreFailed: failed } : {}) } };
  }

  // 3. 合併完成：記下每個檔案在 HEAD 的版本（放回失敗、下一輪重試時，用來分辨原位是「合併帶進來的」還是「這段期間被改過的」）
  for (const e of entries) {
    const r = await git(['rev-parse', '--verify', '-q', `HEAD:${e.ref}`], { cwd: ctx.vault, allowFail: true });
    e.headBlob = r.code === 0 ? r.stdout.trim() : null;
  }
  await writeJson(markerPath(ctx), markerBody({ phase: 'merged' })).catch(() => {});

  // 4. 對方改過同一個檔案的話，放回原位（會蓋掉合併帶進來的對方版本）之前先把對方的版本留下來
  const theirs = new Map();
  for (const e of entries) {
    const kept = await keepTheirs(ctx, e, { headBefore, theirsRef, stamp, quarantineRecord });
    if (kept) theirs.set(e.ref, kept);
  }

  // 5. 放回原位（本機版本照舊被扣住）
  const { failed, preserved } = await restoreEntries(ctx, entries, io);
  if (failed.length) {
    throw new EngramError(E.CONFLICT, '合併完成了，但被扣住的檔案還沒放回原位，下一輪同步會再試', `備份在 ${path.join(backupRoot(ctx), stamp)}`, { files: failed })
      .withEn('The merge finished, but the withheld files have not been put back yet. The next sync will try again', `A backup is in ${path.join(backupRoot(ctx), stamp)}`);
  }
  fs.rmSync(markerPath(ctx), { force: true });
  pruneAside(ctx);
  diagnosis.healed = entries.map((e) => ({ ref: e.ref, backup: path.relative(ctx.local, e.backup).replace(/\\/g, '/'), ...(theirs.has(e.ref) ? { theirs: theirs.get(e.ref) } : {}) }));
  if (preserved.length) diagnosis.preserved = preserved;
  return { merged: true, diagnosis };
}

/**
 * 合併讓這個檔案在 HEAD 的內容和合併前不同（對方改過、新增或刪除了它）時，把對方的版本存進衝突隔離區。
 * 紀錄裡的本機版本先遮蔽疑似金鑰（衝突隔離區會跟著同步，原檔仍被扣住、只在這台電腦；遮蔽後還偵測到就不放）。
 * 紀錄標明來源（by: 'heal'）與對應的備份資料夾（healBackup）：自動駕駛不處理這種紀錄、備份在紀錄還在時不被清理。
 * 不丟例外：衝突紀錄建不起來就把對方的版本另存到 local/backup/<時間>/theirs/<相對路徑>，修復本身不受影響。
 * @returns {Promise<null | { kind: 'conflict', id: string } | { kind: 'backup', path: string, error: string } | { kind: 'none', error: string }>}
 */
async function keepTheirs(ctx, e, { headBefore, theirsRef, stamp, quarantineRecord }) {
  let theirs = null;
  try {
    const show = async (rev) => {
      const r = await git(['show', `${rev}:${e.ref}`], { cwd: ctx.vault, allowFail: true });
      return r.code === 0 ? r.stdout : null;
    };
    const before = headBefore ? await show(headBefore) : null;
    const head = await show('HEAD');
    if (head === before) return null; // 合併沒有改到這個檔案（兩邊都不存在也算）
    theirs = head === null ? null : ((theirsRef ? await show(theirsRef) : null) ?? head);
    const localText = fs.readFileSync(e.backup, 'utf8');
    let ours = redactSecrets(localText).text;
    if (scanWithAllow(ours, e.ref, await loadAllow(ctx.local)).length) ours = null;
    const deleted = theirs === null;
    const id = await quarantineRecord(ctx.vault, {
      ref: e.ref,
      kind: deleted ? 'modify-delete' : 'content',
      ours,
      theirs,
      base: before,
      by: 'heal',
      healBackup: stamp,
      summary: deleted
        ? `另一台電腦刪除了這筆記憶，但這台有修改（疑似含有金鑰，被扣住沒有同步），已保留本機版本；這裡的本機版本已遮蔽金鑰，原檔在這台電腦`
        : `${e.ref} 的本機版本疑似含有金鑰，被扣住沒有同步；另一台電腦也修改了這個檔案，對方的版本保留在這裡。這裡的本機版本已遮蔽金鑰，原檔仍在這台電腦`,
      summaryEn: deleted
        ? "The other computer deleted this memory, but this computer modified it (it may contain a secret and is withheld from sync), so this computer's version was kept. The local version here has its secrets masked; the original file stays on this computer"
        : `This computer's version of ${e.ref} may contain a secret and is withheld from sync, and the other computer also modified the file, so its version is kept here. The local version here has its secrets masked; the original file stays on this computer`,
    });
    return { kind: 'conflict', id };
  } catch (err) {
    if (theirs === null) return { kind: 'none', error: err.message };
    try {
      const dest = path.join(backupRoot(ctx), stamp, 'theirs', ...e.ref.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, theirs, 'utf8');
      return { kind: 'backup', path: path.relative(ctx.local, dest).replace(/\\/g, '/'), error: err.message };
    } catch (err2) {
      return { kind: 'none', error: `${err.message}；另存也失敗：${err2.message}` };
    }
  }
}

/**
 * 同步一開始呼叫：上一輪在暫移途中被終止（或放回失敗）時，把本機版本放回原位。
 * 標記檔記著合併後 HEAD 的版本（headBlob）：原位的內容和它不同（這段期間有人改過那筆記憶）時，
 * 先把目前的內容另存到 local/backup 再放回，回報在 preserved。
 */
export async function recoverHeal(ctx, { io = REAL_IO } = {}) {
  const marker = await readJson(markerPath(ctx), null);
  if (!Array.isArray(marker?.files)) return { recovered: false };
  const entries = marker.files.filter((f) => f && within(ctx.vault, f.original) && within(ctx.local, f.aside) && within(ctx.local, f.backup));
  const { failed, preserved } = await restoreEntries(ctx, entries, io);
  if (failed.length) {
    throw new EngramError(E.CONFLICT, '上一輪暫時移開的檔案還沒能放回原位，這一輪先不繼續', `本機版本在 ${ctx.local} 的 tmp 與 backup 底下`, { files: failed })
      .withEn('Files set aside during the previous round could not be put back yet, so this round does not continue', `The local versions are under tmp and backup in ${ctx.local}`);
  }
  fs.rmSync(markerPath(ctx), { force: true });
  pruneAside(ctx);
  return { recovered: true, files: entries.map((e) => e.ref), preserved };
}
