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
  if (!j || typeof j !== 'object') {
    // 整段輸出都不是 JSON：claude 直接印出錯誤訊息（例如用量上限、登入失效），不是模型的回覆。
    // 只看開頭（錯誤訊息很短；輸出被截斷的 JSON 裡可能夾著模型的回覆內容），而且要像 Claude Code 自己的錯誤訊息
    const c = cliErrorCode(String(stdout).trim().slice(0, 1000));
    return { ok: false, error: { code: c === 'E_LLM' ? 'E_LLM_OUTPUT' : c, message: `無法解析 claude 的輸出：${String(stdout).slice(0, 300)}` } };
  }
  const u = j.usage ?? {};
  const usage = {
    input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    output: u.output_tokens ?? 0,
    costUsd: Number(j.total_cost_usd ?? 0) || 0,
  };
  if (j.is_error || j.subtype && j.subtype !== 'success') {
    const full = String(j.result ?? j.error ?? j.subtype ?? 'claude 回報錯誤');
    // 審查 U4：result 可能是模型的回覆（剛好談到登入或額度）；只有像 Claude Code 自己的錯誤訊息時才判斷登入失效、上限與忙碌
    return { ok: false, usage, error: { code: cliErrorCode(full), message: full.slice(0, 500) } };
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

/**
 * 撞到 Claude 的用量上限（5 小時、每週）：這一輪不要再呼叫，兩台都等到重置時間。
 * 2.0.0：實際的訊息是 `You've hit your 5-hour limit · resets 3:00am (Asia/Taipei)`（週上限是 weekly limit）。
 * 只認明確的上限寫法，或寫著重置時間的訊息；過載、速率限制這類暫時性的錯誤見 busyHit。
 */
export function limitHit(message) {
  const s = String(message ?? '');
  return /usage limit|limit reached|hit your [^\n]{0,40}limit|weekly limit|\d+-hour limit/i.test(s) || (/\bresets?\b/i.test(s) && parseResetAt(s) !== null);
}

/**
 * 暫時性的忙碌（2.0.0）：伺服器過載（529）、速率限制（429）。只停止這一輪，照排程既有的重試間隔再試，
 * 不寫進同步的狀態（另一台照常）。quota、credit balance 沒有重置時間可等，也歸在這一類。
 */
export function busyHit(message) {
  return /\boverloaded\b|\brate[ _-]?limit|\b429\b|\b529\b|too many requests|quota|credit balance/i.test(String(message ?? ''));
}

/**
 * Claude Code 的登入失效（到期、被登出、金鑰無效）：這一輪不要再呼叫，請使用者重新登入（2.0.0）。
 * 實際的訊息：`Failed to authenticate: this login reached its time limit and cannot be renewed. Run \`claude auth login\` …`、
 * `Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.`
 */
export function authFailure(message) {
  return /failed to authenticate|oauth access token has expired|cannot be renewed|claude auth login|not logged in|please run \/login|invalid api key|authentication_error/i.test(String(message ?? ''));
}

/**
 * 錯誤訊息 → 錯誤代碼。登入失效先判斷（登入到期的訊息裡也有 time limit 這種字）；
 * 用量上限優先於暫時性的忙碌（兩種寫法同時出現時要等重置）
 */
const errorCode = (message) => (authFailure(message) ? 'E_LLM_AUTH' : limitHit(message) ? 'E_LLM_LIMIT' : busyHit(message) ? 'E_LLM_BUSY' : 'E_LLM');

/** Claude Code 自己的錯誤訊息的開頭（API 錯誤、登入、用量上限）；模型的回覆不會這樣開頭 */
const CLI_ERROR_START = /^\s*(API Error\b|Failed to authenticate|Invalid API key|Not logged in|Please run \/login|OAuth (access )?token|Claude AI usage limit|You['’]ve hit your|You have hit your|Your limit|Usage limit|Credit balance|Rate limit|Overloaded|Request (was )?rejected|\{\s*"type"\s*:\s*"error")/i;
/** 錯誤訊息短到不會是模型的回覆 */
const CLI_ERROR_MAX = 300;

/**
 * 只有確定是 Claude Code 自己的錯誤訊息（很短，或以已知的錯誤句型開頭）才判斷登入失效、用量上限與暫時忙碌（審查 U4）；
 * 其他的（可能是模型的回覆，剛好談到 claude auth login、quota）一律 E_LLM，不會整輪停止或發出登入通知。
 */
const cliErrorCode = (message) => (String(message).length <= CLI_ERROR_MAX || CLI_ERROR_START.test(String(message)) ? errorCode(message) : 'E_LLM');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** 某個時刻在某個時區（undefined：這台電腦的時區）的年月日時分秒 */
function zonedParts(t, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, mo: p.month - 1, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

/** 某個時區的牆上時間 → 時刻（日期超出範圍時由 Date.UTC 進位，例如 d + 1） */
function fromZoned(y, mo, d, h, mi, timeZone) {
  const guess = Date.UTC(y, mo, d, h, mi);
  const offset = (t) => { const p = zonedParts(t, timeZone); return Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000; };
  const t = guess - offset(guess);
  return guess - offset(t); // 再算一次，跨過日光節約時間的切換點也對
}

/**
 * 用量上限訊息裡的重置時間（毫秒）：`resets 3:00am (Asia/Taipei)`、`resets Nov 24, 3pm (Asia/Taipei)`、
 * 舊的 `usage limit reached|<秒數>`。沒有寫日期時取 now 之後最近的那個時刻；沒有時區時用這台電腦的時區。解析不到回傳 null。
 */
export function parseResetAt(message, now = Date.now()) {
  const s = String(message ?? '');
  const epoch = /\|(\d{10})\b/.exec(s);
  if (epoch) { const t = Number(epoch[1]) * 1000; return t > now ? t : null; }
  const m = /\bresets?\s+(?:at\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,\s*|\s+at\s+|\s+))?(\d{1,2})(?!\d)(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2})\))?/i.exec(s);
  if (!m) return null;
  let tz = m[6];
  try { if (tz) zonedParts(now, tz); } catch { tz = undefined; } // 不認得的時區：用這台電腦的
  let h = Number(m[3]);
  const mi = Number(m[4] ?? 0);
  const ap = m[5]?.toLowerCase();
  if (ap) { if (h < 1 || h > 12) return null; h = (h % 12) + (ap === 'pm' ? 12 : 0); } else if (h > 23) return null;
  if (mi > 59) return null;
  const today = zonedParts(now, tz);
  if (m[1]) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    const d = Number(m[2]);
    if (d < 1 || d > 31) return null;
    const t = fromZoned(today.y, mo, d, h, mi, tz);
    return t > now ? t : fromZoned(today.y + 1, mo, d, h, mi, tz); // 跨年
  }
  const t = fromZoned(today.y, today.mo, today.d, h, mi, tz);
  return t > now ? t : fromZoned(today.y, today.mo, today.d + 1, h, mi, tz);
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
      const stderr = Buffer.concat(errOut).toString('utf8').trim();
      if (!r.ok && !stdout.trim()) {
        r.error = { code: errorCode(stderr), message: `claude 結束（${code}）：${stderr.slice(0, 300) || '沒有輸出'}` };
      } else if (!r.ok && r.error?.code === 'E_LLM_OUTPUT' && r.error.message.startsWith('無法解析') && errorCode(stderr) !== 'E_LLM') {
        // 輸出解析不了、stderr 說是用量上限或登入失效
        r.error = { code: errorCode(stderr), message: `claude 結束（${code}）：${stderr.slice(0, 300)}` };
      }
      resolve({ ...r, usage: r.usage ?? { input: 0, output: 0, costUsd: 0 }, ms });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(String(prompt ?? ''), 'utf8');
  });
}
