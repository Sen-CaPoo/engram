// 測試共用工具：在暫存資料夾建立隔離的 Engram home、Claude home、假專案與 transcript。
// 不會碰到真正的 ~/.engram 或 ~/.claude。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { encodeProjectPath } from '../../src/core/paths.mjs';
import { setTempDir } from '../../src/core/fsx.mjs';

export function mkTmp(prefix = 'engram-test-') {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function rmTmp(dir) {
  // 引擎 open() 把暫存檔位置設成全域；不還原的話，下一個測試的寫入會在這裡重建已刪除的資料夾
  setTempDir(null);
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows 偶爾鎖檔 */ }
}

/** 測試用合併器入口：模擬 app/bin/engram.mjs 的 merge-driver 子指令。 */
export function writeDriverCli(dir) {
  const p = path.join(dir, 'engram-cli.mjs');
  // 以本檔位置定位（不依賴 cwd：從 repo 根目錄或 app/ 執行都要能找到）
  const mod = new URL('../../src/core/mergedriver.mjs', import.meta.url).href;
  fs.writeFileSync(p, `import { mergeDriver } from ${JSON.stringify(mod)};
const [cmd, base, ours, theirs, ref] = process.argv.slice(2);
if (cmd !== 'merge-driver') process.exit(2);
const r = await mergeDriver({ base, ours, theirs, path: ref, conflictsDir: process.env.ENGRAM_CONFLICTS_DIR });
process.exit(r.exitCode ?? 0);
`);
  return p;
}

/** 一台模擬電腦的路徑組。 */
/**
 * 一台模擬電腦的路徑。mode：Claude Code 的預設權限模式，寫進 ~/.claude/settings.json（R-52：auto 才會建 junction）；
 * 傳 null 則不建立 settings.json（等同 default 模式）。
 */
export function machinePaths(root, name, { mode = 'auto' } = {}) {
  const base = path.join(root, name);
  fs.mkdirSync(base, { recursive: true });
  const claudeHome = path.join(base, '.claude');
  if (mode) {
    fs.mkdirSync(claudeHome, { recursive: true });
    const f = path.join(claudeHome, 'settings.json');
    if (!fs.existsSync(f)) fs.writeFileSync(f, `${JSON.stringify({ permissions: { defaultMode: mode } }, null, 2)}\n`);
  }
  return { home: path.join(base, '.engram'), claudeHome, userHome: base };
}

export function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 建立假的 git 專案（可指定 remote）。 */
export function makeRepo(dir, { remote, files = { 'README.md': '# demo\n' } } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 't@example.com');
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  if (remote) git(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

export function makeBareRemote(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '--bare', '-b', 'main');
  return dir;
}

/** 在 Claude home 建立某個資料夾的 transcript（可設定修改時間）。 */
export function addTranscript(claudeHome, cwd, { sessionId = `s-${Math.random().toString(36).slice(2, 10)}`, encoded, ageMs = 3 * 3600_000 } = {}) {
  const enc = encoded ?? encodeProjectPath(cwd);
  const dir = path.join(claudeHome, 'projects', enc);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd, sessionId, message: { content: 'hi' } })}\n`);
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
  return { enc, dir, file, sessionId };
}

/** 合成記憶檔（格式與 Claude Code 寫出的相同）。 */
export function memoryText({ name, description, type = 'project', body = '內容。', originSessionId, extra = '' }) {
  return `---
name: ${name}
description: "${description}"
metadata:
  node_type: memory
  type: ${type}
${originSessionId ? `  originSessionId: ${originSessionId}\n` : ''}  modified: 2026-10-01T00:00:00.000Z
${extra}---

${body}
`;
}

/** 把檔案修改時間設成很久以前（跳過 10 秒內的「正在寫入」判定）。 */
export function age(file, ms = 60_000) {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(file, t, t);
}

export function ageTree(dir, ms = 60_000) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.name === '.git') continue;
    if (e.isDirectory()) ageTree(p, ms);
    else if (e.isFile()) age(p, ms);
  }
}
