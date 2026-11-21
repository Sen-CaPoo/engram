// 使用者層 ~/.claude/settings.json 的最小修改（R-24）：
// 透過 junction 讀記憶時，互動模式會詢問「工作目錄外的讀取」。把每個 junction 路徑本身加進
// permissions.additionalDirectories 就不會再問。只增刪 Engram 自己加的項目，其他設定一律不動。
// 每次修改前備份；加過哪些路徑記在 local/install-manifest.json，解除安裝時依此還原。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { E, EngramError } from './errors.mjs';
import { readText, safeWriteResult, sha1, stableJson } from './fsx.mjs';
import { withLock } from './lock.mjs';
import { normalizeFsPath, samePath } from './paths.mjs';

function settingsPath(homes) { return path.join(homes.claudeHome, 'settings.json'); }
function manifestPath(homes) { return path.join(homes.local, 'install-manifest.json'); }

/**
 * settings.json 實際寫入的位置：它是符號連結（常見於用 dotfiles repo 管設定）就寫到連結的目標，不把連結換成一般檔案。
 * 目標不存在（連結懸空）時用 readlink 的結果。
 */
export async function settingsTarget(homes) {
  const p = settingsPath(homes);
  const st = await fsp.lstat(p).catch(() => null);
  if (!st?.isSymbolicLink()) return p;
  try { return await fsp.realpath(p); } catch { return path.resolve(path.dirname(p), await fsp.readlink(p)); }
}

// ───────── 安裝清單（install-manifest.json）的讀改寫 ─────────
// 常駐程式（環境設定同步的套用）、開場 hook（allowJunctionRead）、引擎的其他寫入都會改這個檔：
// 一律在引擎的寫入鎖（local/engram.lock，同一條呼叫鏈可重入）底下讀、改、寫，而且寫入時比對讀取時的雜湊，
// 被鎖以外的程式改過就放棄（E_LOCKED），不會把另一邊的紀錄蓋掉。
const manifestHashes = new WeakMap();

/** 在引擎的寫入鎖底下執行 fn（已經在鎖裡的呼叫鏈直接執行） */
export function withManifestLock(homes, fn, { waitMs = 10_000 } = {}) {
  return withLock(path.join(homes.local, 'engram.lock'), 'install-manifest', fn, { waitMs });
}

async function readManifest(homes) {
  const text = await readText(manifestPath(homes));
  let m = null;
  if (text !== null) { try { m = JSON.parse(text); } catch { m = null; } }
  const out = m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  if (!Array.isArray(out.additionalDirectories)) out.additionalDirectories = [];
  if (!Array.isArray(out.settingsBackups)) out.settingsBackups = [];
  manifestHashes.set(out, text === null ? null : sha1(text));
  return out;
}

/** 寫安裝清單：只能寫 readInstallManifest／withInstallManifest 讀出來的那份物件（保留不認得的欄位）；檔案在讀取之後被改過就放棄 */
export async function writeInstallManifest(homes, manifest) {
  await fsp.mkdir(homes.local, { recursive: true });
  const text = stableJson(manifest);
  const r = await safeWriteResult(manifestPath(homes), text, { expectHash: manifestHashes.has(manifest) ? manifestHashes.get(manifest) : undefined });
  if (!r.ok) throw new EngramError(E.LOCKED, '安裝清單剛好被修改，稍後再試', '', { reason: r.reason }).withEn('The install manifest was modified just now. Try again in a moment');
  manifestHashes.set(manifest, sha1(text));
}

/** 讀改寫安裝清單的標準做法：鎖＋讀取＋ fn(manifest, save)；fn 要保存時呼叫 save()（可以呼叫多次） */
export function withInstallManifest(homes, fn) {
  return withManifestLock(homes, async () => {
    const manifest = await readManifest(homes);
    return fn(manifest, () => writeInstallManifest(homes, manifest));
  });
}

