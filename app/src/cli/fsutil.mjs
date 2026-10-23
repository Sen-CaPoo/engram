// 檔案工具：原子寫入（暫存檔 → rename）、JSON 讀寫、跨程序的簡易鎖。
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// Windows 上檔案被防毒或索引服務開著時，rename 會暫時失敗
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 原子寫入：先寫同資料夾的暫存檔，再 rename 取代原檔。 */
export async function writeFileAtomic(file, data, { mode } = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data, mode === undefined ? undefined : { mode });
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      if (!RETRY_CODES.has(err.code) || attempt >= 8) {
        await fsp.rm(tmp, { force: true });
        throw err;
      }
      await sleep(15 * (attempt + 1));
    }
  }
}

export function writeJsonAtomic(file, value, opts) {
  return writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, opts);
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function readJsonSync(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 以獨占建立的鎖檔保護「讀取 → 修改 → 寫回」，避免多個 hook 程序同時寫同一個檔。
 * 鎖檔超過 staleMs 視為殘留（持有者已結束）並接手。
 */
export async function withFileLock(lockFile, fn, { waitMs = 3000, staleMs = 10_000 } = {}) {
  const start = Date.now();
  await fsp.mkdir(path.dirname(lockFile), { recursive: true });
  for (;;) {
    try {
      const fh = await fsp.open(lockFile, 'wx');
      await fh.close();
      break;
    } catch (err) {
      if (err.code !== 'EEXIST' && !RETRY_CODES.has(err.code)) throw err;
      const st = await fsp.stat(lockFile).catch(() => null);
      if (st && Date.now() - st.mtimeMs > staleMs) {
        await fsp.rm(lockFile, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - start > waitMs) {
        throw Object.assign(new Error(`等待鎖逾時：${lockFile}`), { code: 'E_LOCKED' });
      }
      await sleep(10 + Math.random() * 20);
    }
  }
  try {
    return await fn();
  } finally {
    await fsp.rm(lockFile, { force: true }).catch(() => {});
  }
}

const pad = (n) => String(n).padStart(2, '0');

/** 本地日期 YYYY-MM-DD（日誌檔名用） */
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 給人看的本地時間 YYYY-MM-DD HH:mm；資料一律保留 ISO 8601。 */
export function localTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 行數：最後一行沒有換行也算一行。 */
export function countLines(text) {
  if (!text) return 0;
  const n = (text.match(/\n/g) || []).length;
  return text.endsWith('\n') ? n : n + 1;
}

/** sessionId 之類的外部輸入要當檔名時，只留安全字元。 */
export function safeName(s) {
  return String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+$/, '_').slice(0, 120) || 'unknown';
}
