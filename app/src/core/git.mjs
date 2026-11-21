// 呼叫系統 git（Git for Windows）。不使用任何 git 函式庫，認證與代理交給使用者自己的 git 設定。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { E, EngramError } from './errors.mjs';

const BASE_ARGS = ['-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', '-c', 'color.ui=false'];

/**
 * 解析真正的 git.exe（M5）：Scoop 等包裝程式（cmd\git.exe shim）被終止時不會連帶終止真正的 git，
 * 逾時會失效。改用 `git --exec-path` 旁邊的 git.exe。找不到就退回 PATH 上的 git。
 */
let gitBin = null;
function resolveGit() {
  if (gitBin) return gitBin;
  gitBin = 'git';
  if (process.platform !== 'win32') return gitBin;
  try {
    const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    const exec = r.stdout?.trim();
    if (exec) {
      for (const cand of [path.join(exec, 'git.exe'), path.resolve(exec, '..', '..', 'bin', 'git.exe')]) {
        if (fs.existsSync(cand)) { gitBin = cand; break; }
      }
    }
  } catch { /* 用 PATH 上的 git */ }
  return gitBin;
}

/** 終止整棵程序樹（Windows 上 child.kill 只會終止最外層）。 */
function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }); return; } catch { /* 退回 kill */ }
  }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
}

