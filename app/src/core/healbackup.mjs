// 自我修復的備份（local/backup/<時間>/）：自我修復暫移被扣住的檔案之前、解衝突要覆蓋有未提交內容的原檔之前，
// 都先把原檔原封不動（逐位元組、保留修改時間）存在這裡。資料夾名稱是時間戳記，裡面有 heal-backup.json 標記檔；
// 每週的 gc 只清「名稱是時間戳記而且有標記檔」、超過 30 天、而且對應的衝突紀錄已經不在的資料夾。
// 這個模組不匯入 conflicts.mjs 或 heal.mjs（兩邊都會用它），所以標記檔與衝突紀錄都直接用 fs 讀。
import fs from 'node:fs';
import path from 'node:path';
import { E, EngramError } from './errors.mjs';
import { readJson } from './fsx.mjs';

export const BACKUP_MARKER = 'heal-backup.json';
export const HEAL_BACKUP_KEEP_MS = 30 * 24 * 3600_000;
const STAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/;

/** 20261120T153012123Z */
export const stampOf = (t) => new Date(t).toISOString().replace(/[-:.]/g, '');
export const backupRoot = (ctx) => path.join(ctx.local, 'backup');

/** 在備份資料夾裡寫標記檔（已經有就不動） */
export function writeBackupMarker(dir, { now = Date.now(), files = [], source = 'heal' } = {}) {
  const marker = path.join(dir, BACKUP_MARKER);
  if (fs.existsSync(marker)) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ v: 1, kind: 'heal-backup', source, at: new Date(now).toISOString(), files }));
}

/**
 * 把檔案原封不動另存到 local/backup/<時間>/<相對路徑>（同一個時間戳記已經有這個檔案就換下一個毫秒）。
 * 複製後逐位元組比對；失敗丟 E_CONFLICT，呼叫端不能在沒有備份的情況下覆蓋原檔。
 * @returns {string} 相對於 local/ 的備份位置，例如 backup/20261120T153012123Z/global/a.md
 */
export function backupFile(ctx, abs, ref, { now = Date.now(), source = 'resolve' } = {}) {
  try {
    let t = now;
    let stamp = stampOf(t);
    let dest = path.join(backupRoot(ctx), stamp, ...ref.split('/'));
    while (fs.existsSync(dest)) { t += 1; stamp = stampOf(t); dest = path.join(backupRoot(ctx), stamp, ...ref.split('/')); }
    const st = fs.statSync(abs);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeBackupMarker(path.join(backupRoot(ctx), stamp), { now: t, files: [ref], source });
    fs.copyFileSync(abs, dest, fs.constants.COPYFILE_EXCL);
    fs.utimesSync(dest, st.atime, st.mtime);
    if (!fs.readFileSync(abs).equals(fs.readFileSync(dest))) throw new Error('備份內容與原檔不一致');
    return `backup/${stamp}/${ref}`;
  } catch (err) {
    throw new EngramError(E.CONFLICT, `沒能先備份 ${ref} 目前的內容，為了不丟掉這台電腦上還沒同步的版本，這次沒有處理：${err.message}`, '檢查 local/backup 是否可以寫入，再試一次')
      .withEn(`Could not back up the current content of ${ref} first, so nothing was changed to avoid losing the version that has not been synced: ${err.message}`, 'Check that local/backup is writable and try again');
  }
}

/** 衝突紀錄（vault/conflicts/cf_*）指向的自我修復備份資料夾名稱：紀錄還在，備份就不能刪 */
function referencedByConflicts(ctx) {
  const used = new Set();
  const root = path.join(ctx.vault, 'conflicts');
  let ids = [];
  try { ids = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('cf_')).map((d) => d.name); } catch { return used; }
  for (const id of ids) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, id, 'meta.json'), 'utf8'));
      if (typeof meta?.healBackup === 'string') used.add(meta.healBackup);
    } catch { /* 沒有或壞掉的 meta：略過 */ }
  }
  return used;
}

/**
 * 清掉超過 30 天的自我修復備份（每週的 gc 工作呼叫）。只刪這個功能自己建立的資料夾：名稱是時間戳記、
 * 資料夾裡有 heal-backup.json 標記檔；時間看名稱（不看修改時間）。不刪：還沒完成的修復（local/heal-pending.json）
 * 指向的備份、對應的衝突紀錄還在的備份（使用者還沒決定，原檔可能還要靠它找回）。
 * @returns {Promise<number>} 刪掉幾個資料夾
 */
export async function pruneHealBackups(ctx, { now = Date.now(), keepMs = HEAL_BACKUP_KEEP_MS } = {}) {
  const root = backupRoot(ctx);
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return 0; }
  const pending = await readJson(path.join(ctx.local, 'heal-pending.json'), null);
  const inside = (dir, p) => { const rel = path.relative(dir, p); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
  const inUse = (dir) => Array.isArray(pending?.files) && pending.files.some((f) => typeof f?.backup === 'string' && inside(dir, f.backup));
  const referenced = referencedByConflicts(ctx);
  let removed = 0;
  for (const d of dirs) {
    const m = STAMP_RE.exec(d.name);
    if (!m) continue;
    const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
    const dir = path.join(root, d.name);
    if (!(now - at > keepMs) || !fs.existsSync(path.join(dir, BACKUP_MARKER)) || inUse(dir) || referenced.has(d.name)) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); removed++; } catch { /* 下週再試 */ }
  }
  return removed;
}
