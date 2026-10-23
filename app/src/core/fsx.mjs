// 檔案工具：安全寫入（暫存檔 + 比對 + rename）、JSON、junction。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { E, EngramError } from './errors.mjs';
import { randomBase32 } from './ids.mjs';

export function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

export function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

export async function readText(p) {
  try { return await fsp.readFile(p, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

export function readTextSync(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

// 暫存檔位置：預設放在目標旁邊；引擎 open() 會設成 ~/.engram/local/tmp（與 vault 同一磁碟區，rename 仍是原子操作），
// 避免暫存檔出現在 Claude Code 會列舉的記憶資料夾裡（R-23）。
let tempDir = null;
export function setTempDir(dir) { tempDir = dir; }

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * 安全寫入（R-08、R-23）：先寫暫存檔，取代前重讀原檔比對雜湊；不一致代表有人剛改過，放棄這次寫入。
 * 目標檔被其他程式開著（EPERM/EBUSY/EACCES）時重試數次，仍失敗就回報 busy，由呼叫端下一輪再試。
 * @param {string} p
 * @param {string} text
 * @param {{ expectHash?: string|null }} [opts] expectHash：寫入前原檔應有的 sha1；null 表示原檔應不存在；undefined 不檢查
 * @returns {Promise<{ ok: boolean, reason?: 'changed'|'busy' }>}
 */
export async function safeWriteResult(p, text, { expectHash, attempts = 6 } = {}) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const dir = tempDir && sameVolume(tempDir, p) ? tempDir : path.dirname(p);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(p)}.${randomBase32(8)}.tmp`);
  await fsp.writeFile(tmp, text, 'utf8');
  try {
    for (let i = 0; i < attempts; i++) {
      if (i) await new Promise((r) => setTimeout(r, 40 * i));
      // R-33：每一次嘗試前都重新比對；重試期間有人寫入就放棄，不覆蓋
      if (expectHash !== undefined) {
        let current;
        try { current = await readText(p); } catch (err) {
          if (BUSY.has(err.code)) continue; // M7：讀取時被獨占 → 視為忙碌，稍後再試
          throw err;
        }
        const currentHash = current === null ? null : sha1(current);
        if (currentHash !== expectHash) { await fsp.rm(tmp, { force: true }); return { ok: false, reason: 'changed' }; }
      }
      try { await fsp.rename(tmp, p); return { ok: true }; } catch (err) {
        if (!BUSY.has(err.code)) throw err;
      }
    }
    await fsp.rm(tmp, { force: true });
    return { ok: false, reason: 'busy' };
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

/** 同 safeWriteResult，只回傳是否寫入。 */
export async function safeWrite(p, text, opts) {
  return (await safeWriteResult(p, text, opts)).ok;
}

function sameVolume(a, b) {
  const ra = path.parse(path.resolve(a)).root.toLowerCase();
  const rb = path.parse(path.resolve(b)).root.toLowerCase();
  return ra === rb;
}

/** Windows 上 rename 偶爾遇到 EPERM/EBUSY（防毒、索引服務、檔案被開著），短暫重試；仍失敗回傳 false。 */
export async function renameWithRetry(from, to, attempts = 6) {
  for (let i = 0; ; i++) {
    try { await fsp.rename(from, to); return true; } catch (err) {
      if (!BUSY.has(err.code)) throw err;
      if (i >= attempts - 1) return false;
      await new Promise((r) => setTimeout(r, 40 * (i + 1)));
    }
  }
}

export async function readJson(p, fallback = null) {
  const t = await readText(p);
  if (t === null) return fallback;
  try { return JSON.parse(t.replace(/^\uFEFF/, '')); } catch { return fallback; }
}

export function readJsonSync(p, fallback = null) {
  const t = readTextSync(p);
  if (t === null) return fallback;
  try { return JSON.parse(t.replace(/^\uFEFF/, '')); } catch { return fallback; }
}

/** 穩定輸出的 JSON（兩台電腦寫出相同內容時位元組一致）。 */
export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function writeJson(p, value) {
  const r = await safeWriteResult(p, stableJson(value));
  if (!r.ok) throw new EngramError(E.LOCKED, `檔案暫時無法寫入：${path.basename(p)}`, '稍後會自動重試', { path: p, reason: r.reason }).withEn(`The file cannot be written right now: ${path.basename(p)}`, 'Engram will retry shortly');
}

/** 列出資料夾內的 .md 檔名（不含子資料夾）。 */
export async function listMarkdown(dir, { exclude = [] } = {}) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  const ex = new Set(exclude.map((s) => s.toLowerCase()));
  return entries
    .filter((e) => e.isFile() && /\.md$/i.test(e.name) && !e.name.startsWith('.') && !ex.has(e.name.toLowerCase()))
    .map((e) => e.name)
    .sort();
}

// ───────── junction ─────────

/** 路徑是否為 junction 或符號連結。 */
export function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** 讀 junction 目標（去掉 \\?\ 前綴）；不是連結時回傳 null。 */
export function linkTarget(p) {
  try {
    const t = fs.readlinkSync(p);
    return path.resolve(path.dirname(p), t.replace(/^\\\\\?\\/, ''));
  } catch { return null; }
}

/** 建立 junction（Windows 不需系統管理員權限；其他平台用目錄符號連結）。 */
export function createJunction(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(path.resolve(target), linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

/** 只移除 junction 本身，不碰目標內容。 */
export function removeJunction(linkPath) {
  if (!isLink(linkPath)) throw new Error(`不是 junction：${linkPath}`);
  // 在 Windows 上，junction 要用 rmdir 才不會遞迴到目標；unlink 對目錄連結也只移除連結本身
  try { fs.rmdirSync(linkPath); } catch { fs.unlinkSync(linkPath); }
}

/** 資料夾是否不存在或沒有任何檔案。 */
export function isEmptyDir(p) {
  try { return fs.readdirSync(p).length === 0; } catch (err) { return err.code === 'ENOENT'; }
}

/** 檔案修改時間（毫秒）；不存在回傳 0。 */
export function mtimeMs(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

/** 是否在 windowMs 內被修改過；未來時間（時鐘偏差）超過一分鐘的不算（m3）。 */
export function modifiedWithin(p, windowMs, now = Date.now()) {
  const t = mtimeMs(p);
  if (!t) return false;
  if (t > now + 60_000) return false;
  return now - t < windowMs;
}
