// 相容性探測（R-11）：給 `engram doctor --probe` 與常駐程式的 probe 工作使用。
// 一律在 os.tmpdir() 的暫存資料夾執行，不碰真實專案；結束時只刪除本次建立的暫存資料夾與對應的編碼資料夾。
// 回傳格式同 api.js 的 AgentInfo.probe：{ at, claudeVersion, ok, checks: [{ id, label, ok, detail, en: { label, detail } }] }。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeHome as defaultClaudeHome } from '../paths.mjs';
import { CONTRACTS } from './contracts.mjs';

/**
 * 契約失敗時要暫停的自動化（claude-57 提供的對照表）。沒列出的契約失敗只通知、不暫停。
 * bind＝背景綁定；junction＝junction 熱切換；normalize＝正規化時補回 metadata.engram 欄位。
 */
export const PAUSE_ON_FAIL = Object.freeze({
  C2: Object.freeze(['bind', 'junction']),
  C3: Object.freeze(['junction']), // R-52：只停用 junction，設定檔綁定照常（非 auto 的權限模式也能接上專案）
  C4: Object.freeze([]),
  C5: Object.freeze(['normalize']),
});

/** 依探測結果算出目前要暫停的自動化 */
export function pausedFrom(probe) {
  const out = new Set();
  for (const c of probe?.checks ?? []) if (!c.ok) for (const a of PAUSE_ON_FAIL[c.id] ?? []) out.add(a);
  return [...out].sort();
}

// 父 session 的環境變數要清掉，否則子程序會被當成同一個 session 的一部分
const PARENT_SESSION_KEYS = new Set([
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_EFFORT',
]);

export function childEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (PARENT_SESSION_KEYS.has(k) || k.startsWith('CLAUDE_CODE_MESSAGING_') || k.startsWith('MESSAGING_')) continue;
    out[k] = v;
  }
  out.ENGRAM_HEADLESS = '1'; // 探測用的 session 不跑 Engram 自己的 hooks
  return out;
}

/** 官方的路徑編碼：所有非英數字元換成 '-'（200 字元以內不加 hash，F03） */
export const encodePath = (p) => p.replace(/[^A-Za-z0-9]/g, '-');

/** 探測用的 claude 參數。 */
export function claudeArgs({ tools = false, mode } = {}) {
  // 縮小每次探測的上下文（R-49）：不載入任何 MCP 與使用者／專案層設定（含其他外掛），只保留契約需要的 local 層。
  // 2.1.306 實測：每次呼叫從約 21.7 萬 token 降到約 3 萬 token
  const argv = ['-p', '--model', 'haiku', '--max-turns', '8', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'local'];
  // 問答型契約停用工具，避免模型自己去讀檔而污染「上下文裡有什麼」的判斷
  argv.push('--disallowedTools', tools ? 'Agent,WebFetch,WebSearch,Skill' : 'Bash,Read,Glob,Grep,Write,Edit,Agent,WebFetch,WebSearch,Skill,ToolSearch');
  if (mode) argv.push('--permission-mode', mode);
  return argv;
}

/** 真正呼叫 claude 的執行器。不經過 shell（claude 是 .exe）；非同步，不會卡住常駐程式。 */
export function createClaudeRunner({ timeoutMs = 180_000 } = {}) {
  return (cwd, prompt, opts = {}) => new Promise((resolve) => {
    const child = spawn('claude', claudeArgs(opts), { cwd, env: childEnv(), windowsHide: true });
    const chunks = [];
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(`error: ${err.message}`);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(prompt);
  });
}

/** `claude --version` → '2.1.306'；找不到 claude 時回傳 null。 */
export function detectClaudeVersion({ timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('claude', ['--version'], { env: childEnv(), windowsHide: true });
    let out = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(/\d+\.\d+\.\d+/.exec(out)?.[0] ?? null);
    });
  });
}

function gitRoot(dir) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? path.resolve(r.stdout.trim()) : null;
}

const PERMISSION_MODES = new Set(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);

/**
 * 使用者設定的預設權限模式（~/.claude/settings.json 的 permissions.defaultMode）。
 * 探測只載入 local 層（R-49），需要反映「使用者實際會不會被詢問」的契約（C3）改用這個值明確指定。
 */
export function userPermissionMode(claudeHome) {
  try {
    const mode = JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'))?.permissions?.defaultMode;
    return PERMISSION_MODES.has(mode) ? mode : undefined;
  } catch {
    return undefined;
  }
}

/** 契約用的暫存資料夾工具；記下每次 claude 呼叫會產生的編碼資料夾，結束時清除。 */
function createToolkit(root, claudeHome, runner, created) {
  const mk = (...parts) => {
    const p = path.join(root, ...parts);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };
  const write = (p, s) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, s);
  };
  return {
    claudeHome,
    userMode: userPermissionMode(claudeHome),
    encode: encodePath,
    gitRoot,
    mk,
    write,
    settingsLocal: (dir, obj) => write(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify(obj, null, 2)),
    gitInit: (dir) => spawnSync('git', ['init', '-q'], { cwd: dir, windowsHide: true }),
    async claude(cwd, prompt, opts) {
      created.add(encodePath(gitRoot(cwd) ?? cwd));
      created.add(encodePath(cwd));
      return runner(cwd, prompt, opts);
    },
  };
}

/** 只刪本次建立、而且確實位於暫存根目錄底下的編碼資料夾；先拆 junction，避免遞迴刪到目標。 */
function cleanup(root, claudeHome, created) {
  const prefix = encodePath(root);
  for (const enc of created) {
    if (!enc.startsWith(prefix)) continue;
    const p = path.join(claudeHome, 'projects', enc);
    const m = path.join(p, 'memory');
    try {
      if (fs.lstatSync(m).isSymbolicLink()) fs.unlinkSync(m);
    } catch {
      // 沒有 memory 資料夾
    }
    fs.rmSync(p, { recursive: true, force: true });
  }
  fs.rmSync(root, { recursive: true, force: true });
}

/**
 * 執行探測。
 * @param {{ runner?: Function, claudeHome?: string, only?: string[], keep?: boolean, version?: () => Promise<string|null> }} [opts]
 */
export async function runProbe({ runner = createClaudeRunner(), claudeHome = defaultClaudeHome(), only, keep = false, version = detectClaudeVersion } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'engram-probe-')));
  const created = new Set();
  const t = createToolkit(root, claudeHome, runner, created);
  const checks = [];
  try {
    for (const c of CONTRACTS) {
      if (only && !only.includes(c.id)) continue;
      let r;
      try {
        r = await c.run(t);
      } catch (err) {
        r = { ok: false, detail: `錯誤：${err.message}`, en: { detail: `Error: ${err.message}` } };
      }
      checks.push({ id: c.id, label: c.label, ok: !!r.ok, detail: r.detail ?? '', en: { label: c.en.label, detail: r.en?.detail ?? r.detail ?? '' } });
    }
  } finally {
    if (!keep) cleanup(root, claudeHome, created);
  }
  return {
    at: new Date().toISOString(),
    claudeVersion: await version(),
    ok: checks.every((c) => c.ok),
    checks,
  };
}
