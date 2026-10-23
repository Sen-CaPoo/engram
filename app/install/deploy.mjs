// 把 Engram 程式部署到 ~/.engram/app/<版本>-<commit>/，並用 junction ~/.engram/app/current 指向使用中的版本（R-43）。
// 這樣開發中的工作樹（含尚未 commit 的半成品）不會直接影響使用者每天使用的 Claude Code；
// 升級是明確的動作（engram update），舊版保留以便回滾。--dev 才直接使用工作樹。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// 部署時需要的資料夾與檔案；開發工具、測試與相依套件都不帶
const INCLUDE = ['bin', 'src', 'plugin', 'install', '.claude-plugin', 'package.json'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'tools']);
const KEEP_VERSIONS = 3;

export const appRoot = (home) => path.join(home, 'app');
export const currentDir = (home) => path.join(appRoot(home), 'current');

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** 來源的版本標記：package.json 版本＋git commit（有未 commit 的修改時加 -dirty） */
export function versionTag(sourceDir) {
  const version = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8')).version;
  let commit = 'local';
  try {
    const opts = { cwd: sourceDir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], opts).trim();
    if (execFileSync('git', ['status', '--porcelain', '--', '.'], opts).trim()) commit += '-dirty';
  } catch { /* 不是 git 工作樹 */ }
  return `${version}-${commit}`;
}

/** 讀出目前 current 指向的版本資料夾（沒有時回傳 null） */
export function activeVersion(home) {
  const cur = currentDir(home);
  if (!isLink(cur)) return null;
  try { return path.basename(fs.realpathSync(cur)); } catch { return null; }
}

export function listVersions(home) {
  const root = appRoot(home);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'current' && !isLink(path.join(root, e.name)))
    .map((e) => ({ name: e.name, mtimeMs: fs.statSync(path.join(root, e.name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function pointCurrent(home, target) {
  const cur = currentDir(home);
  if (isLink(cur)) await fsp.rm(cur, { force: true });
  else if (fs.existsSync(cur)) throw Object.assign(new Error(`${cur} 不是 junction，為避免誤刪不會覆蓋它`), { code: 'E_INVALID' });
  fs.symlinkSync(target, cur, 'junction');
}

/**
 * 部署 sourceDir 的程式到新的版本資料夾並切換 current。已有同名版本時直接切換（同一個 commit 不重複複製；-dirty 版本一律重新複製）。
 * @returns {{ appDir, versionDir, version, previous }}
 */
export async function deploy(home, sourceDir) {
  const version = versionTag(sourceDir);
  const dest = path.join(appRoot(home), version);
  const previous = activeVersion(home);
  if (!fs.existsSync(dest) || version.endsWith('-dirty')) {
    const tmp = `${dest}.tmp-${process.pid}`;
    await fsp.rm(tmp, { recursive: true, force: true });
    for (const name of INCLUDE) {
      const src = path.join(sourceDir, name);
      if (!fs.existsSync(src)) continue;
      fs.cpSync(src, path.join(tmp, name), { recursive: true, filter: (p) => !SKIP_DIRS.has(path.basename(p)) || p === src });
    }
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.rename(tmp, dest);
  }
  await pointCurrent(home, dest);
  await prune(home);
  return { appDir: currentDir(home), versionDir: dest, version, previous };
}

/** 切回上一個版本（engram update --rollback） */
export async function rollback(home) {
  const active = activeVersion(home);
  const prev = listVersions(home).find((v) => v.name !== active);
  if (!prev) throw Object.assign(new Error('沒有可以切回的舊版本'), { code: 'E_NOT_FOUND' });
  await pointCurrent(home, path.join(appRoot(home), prev.name));
  return { version: prev.name, previous: active };
}

/** 只保留最近的幾個版本（使用中的那個一定保留） */
async function prune(home) {
  const active = activeVersion(home);
  const old = listVersions(home).filter((v) => v.name !== active).slice(KEEP_VERSIONS - 1);
  for (const v of old) await fsp.rm(path.join(appRoot(home), v.name), { recursive: true, force: true }).catch(() => {});
}

/** 移除整個 ~/.engram/app（解除安裝時） */
export async function removeApp(home) {
  const cur = currentDir(home);
  if (isLink(cur)) await fsp.rm(cur, { force: true });
  await fsp.rm(appRoot(home), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
