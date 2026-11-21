// 情境召回的後備（mod 沒有載入時）：指令型的 UserPromptSubmit hook，由 run.mjs 在讀安裝清單、載入 Engram 引擎之前直接呼叫。
// 每則訊息都會啟動一次，所以要輕：只用 node:fs 與外掛裡的 lens/recall.mjs（同一份計分），不載入引擎。
// mod 已載入（這場對話有 local/cache/session/<session id>.mod 標記檔）就直接結束，避免同一則訊息帶兩次。
// 同一場對話帶過的不重複：從今天與昨天的帶出紀錄（local/usage/recall/<日期>[.<程序代號>].jsonl，日期是 UTC；mod 寫的也算）找。
import fs from 'node:fs';
import path from 'node:path';
import { contextText, parseIndex, projectOf, recalledIn, recallMode, recentUsageFiles, score, usageFileName, usageLine } from './lens/recall.mjs';

/** UserPromptSubmit 的 source：使用者在終端機送出（user）、claude -p 與 SDK（sdk）；沒有這個欄位也算 */
const USER_SOURCES = new Set(['user', 'sdk']);
/** 斜線指令（/review、/engram:save）不處理；/c/Users 這種路徑開頭不算 */
const SLASH = /^\/[A-Za-z][\w:.-]*(\s|$)/;

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/**
 * @param {{ session_id?: string, prompt?: string, cwd?: string, source?: string }} input  UserPromptSubmit 的 stdin
 * @param {{ home: string, now?: number, env?: Record<string, string|undefined> }} o
 * @returns {string|null} 要寫到 stdout 的 JSON；沒有要帶的就是 null
 */
export function promptSubmit(input, { home, now = Date.now(), env = process.env }) {
  if (env.ENGRAM_HEADLESS === '1') return null;
  const prompt = String(input?.prompt ?? '');
  const session = path.basename(String(input?.session_id ?? ''));
  if (!prompt.trim() || SLASH.test(prompt.trimStart())) return null;
  if (input?.source && !USER_SOURCES.has(input.source)) return null;
  const local = path.join(home, 'local');
  if (session && fs.existsSync(path.join(local, 'cache', 'session', `${session}.mod`))) return null;
  // 這台的 recall；所有電腦共用的索引分層（vault/settings.json）是 on 時強制開啟
  if (recallMode(readText(path.join(local, 'settings.json')), readText(path.join(home, 'vault', 'settings.json'))) === 'off') return null;
  const index = parseIndex(readText(path.join(local, 'cache', 'recall.json')));
  if (!index?.n) return null;

  const dir = path.join(local, 'usage', 'recall');
  const today = path.join(dir, usageFileName(new Date(now).toISOString().slice(0, 10)));
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* 還沒有紀錄 */ }
  const seen = new Set();
  for (const n of recentUsageFiles(names, now)) for (const ref of recalledIn(readText(path.join(dir, n)), session)) seen.add(ref);
  const hits = score(index, prompt, { pid: projectOf(index, input?.cwd), exclude: seen });
  const text = contextText(hits);
  if (!text) return null;
  try {
    const at = new Date(now).toISOString();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(today, hits.map((h) => usageLine({ at, session, ref: h.ref, score: h.score })).join(''));
  } catch {
    // 紀錄寫不了不影響帶出
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } });
}
