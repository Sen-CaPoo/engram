// 外殼共用的路徑：Engram 與 Claude Code 的資料夾、本機狀態檔。
// ENGRAM_HOME／CLAUDE_HOME 可覆寫，測試時指向暫存資料夾。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** app/ 資料夾（bin、src、plugin 的上一層） */
export const APP_DIR = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const BIN_PATH = path.join(APP_DIR, 'bin', 'engram.mjs');
export const DEFAULT_PORT = 4777;

export function engramHome() {
  return process.env.ENGRAM_HOME || path.join(os.homedir(), '.engram');
}

export function claudeHome() {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
}

/** ~/.engram 底下外殼會用到的位置。local/ 只屬於這台電腦、不同步。 */
export function localPaths(home = engramHome()) {
  const local = path.join(home, 'local');
  return {
    home,
    local,
    vault: path.join(home, 'vault'),
    agentFile: path.join(local, 'agent.json'),
    jobsFile: path.join(local, 'agent-jobs.json'),
    installFile: path.join(local, 'install.json'),
    debounceFile: path.join(local, 'sync-debounce.json'),
    logs: path.join(local, 'logs'),
    dirty: path.join(local, 'dirty'),
    loaded: path.join(local, 'loaded'),
  };
}

let cachedVersion;
export function appVersion() {
  if (!cachedVersion) {
    try {
      cachedVersion = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
    } catch {
      cachedVersion = '0.0.0';
    }
  }
  return cachedVersion;
}
