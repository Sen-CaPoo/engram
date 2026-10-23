// 每日輪替的 JSON 行日誌：local/logs/<name>-YYYY-MM-DD.log，每行 { at, level, src, msg }，保留 14 天。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { localDate } from './fsutil.mjs';

export const LEVELS = ['debug', 'info', 'warn', 'error'];
export const RETAIN_DAYS = 14;

function toMessage(msg) {
  if (msg instanceof Error) return msg.code ? `${msg.code} ${msg.message}` : msg.message;
  return typeof msg === 'string' ? msg : JSON.stringify(msg);
}

/** 寫入用同步 append：日誌只增不改，程序隨時結束也不會遺失最後一行。 */
export function createLogger(logsDir, name, { echo = false } = {}) {
  function write(level, src, msg) {
    const entry = { at: new Date().toISOString(), level, src, msg: toMessage(msg) };
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      fs.appendFileSync(path.join(logsDir, `${name}-${localDate()}.log`), `${JSON.stringify(entry)}\n`);
    } catch {
      // 日誌寫不進去也不能影響主流程
    }
    if (echo) process.stderr.write(`[${entry.at}] ${level} ${src}: ${entry.msg}\n`);
  }
  return Object.fromEntries(LEVELS.map((lv) => [lv, (src, msg) => write(lv, src, msg)]));
}

/** 刪除超過保留天數的日誌檔（依檔名日期判斷）。 */
export async function pruneLogs(logsDir, { days = RETAIN_DAYS, now = new Date() } = {}) {
  const cutoff = localDate(new Date(now.getTime() - days * 864e5));
  const names = await fsp.readdir(logsDir).catch(() => []);
  let removed = 0;
  for (const n of names) {
    const m = /-(\d{4}-\d{2}-\d{2})\.log$/.exec(n);
    if (m && m[1] < cutoff) {
      await fsp.rm(path.join(logsDir, n), { force: true }).catch(() => {});
      removed++;
    }
  }
  return removed;
}

/**
 * 讀取最新的日誌（由新到舊找檔，結果依時間由舊到新排列）。
 * level 為最低等級：level=warn 會列出 warn 與 error。
 */
export async function readLogs(logsDir, name, { level, limit = 200 } = {}) {
  const min = Math.max(0, LEVELS.indexOf(level));
  const files = (await fsp.readdir(logsDir).catch(() => []))
    .filter((n) => n.startsWith(`${name}-`) && n.endsWith('.log'))
    .sort()
    .reverse();
  const out = [];
  for (const f of files) {
    const text = await fsp.readFile(path.join(logsDir, f), 'utf8').catch(() => '');
    const lines = text.split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (LEVELS.indexOf(e.level) >= min) out.push(e);
      } catch {
        // 寫到一半的行略過
      }
      if (out.length >= limit) return out.reverse();
    }
  }
  return out.reverse();
}
