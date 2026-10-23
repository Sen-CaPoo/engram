// Claude Code hooks 的進入點（ADR §06）。由外掛的 hooks/run.mjs 或 `engram hook <event>` 呼叫。
// 共同規則：ENGRAM_HEADLESS=1 時什麼都不做；任何錯誤都吞掉並寫進 local/logs/hooks-YYYY-MM-DD.log；
// 永遠不擋住 Claude Code（呼叫端一律 exit 0）。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readHeartbeat, requestAgent } from '../agent/heartbeat.mjs';
import { loadEngine } from '../cli/engine.mjs';
import { readJsonSync, writeJsonAtomic } from '../cli/fsutil.mjs';
import { createLogger } from '../cli/log.mjs';
import { localPaths } from '../cli/paths.mjs';
import { spawnDetachedNode } from '../cli/proc.mjs';
import { instructionsLoaded } from './loaded.mjs';
import { contextOutput, FAILURE_NOTICE_AT, failureNotice, postCompact, sessionEnd, sessionStart, stop } from './session.mjs';

const HANDLERS = {
  'session-start': sessionStart,
  stop,
  'session-end': sessionEnd,
  'post-compact': postCompact,
  'instructions-loaded': instructionsLoaded,
};

/** 'SessionStart' 或 'session-start' 都接受 */
export function normalizeEvent(event) {
  return String(event ?? '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

/** handler 用到的外部能力集中在這裡，測試時可逐項替換。 */
function makeDeps(overrides) {
  const paths = overrides.paths ?? localPaths();
  return {
    paths,
    log: createLogger(paths.logs, 'hooks'),
    loadEngine,
    spawnNode: spawnDetachedNode,
    readHeartbeat: () => readHeartbeat(paths),
    requestAgent,
    now: () => Date.now(),
    ...overrides,
  };
}

// hooks 連續失敗的計數（21 號文件）：任何 hook 失敗都加一，SessionStart 成功時歸零；
// 達到 FAILURE_NOTICE_AT 次時，SessionStart 的狀態文字會加一行提醒。
const failuresFile = (paths) => path.join(paths.local, 'hooks-failures.json');

async function recordFailure(deps, name, err) {
  const prev = readJsonSync(failuresFile(deps.paths), null);
  const next = {
    count: (prev?.count ?? 0) + 1,
    last: { event: name, code: err?.code ?? null, message: err?.message ?? String(err), at: new Date(deps.now()).toISOString() },
  };
  await writeJsonAtomic(failuresFile(deps.paths), next).catch(() => {});
  return next;
}

/** 執行一個 hook，回傳要寫到 stdout 的字串（沒有輸出時為 null）。不會丟例外。 */
export async function runHook(event, input = {}, overrides = {}) {
  if (process.env.ENGRAM_HEADLESS === '1') return null;
  const name = normalizeEvent(event);
  const deps = makeDeps(overrides);
  const handler = HANDLERS[name];
  if (!handler) {
    deps.log.warn('hook', `不認得的事件：${event}`);
    return null;
  }
  const failures = name === 'session-start' ? readJsonSync(failuresFile(deps.paths), null) : null;
  try {
    const out = (await handler(input ?? {}, { ...deps, failures })) ?? null;
    if (failures) await fsp.rm(failuresFile(deps.paths), { force: true }).catch(() => {});
    return out;
  } catch (err) {
    deps.log.error(name, err);
    const next = await recordFailure(deps, name, err);
    return name === 'session-start' && next.count >= FAILURE_NOTICE_AT ? contextOutput(failureNotice(next)) : null;
  }
}

/** 執行 hook 並把輸出寫到 stdout（寫完才返回）；handler 延後的工作（例如喚醒常駐程式）在輸出之後才做。 */
export async function main(event, input, overrides = {}) {
  const later = [];
  const out = await runHook(event, input, { ...overrides, defer: (fn) => later.push(fn) });
  if (out) {
    const stdout = overrides.stdout ?? process.stdout;
    await new Promise((resolve) => stdout.write(out, () => resolve()));
  }
  for (const fn of later) await Promise.resolve().then(fn).catch(() => {});
}

/** 讀 stdin 的 JSON。Claude Code 寫完會關閉 stdin；保險起見設逾時，避免卡住。 */
export async function readStdinJson(stdin = process.stdin, timeoutMs = 3000) {
  if (stdin.isTTY) return {};
  const text = await new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => finish(), timeoutMs);
    function finish() {
      clearTimeout(timer);
      stdin.removeAllListeners('data');
      stdin.pause();
      resolve(Buffer.concat(chunks).toString('utf8'));
    }
    stdin.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stdin.once('end', finish);
    stdin.once('error', finish);
  });
  try {
    return JSON.parse((text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) || '{}');
  } catch {
    return {};
  }
}