/**
 * @param {string[]} args
 * @param {{ cwd: string, timeoutMs?: number, env?: object, input?: string, allowFail?: boolean, signal?: AbortSignal }} opts
 *   signal：中止時終止整棵程序樹（常駐程式停止時不要等長時間的 gc）；結果與逾時相同，timedOut 為 true
 * @returns {Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function git(args, { cwd, timeoutMs = 30_000, env, input, allowFail = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveGit(), [...BASE_ARGS, ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        // 網路卡住時讓 git 自己放棄（20 秒內低於 1KB/s）
        GIT_HTTP_LOW_SPEED_LIMIT: process.env.GIT_HTTP_LOW_SPEED_LIMIT ?? '1000',
        GIT_HTTP_LOW_SPEED_TIME: process.env.GIT_HTTP_LOW_SPEED_TIME ?? '20',
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o ConnectTimeout=15',
        LC_ALL: 'C',
        LANG: 'C',
        ...env,
      },
      windowsHide: true,
    });
    const out = [];
    const err = [];
    let timedOut = false;
    const stop = () => { timedOut = true; killTree(child); };
    const timer = setTimeout(stop, timeoutMs);
    if (signal) {
      if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
    }
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      reject(new EngramError(E.GIT, '找不到 git 執行檔', '請安裝 Git for Windows（https://git-scm.com）', { cause: e.message }).withEn('Could not find the git executable', 'Install Git for Windows (https://git-scm.com)'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      const res = { code: timedOut ? -1 : code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut };
      if (timedOut) res.stderr += '\n[engram] git 指令逾時';
      if (res.code !== 0 && !allowFail) {
        reject(classifyGitError(res, args));
        return;
      }
      resolve(res);
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

// 會連到遠端的指令：這些逾時才是「連線逾時」；其他都是只碰本機檔案的指令
const NETWORK_COMMANDS = new Set(['fetch', 'push', 'pull', 'clone', 'ls-remote']);

/** 把 git 的錯誤訊息分類成 Engram 錯誤碼與正體中文解法。 */
export function classifyGitError(res, args = []) {
  const s = `${res.stderr}\n${res.stdout}`;
  const cmd = `git ${args.join(' ')}`.slice(0, 200);
  const details = { command: cmd, exitCode: res.code, stderr: res.stderr.slice(-2000) };
  if (/index\.lock': File exists|Unable to create .*index\.lock/i.test(s)) {
    return new EngramError(E.LOCKED, 'vault 的 git 正被其他程序使用（index.lock）', '稍後會自動重試；殘留過久時 Engram 會自動清除', details).withEn("The vault's git is being used by another process (index.lock)", 'Engram will retry shortly; if the lock file stays too long, Engram removes it automatically');
  }
  // ref 鎖：同時進行的 git gc（reflog expire、pack-refs）或另一個 git 指令正在更新同一個 ref，過一會兒就沒事，不是同步真的失敗（U3）
  if (/cannot lock ref|Unable to create '[^']*\.lock': File exists|could not lock (config|ref)/i.test(s)) {
    return new EngramError(E.LOCKED, 'vault 的 git 正被其他程序使用（ref 鎖定，例如正在打包）', '稍後會自動重試', details).withEn("The vault's git is being used by another process (a ref is locked, for example while packing)", 'Engram will retry shortly');
  }
  // 我們自己殺掉的（逾時或中止）或被外力終止：本機指令是磁碟忙碌之類的問題，不是連不上遠端（S2）
  if (res.timedOut === true || res.code === -1) {
    if (NETWORK_COMMANDS.has(args.find((a) => !a.startsWith('-')))) {
      return new EngramError(E.OFFLINE, '連線逾時，暫時無法同步', '網路恢復後會自動重試', details).withEn('The connection timed out, so sync is unavailable for now', 'Engram will retry automatically once the network is back');
    }
    return new EngramError(E.GIT_TIMEOUT, '本機 git 指令逾時（不是網路問題，可能是磁碟忙碌或防毒軟體正在掃描）', '稍後會自動重試；一直發生的話執行 engram doctor，並查看日誌', details).withEn('A local git command timed out (not a network problem; the disk may be busy or antivirus may be scanning)', 'Engram will retry automatically. If it keeps happening, run engram doctor and check the logs');
  }
  if (/GH013|push protection|secret scanning|Push cannot contain secrets/i.test(s)) {
    return new EngramError(E.PUSH_PROTECTED, 'GitHub 推送保護擋下了這次同步：有檔案疑似含有金鑰', '到管理介面的收件匣處理 H13 卡片，移除金鑰後再同步', details).withEn('GitHub push protection blocked this sync: some files appear to contain secrets', 'Open the H13 card in the dashboard inbox, remove the secrets, then sync again');
  }
  if (/timed out|Operation timed out|Connection timed out/i.test(s)) {
    return new EngramError(E.OFFLINE, '連線逾時，暫時無法同步', '網路恢復後會自動重試', details).withEn('The connection timed out, so sync is unavailable for now', 'Engram will retry automatically once the network is back');
  }
  if (/proxy|407 Proxy Authentication/i.test(s)) {
    return new EngramError(E.PROXY, '代理伺服器拒絕連線', '確認 git 的 http.proxy 設定，或在公司網路外再試一次', details).withEn('The proxy server refused the connection', "Check git's http.proxy setting, or try again from outside the company network");
  }
  if (/SSL|certificate|schannel/i.test(s)) {
    return new EngramError(E.PROXY, 'TLS 憑證驗證失敗（可能是公司網路的 TLS 檢查）', '執行 git config --global http.sslBackend schannel 讓 git 信任 Windows 憑證存放區', details).withEn('TLS certificate verification failed (possibly TLS inspection on the company network)', 'Run git config --global http.sslBackend schannel so git trusts the Windows certificate store');
  }
  if (/Authentication failed|could not read Username|terminal prompts disabled|403|401|Permission denied|access denied|not authorized/i.test(s)) {
    return new EngramError(E.AUTH, 'GitHub 認證失敗或沒有權限', '執行 gh auth login 重新登入 GitHub；如果 git 的認證沒有交給 GitHub CLI，改在 PowerShell 或 Git Bash 執行 git -C "$HOME/.engram/vault" fetch，依提示在瀏覽器登入；也請確認權杖有這個 repo 的權限', details).withEn('GitHub authentication failed or you do not have access', 'Run gh auth login to sign in to GitHub again. If git does not use GitHub CLI for credentials, run git -C "$HOME/.engram/vault" fetch in PowerShell or Git Bash instead and sign in through the browser when prompted. Also make sure your token has access to this repo');
  }
  if (/Could not resolve host|unable to access|Failed to connect|Network is unreachable|Connection refused|Connection reset/i.test(s)) {
    return new EngramError(E.OFFLINE, '目前無法連線到遠端', '網路恢復後會自動重試', details).withEn('Cannot reach the remote right now', 'Engram will retry automatically once the network is back');
  }
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(s)) {
    return new EngramError(E.CONFLICT, '遠端有較新的變更', '重新同步即可', details).withEn('The remote has newer changes', 'Just sync again');
  }
  return new EngramError(E.GIT, 'git 指令執行失敗', '查看日誌中的 git 輸出', details).withEn('A git command failed', 'Check the git output in the logs');
}

/** 解析 git status --porcelain=v1 -z 的輸出。 */
export function parseStatusZ(stdout) {
  const items = [];
  const parts = stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const x = rec[0];
    const y = rec[1];
    const file = rec.slice(3);
    const item = { x, y, path: file };
    if (x === 'R' || x === 'C') { item.from = parts[++i]; }
    items.push(item);
  }
  return items;
}

/** commit 訊息加上 Engram trailer。 */
export function buildMessage(subject, { action, refs = [], body = '' } = {}) {
  const lines = [subject];
  if (body) lines.push('', body);
  const trailers = [];
  if (action) trailers.push(`Engram-Action: ${action}`);
  for (const r of refs.slice(0, 50)) trailers.push(`Engram-Refs: ${r}`);
  if (trailers.length) lines.push('', ...trailers);
  return `${lines.join('\n')}\n`;
}
