// 路徑工具：Engram 與 Claude Code 的目錄位置、官方編碼規則、git 根目錄與 remote 解析。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {object} Homes
 * @property {string} home        Engram 根目錄（預設 ~/.engram）
 * @property {string} vault       同步的 git 工作目錄
 * @property {string} local       本機專屬資料
 * @property {string} claudeHome  Claude Code 設定目錄（預設 ~/.claude）
 * @property {string} userHome    使用者家目錄（用來產生 ~/ 形式的路徑）
 */

/** @returns {Homes} */
export function resolveHomes({ home, claudeHome, userHome } = {}) {
  const uh = userHome ?? os.homedir();
  const h = path.resolve(home ?? path.join(uh, '.engram'));
  return {
    home: h,
    vault: path.join(h, 'vault'),
    local: path.join(h, 'local'),
    claudeHome: path.resolve(claudeHome ?? path.join(uh, '.claude')),
    userHome: uh,
  };
}

/** Windows 磁碟代號統一大寫、分隔符統一為系統格式、去掉結尾斜線。 */
export function normalizeFsPath(p) {
  let r = path.resolve(String(p));
  if (/^[a-z]:/.test(r)) r = r[0].toUpperCase() + r.slice(1);
  if (r.length > 3 && /[\\/]$/.test(r)) r = r.slice(0, -1);
  return r;
}

/** 兩個路徑在這台電腦上是否指同一處（Windows 不分大小寫）。 */
export function samePath(a, b) {
  if (!a || !b) return false;
  const x = normalizeFsPath(a);
  const y = normalizeFsPath(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * Claude Code 的專案資料夾編碼：英數以外的字元一律換成 '-'。
 * 超過 200 字元時官方會截斷並加 hash，我們不自行推算，回傳 null，由呼叫端改用 transcript 查找。
 */
export function encodeProjectPath(absPath) {
  const enc = normalizeFsPath(absPath).replace(/[^A-Za-z0-9]/g, '-');
  return enc.length > 200 ? null : enc;
}

/** 把絕對路徑轉成 ~/ 形式（在家目錄內時），用於寫進同步的索引檔。 */
export function toTildePath(absPath, userHome = os.homedir()) {
  const abs = normalizeFsPath(absPath);
  const home = normalizeFsPath(userHome);
  const rel = path.relative(home, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return abs.split(path.sep).join('/');
  return `~/${rel.split(path.sep).join('/')}`;
}

/** vault 相對路徑（posix 分隔）。 */
export function toRef(vaultDir, absPath) {
  return path.relative(vaultDir, absPath).split(path.sep).join('/');
}

export function fromRef(vaultDir, ref) {
  const clean = String(ref).replace(/\\/g, '/');
  if (clean.split('/').some((seg) => seg === '..')) throw new Error(`不合法的路徑：${ref}`);
  return path.join(vaultDir, ...clean.split('/'));
}

/**
 * 往上找 git 根目錄（純檔案系統，不啟動 git，給 SessionStart 用）。
 * 回傳 { root, gitDir, commonDir } 或 null。支援 worktree（.git 是檔案）。
 */
export function findGitRoot(startDir) {
  let dir = normalizeFsPath(startDir);
  for (let i = 0; i < 64; i++) {
    const dotGit = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotGit); } catch { /* 不存在 */ }
    if (st) {
      if (st.isDirectory()) return { root: dir, gitDir: dotGit, commonDir: dotGit };
      if (st.isFile()) {
        // worktree：.git 檔內容為 "gitdir: <path>"
        try {
          const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
          if (m) {
            const gitDir = path.resolve(dir, m[1].trim());
            let commonDir = gitDir;
            const commonFile = path.join(gitDir, 'commondir');
            if (fs.existsSync(commonFile)) commonDir = path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim());
            return { root: dir, gitDir, commonDir };
          }
        } catch { /* 讀不到就當作不是 repo */ }
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Claude Code 用來決定記憶資料夾的「專案根目錄」：
 * git repo → 主工作目錄的根（所有 worktree 共用）；否則就是 cwd 本身。
 */
export function memoryRootFor(cwd) {
  const g = findGitRoot(cwd);
  if (!g) return { root: normalizeFsPath(cwd), git: null };
  // commonDir 是主 repo 的 .git；它的上一層就是主工作目錄
  const mainRoot = path.basename(g.commonDir).toLowerCase() === '.git' ? path.dirname(g.commonDir) : g.root;
  return { root: normalizeFsPath(mainRoot), git: g };
}

/** 從 .git/config 讀出所有 remote URL（不啟動 git）。 */
export function readGitRemotes(commonDir) {
  try {
    const text = fs.readFileSync(path.join(commonDir, 'config'), 'utf8');
    const urls = [];
    let inRemote = false;
    for (const line of text.split(/\r?\n/)) {
      const sec = /^\s*\[(.+?)\]\s*$/.exec(line);
      if (sec) { inRemote = /^remote\s+"/.test(sec[1]); continue; }
      const kv = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
      if (inRemote && kv) urls.push(kv[1]);
    }
    return urls;
  } catch {
    return [];
  }
}

/**
 * remote URL 正規化：去協定、帳號密碼、.git 尾碼；ssh 形式轉成 host/path；主機與路徑轉小寫。
 * 例：git@github.com:Acme/Shop-Admin.git → github.com/acme/shop-admin
 */
export function normalizeRemote(url) {
  if (!url) return null;
  let u = String(url).trim();
  let m = /^[\w.+-]+@([^:/]+):(.+)$/.exec(u); // scp 形式 ssh
  if (m) u = `${m[1]}/${m[2]}`;
  else {
    m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u);
    if (m) u = `${m[1]}/${m[2]}`;
    else if (/^[a-z]:[\\/]|^[\\/]/i.test(u)) return `file:${normalizeFsPath(u).toLowerCase()}`; // 本機路徑 remote
  }
  return u.replace(/\.git\/?$/i, '').replace(/\/+$/, '').toLowerCase();
}