/** 讀使用者層設定；檔案損毀時不碰它（回傳 null）。 */
async function readSettings(homes) {
  const text = await readText(settingsPath(homes));
  if (text === null) return { data: {}, text: null };
  try { return { data: JSON.parse(text.replace(/^﻿/, '')), text }; } catch { return null; }
}

/** 第一次修改前備份原檔（之後每天最多再備份一次）。 */
async function backupOnce(homes, text, manifest) {
  if (text === null) return;
  const today = new Date().toISOString().slice(0, 10);
  if (manifest.settingsBackups.some((b) => b.date === today)) return;
  const dir = path.join(homes.local, 'backups', 'claude-settings');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `settings.${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fsp.writeFile(file, text, 'utf8');
  manifest.settingsBackups.push({ date: today, file, sha1: sha1(text) });
}

/** 鍵順序無關的深度比較。 */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function update(homes, mutate) {
  return withManifestLock(homes, () => updateLocked(homes, mutate));
}

async function updateLocked(homes, mutate) {
  const cur = await readSettings(homes);
  if (!cur) throw new EngramError(E.INVALID, '~/.claude/settings.json 不是有效的 JSON，Engram 不會修改它', '修正該檔案的格式後執行 engram doctor').withEn('~/.claude/settings.json is not valid JSON, so Engram will not modify it', 'Fix the format of that file, then run engram doctor');
  const manifest = await readManifest(homes);
  if (!manifest.original) manifest.original = cur.text === null ? { missing: true } : { text: cur.text };
  const data = structuredClone(cur.data);
  const changed = mutate(data, manifest);
  if (!changed) return false;
  await backupOnce(homes, cur.text, manifest);
  // 撤銷到和第一次修改前語意相同時，寫回原始位元組（R-12：解除安裝後逐位元一致）
  let out = stableJson(data);
  let removeFile = false;
  if (manifest.original.missing && canonical(data) === canonical({})) removeFile = true;
  else if (typeof manifest.original.text === 'string') {
    try { if (canonical(JSON.parse(manifest.original.text.replace(/^﻿/, ''))) === canonical(data)) out = manifest.original.text; } catch { /* 原檔不是 JSON 不會走到這裡 */ }
  }
  if (removeFile) {
    await removeSettingsFile(homes);
    await writeInstallManifest(homes, manifest);
    return true;
  }
  // 設定檔是符號連結時寫到連結的目標（不把連結換成一般檔案）
  const r = await safeWriteResult(await settingsTarget(homes), out, { expectHash: cur.text === null ? null : sha1(cur.text) });
  if (!r.ok) throw new EngramError(E.LOCKED, 'Claude Code 設定檔剛好被修改，稍後再試', '', { reason: r.reason }).withEn('The Claude Code settings file was modified just now. Try again in a moment');
  await writeInstallManifest(homes, manifest);
  return true;
}

/** 把 junction 路徑加進 permissions.additionalDirectories（已存在就不動）。 */
export async function allowJunctionRead(homes, junctionPath) {
  const want = normalizeFsPath(junctionPath);
  return update(homes, (data, manifest) => {
    data.permissions ??= {};
    const list = Array.isArray(data.permissions.additionalDirectories) ? data.permissions.additionalDirectories : [];
    if (list.some((p) => samePath(p, want))) return false; // 已存在（可能是使用者自己加的）：不接管
    data.permissions.additionalDirectories = [...list, want];
    manifest.additionalDirectories = [...manifest.additionalDirectories.filter((p) => !samePath(p, want)), want];
    return true;
  });
}

/** 移除 Engram 加過的 junction 路徑；使用者自己加的不碰。 */
export async function revokeJunctionRead(homes, junctionPath) {
  const want = normalizeFsPath(junctionPath);
  return update(homes, (data, manifest) => {
    if (!manifest.additionalDirectories.some((p) => samePath(p, want))) return false;
    manifest.additionalDirectories = manifest.additionalDirectories.filter((p) => !samePath(p, want));
    const list = data.permissions?.additionalDirectories;
    if (!Array.isArray(list)) return true;
    data.permissions.additionalDirectories = list.filter((p) => !samePath(p, want));
    if (!data.permissions.additionalDirectories.length) delete data.permissions.additionalDirectories;
    if (data.permissions && !Object.keys(data.permissions).length) delete data.permissions;
    return true;
  });
}

/**
 * 設定一個使用者層的頂層設定鍵（2.0.0 環境健檢）：只在 settings.json 還沒有這個鍵時才設，
 * 記進安裝清單（settingKeys），解除安裝時依此還原。回傳有沒有寫入。
 * 用逐位元寫入（保留 BOM、縮排、換行與鍵的順序）；排版不是標準格式就拒絕（E_INVALID），不重排整個檔。
 */
export async function setSettingIfMissing(homes, key, value) {
  return withInstallManifest(homes, async (manifest, save) => {
    const doc = await readSettingsDoc(homes);
    if (doc.invalid) throw new EngramError(E.INVALID, '~/.claude/settings.json 不是有效的 JSON，Engram 不會修改它', '修正該檔案的格式後執行 engram doctor').withEn('~/.claude/settings.json is not valid JSON, so Engram will not modify it', 'Fix the format of that file, then run engram doctor');
    if (!doc.canonical) throw new EngramError(E.INVALID, '~/.claude/settings.json 的排版不是標準格式（例如手排的緊湊陣列），Engram 不會重排整個檔，所以不修改它', '請自行加上這個設定').withEn('~/.claude/settings.json is not in the standard layout (for example hand-formatted compact arrays), so Engram will not reformat the whole file and will not modify it', 'Add the setting yourself');
    if (Object.hasOwn(doc.data, key)) return false;
    if (!manifest.original) manifest.original = doc.text === null ? { missing: true } : { text: doc.text };
    manifest.settingsBackups ??= [];
    await backupOnce(homes, doc.text, manifest);
    await writeSettingsDoc(homes, doc, { ...doc.data, [key]: value });
    manifest.settingKeys = [...(manifest.settingKeys ?? []).filter((k) => k.key !== key), { key, value }];
    await save();
    return true;
  });
}

/** 還原 setSettingIfMissing 設的鍵：值還是 Engram 設的才移除；使用者後來改過的保留，只從清單拿掉。 */
export async function revokeSettingKey(homes, key) {
  return update(homes, (data, manifest) => {
    const rec = (manifest.settingKeys ?? []).find((k) => k.key === key);
    if (!rec) return false;
    manifest.settingKeys = manifest.settingKeys.filter((k) => k.key !== key);
    if (Object.hasOwn(data, key) && canonical(data[key]) === canonical(rec.value)) delete data[key];
    return true;
  });
}

/**
 * Claude Code 的預設權限模式（只讀）。依 Claude Code 的優先序：組織下發的 remote-settings.json、
 * 專案的 .claude/settings.local.json、專案的 .claude/settings.json（團隊 repo 可能設定），最後是使用者層。
 * 都沒設定時回傳 undefined，也就是 default 模式。
 * @param {string} [projectRoot]  專案根目錄；不給就只看組織與使用者層
 */
export async function defaultPermissionMode(homes, projectRoot) {
  const files = [path.join(homes.claudeHome, 'remote-settings.json')];
  if (projectRoot) files.push(path.join(projectRoot, '.claude', 'settings.local.json'), path.join(projectRoot, '.claude', 'settings.json'));
  files.push(path.join(homes.claudeHome, 'settings.json'));
  for (const f of files) {
    const text = await readText(f);
    if (text === null) continue;
    try {
      const mode = JSON.parse(text.replace(/^﻿/, ''))?.permissions?.defaultMode;
      if (typeof mode === 'string') return mode;
    } catch { /* 損毀的設定檔不判斷 */ }
  }
  return undefined;
}

/** junction 路徑是否已允許讀取（doctor 與健康檢查用）。 */
export async function isJunctionReadAllowed(homes, junctionPath) {
  const cur = await readSettings(homes);
  const list = cur?.data?.permissions?.additionalDirectories;
  return Array.isArray(list) && list.some((p) => samePath(p, junctionPath));
}

// ───────── 環境設定同步（2.0.0 WP8）用的逐位元寫入 ─────────
// update() 一律用 stableJson（2 空格、LF）重寫整份檔案；環境設定同步要求沒被改到的部分一字不差，所以另外提供：
// 讀出縮排、換行、BOM 與結尾換行，寫回時照原樣；排版不是 JSON.stringify 能還原的（手排的緊湊陣列、\u 跳脫等）就不動手。

export { canonical as canonicalJson, readManifest as readInstallManifest };

/**
 * 讀 settings.json 與它的排版。檔案不存在：{ text: null, data: {}, canonical: true }（寫入時用 2 空格、LF、結尾換行）；
 * 不是有效的 JSON 物件：{ invalid: true }；canonical：用同樣的排版重新輸出會和原檔逐位元相同。
 */
export async function readSettingsDoc(homes) {
  const text = await readText(settingsPath(homes));
  if (text === null) return { text: null, data: {}, bom: '', indent: '  ', eol: '\n', tail: '\n', canonical: true };
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const body = text.slice(bom.length);
  let data;
  try { data = JSON.parse(body); } catch { return { text, invalid: true }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { text, invalid: true };
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const doc = { text, data, bom, indent: /^\{\r?\n([ \t]+)"/.exec(body)?.[1] ?? '  ', eol, tail: /\r?\n$/.test(body) ? eol : '' };
  doc.canonical = renderSettingsDoc(doc, data) === text;
  return doc;
}

/** 用 doc 的排版輸出 data */
export function renderSettingsDoc(doc, data) {
  return doc.bom + JSON.stringify(data, null, doc.indent).replace(/\n/g, doc.eol) + doc.tail;
}

/** 寫回 settings.json（排版照 doc）；寫入前檔案被改過就放棄（E_LOCKED）。回傳寫出去的文字。 */
export async function writeSettingsDoc(homes, doc, data) {
  const out = renderSettingsDoc(doc, data);
  await writeSettingsText(homes, out, doc.text);
  return out;
}

/** 把 text 原樣寫成 settings.json；expectText 是讀取時的內容（null：原本沒有這個檔案），檔案在這之間被改過就不寫 */
export async function writeSettingsText(homes, text, expectText) {
  // 設定檔是符號連結時寫到連結的目標，不把連結換成一般檔案
  const r = await safeWriteResult(await settingsTarget(homes), text, { expectHash: expectText === null ? null : sha1(expectText) });
  if (!r.ok) throw new EngramError(E.LOCKED, 'Claude Code 設定檔剛好被修改，稍後再試', '', { reason: r.reason }).withEn('The Claude Code settings file was modified just now. Try again in a moment');
}

/** 刪除 settings.json（原本沒有這個檔案、還原後又空了的情況）。它是符號連結時不刪（那是使用者自己管理的檔案） */
export async function removeSettingsFile(homes) {
  const st = await fsp.lstat(settingsPath(homes)).catch(() => null);
  if (st?.isSymbolicLink()) return;
  await fsp.rm(settingsPath(homes), { force: true });
}

/** 解除安裝：移除所有 Engram 加過的路徑。 */
export async function revokeAll(homes) {
  const manifest = await readManifest(homes);
  for (const p of [...manifest.additionalDirectories]) await revokeJunctionRead(homes, p);
  for (const k of [...(manifest.settingKeys ?? [])]) await revokeSettingKey(homes, k.key);
  return manifest.additionalDirectories.length;
}
