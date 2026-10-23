// 識別碼產生：pid、mid、衝突 id。規則見 40 號文件 §05。
import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

/** Crockford Base32 隨機字串（小寫）。 */
export function randomBase32(len) {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CROCKFORD[bytes[i] & 31];
  return out;
}

/** 取英數部分做成 kebab-case；沒有英數時回傳空字串。 */
export function slugify(name, max = 32) {
  const s = String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/-+$/, '');
}

/** 專案 pid：<slug>-<5碼>；名稱沒有英數時用 p-<8碼>。建立後永不改變。 */
export function makePid(folderName) {
  const slug = slugify(folderName);
  return slug ? `${slug}-${randomBase32(5)}` : `p-${randomBase32(8)}`;
}

/** 電腦 mid：<主機名稱 slug>-<4碼>。 */
export function makeMid(hostname) {
  const slug = slugify(hostname, 20) || 'pc';
  return `${slug}-${randomBase32(4)}`;
}

/** vault id。 */
export function makeVaultId() {
  return `vlt_${randomBase32(12)}`;
}

/** 衝突 id：cf_YYYYMMDDTHHmmss_xxxx（UTC，精確到秒）。 */
export function makeConflictId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `cf_${stamp}_${randomBase32(4)}`;
}

/** 記憶檔名：kebab-case 英數，與 name 一致。 */
export function memoryFileName(name) {
  const slug = slugify(name, 80);
  return `${slug || `memory-${randomBase32(6)}`}.md`;
}

/** 同資料夾已有同名檔時加 -2、-3…。exists 為同步判斷函式。 */
export function uniqueFileName(fileName, exists) {
  if (!exists(fileName)) return fileName;
  const base = fileName.replace(/\.md$/i, '');
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}.md`;
    if (!exists(candidate)) return candidate;
  }
  return `${base}-${randomBase32(6)}.md`;
}
