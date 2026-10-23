// 使用者層 ~/.claude/settings.json 的最小修改（R-24）：
// 透過 junction 讀記憶時，互動模式會詢問「工作目錄外的讀取」。把每個 junction 路徑本身加進
// permissions.additionalDirectories 就不會再問。只增刪 Engram 自己加的項目，其他設定一律不動。
// 每次修改前備份；加過哪些路徑記在 local/install-manifest.json，解除安裝時依此還原。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { E, EngramError } from './errors.mjs';
import { readJson, readText, safeWriteResult, sha1, stableJson, writeJson } from './fsx.mjs';
import { normalizeFsPath, samePath } from './paths.mjs';

function settingsPath(homes) { return path.join(homes.claudeHome, 'settings.json'); }
function manifestPath(homes) { return path.join(homes.local, 'install-manifest.json'); }

async function readManifest(homes) {
  return (await readJson(manifestPath(homes), null)) ?? { additionalDirectories: [], settingsBackups: [] };
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

async function update(homes, mutate) {
  const cur = await readSettings(homes);
  if (!cur) throw new EngramError(E.INVALID, '~/.claude/settings.json 不是有效的 JSON，Engram 不會修改它', '修正該檔案的格式後執行 engram doctor');
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
    await fsp.rm(settingsPath(homes), { force: true });
    await fsp.mkdir(homes.local, { recursive: true });
    await writeJson(manifestPath(homes), manifest);
    return true;
  }
  const r = await safeWriteResult(settingsPath(homes), out, { expectHash: cur.text === null ? null : sha1(cur.text) });
  if (!r.ok) throw new EngramError(E.LOCKED, 'Claude Code 設定檔剛好被修改，稍後再試', '', { reason: r.reason });
  await fsp.mkdir(homes.local, { recursive: true });
  await writeJson(manifestPath(homes), manifest);
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

/** 解除安裝：移除所有 Engram 加過的路徑。 */
export async function revokeAll(homes) {
  const manifest = await readManifest(homes);
  for (const p of [...manifest.additionalDirectories]) await revokeJunctionRead(homes, p);
  return manifest.additionalDirectories.length;
}
