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

// 部署時先複製到「<版本>.tmp-<程序編號>」再改名（deploy）：被中斷（斷電、程序被結束）時會留下半成品，它不是版本
const TMP_RE = /\.tmp-(\d+)$/;

export function listVersions(home) {
  const root = appRoot(home);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'current' && !TMP_RE.test(e.name) && !isLink(path.join(root, e.name)))
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
/** 中斷的部署留下的暫存資料夾：持有它的程序已經不在（或就是這個程序、前一次失敗留下的）就刪掉；另一個程序還活著時它可能正在複製，不動 */
async function sweepTmp(home) {
  const root = appRoot(home);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
  for (const e of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const m = TMP_RE.exec(e.name);
    if (!e.isDirectory() || !m) continue;
    if (Number(m[1]) !== process.pid && alive(Number(m[1]))) continue;
    await fsp.rm(path.join(root, e.name), { recursive: true, force: true }).catch(() => {});
  }
}

export async function deploy(home, sourceDir) {
  const version = versionTag(sourceDir);
  const dest = path.join(appRoot(home), version);
  const previous = activeVersion(home);
  await sweepTmp(home);
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
  await prune(home, previous);
  return { appDir: currentDir(home), versionDir: dest, version, previous };
}

/** 切回上一個版本（engram update --rollback）。to：指定要切回的版本資料夾（自動更新用，退回到更新前的那個版本）；沒指定時切回最近部署的另一個版本 */
export async function rollback(home, to) {
  const active = activeVersion(home);
  const prev = listVersions(home).find((v) => (to ? v.name === to : v.name !== active));
  if (!prev) throw Object.assign(new Error('沒有可以切回的舊版本'), { code: 'E_NOT_FOUND' });
  await pointCurrent(home, path.join(appRoot(home), prev.name));
  return { version: prev.name, previous: active };
}

/** 只保留最近的幾個版本（使用中的那個一定保留；剛被取代的版本 previous 也一定保留，它是 rollback 的目標，就算它的修改時間很舊） */
async function prune(home, previous) {
  const active = activeVersion(home);
  const others = listVersions(home).filter((v) => v.name !== active);
  const ordered = [...others.filter((v) => v.name === previous), ...others.filter((v) => v.name !== previous)];
  for (const v of ordered.slice(KEEP_VERSIONS - 1)) await fsp.rm(path.join(appRoot(home), v.name), { recursive: true, force: true }).catch(() => {});
}

/** 移除整個 ~/.engram/app（解除安裝時） */
export async function removeApp(home) {
  const cur = currentDir(home);
  if (isLink(cur)) await fsp.rm(cur, { force: true });
  await fsp.rm(appRoot(home), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
