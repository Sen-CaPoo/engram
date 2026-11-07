// 自動駕駛的 AI 判斷（1.5.0）：用使用者的 Claude Code 登入在背景呼叫 `claude -p`，LLM 是「純函式」——
// 不給任何工具（--tools ""）、不載入使用者與專案設定（--setting-sources local，也就不會讀到 CLAUDE.md 與核心準則）、
// 不留對話紀錄（--no-session-persistence），輸出用 --json-schema 限定。資料從 stdin 傳入；寫入一律由引擎執行。
// 2026-11-07 實測（Claude Code 2.1.319）：這組參數每次呼叫的固定開銷約 4k token。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { childEnv } from '../cli/probe/index.mjs';

export const MODELS = Object.freeze({ light: 'haiku', main: 'sonnet' });
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_STDOUT = 8 * 1024 * 1024;

/** 呼叫參數：不給工具、不讀設定與 MCP、不留紀錄、限定輸出格式 */
export function judgeArgs({ model, schema, maxBudgetUsd } = {}) {
  const argv = [
    '-p', '--model', String(model || MODELS.main),
    '--tools', '',
    '--no-session-persistence',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', 'local',
    '--permission-mode', 'default',
    '--max-turns', '4',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
  ];
  if (Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0) argv.push('--max-budget-usd', String(maxBudgetUsd));
  return argv;
}

/** 從 claude -p --output-format json 的輸出取出結構化結果與用量 */
export function parseJudgeOutput(stdout) {
  let j;
  try { j = JSON.parse(String(stdout).trim()); } catch {
    // 有些版本會在 JSON 前印出警告：取最後一個看起來像 JSON 物件的行
    const line = String(stdout).trim().split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
    try { j = line ? JSON.parse(line) : null; } catch { j = null; }
  }
  if (!j || typeof j !== 'object') return { ok: false, error: { code: 'E_LLM_OUTPUT', message: `無法解析 claude 的輸出：${String(stdout).slice(0, 300)}` } };
  const u = j.usage ?? {};
  const usage = {
    input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    output: u.output_tokens ?? 0,
    costUsd: Number(j.total_cost_usd ?? 0) || 0,
  };
  if (j.is_error || j.subtype && j.subtype !== 'success') {
    const message = String(j.result ?? j.error ?? j.subtype ?? 'claude 回報錯誤').slice(0, 500);
    return { ok: false, usage, error: { code: limitHit(message) ? 'E_LLM_LIMIT' : 'E_LLM', message } };
  }
  let data = j.structured_output ?? null;
  if (data === null) {
    const text = String(j.result ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { data = JSON.parse(text); } catch {
      return { ok: false, usage, error: { code: 'E_LLM_OUTPUT', message: `結果不是 JSON：${text.slice(0, 300)}` } };
    }
  }
  if (!data || typeof data !== 'object') return { ok: false, usage, error: { code: 'E_LLM_OUTPUT', message: '結果不是 JSON 物件' } };
  return { ok: true, data, usage };
}

/** 用量上限、速率限制：這一輪不要再呼叫 */
export function limitHit(message) {
  return /usage limit|rate limit|limit reached|quota|overloaded|429|credit balance/i.test(String(message ?? ''));
}

/**
 * 建立判斷器。回傳 async ({ model, schema, prompt, maxBudgetUsd }) => { ok, data?, usage, ms, error? }，不丟例外。
 * cwd：固定的工作資料夾（Claude Code 會為它建立空的專案紀錄資料夾，每輪結束由呼叫端清掉）。
 */
export function createClaudeJudge({ cwd, bin = 'claude', spawnImpl = spawn, timeoutMs = DEFAULT_TIMEOUT_MS, env = childEnv() } = {}) {
  if (cwd) fs.mkdirSync(cwd, { recursive: true });
  return ({ model, schema, prompt, maxBudgetUsd, signal }) => new Promise((resolve) => {
    const t0 = Date.now();
    if (signal?.aborted) { resolve({ ok: false, usage: { input: 0, output: 0, costUsd: 0 }, ms: 0, error: { code: 'E_STOPPED', message: '已停止' } }); return; }
    let child;
    try {
      child = spawnImpl(bin, judgeArgs({ model, schema, maxBudgetUsd }), { cwd, env, windowsHide: true });
    } catch (err) {
      resolve({ ok: false, usage: { input: 0, output: 0, costUsd: 0 }, ms: 0, error: { code: 'E_LLM_SPAWN', message: err.message } });
      return;
    }
    const out = [];
    const errOut = [];
    let size = 0;
    let killed = false;
    let aborted = false;
    const timer = setTimeout(() => { killed = true; child.kill(); }, timeoutMs);
    timer.unref?.();
    const onAbort = () => { aborted = true; killed = true; child.kill(); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.on('close', () => signal?.removeEventListener?.('abort', onAbort));
    child.stdout.on('data', (d) => { size += d.length; if (size <= MAX_STDOUT) out.push(d); });
    child.stderr.on('data', (d) => { if (errOut.length < 50) errOut.push(d); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, usage: { input: 0, output: 0, costUsd: 0 }, ms: Date.now() - t0, error: { code: 'E_LLM_SPAWN', message: `無法執行 ${bin}：${err.message}` } });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      if (aborted) {
        resolve({ ok: false, usage: { input: 0, output: 0, costUsd: 0 }, ms, error: { code: 'E_STOPPED', message: '已停止' } });
        return;
      }
      if (killed) {
        resolve({ ok: false, usage: { input: 0, output: 0, costUsd: 0 }, ms, error: { code: 'E_LLM_TIMEOUT', message: `claude 超過 ${Math.round(timeoutMs / 1000)} 秒沒有回應` } });
        return;
      }
      const stdout = Buffer.concat(out).toString('utf8');
      const r = parseJudgeOutput(stdout);
      if (!r.ok && !stdout.trim()) {
        const stderr = Buffer.concat(errOut).toString('utf8').trim();
        r.error = { code: limitHit(stderr) ? 'E_LLM_LIMIT' : 'E_LLM', message: `claude 結束（${code}）：${stderr.slice(0, 300) || '沒有輸出'}` };
      }
      resolve({ ...r, usage: r.usage ?? { input: 0, output: 0, costUsd: 0 }, ms });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(String(prompt ?? ''), 'utf8');
  });
}
