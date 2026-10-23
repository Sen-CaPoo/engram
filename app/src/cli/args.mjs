// 指令列參數解析（node:util parseArgs），錯誤訊息改為正體中文。
import { parseArgs } from 'node:util';
import { CliError } from './errors.mjs';

// 每個指令都支援的選項
export const GLOBAL_OPTIONS = Object.freeze({
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
});

/** @returns {{ opts: Record<string, any>, args: string[] }} */
export function parseCommandArgs(argv, options = {}) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { ...GLOBAL_OPTIONS, ...options },
      allowPositionals: true,
      strict: true,
    });
    return { opts: values, args: positionals };
  } catch (err) {
    const opt = /'(-{1,2}[^'\s]+)/.exec(err.message)?.[1] ?? '';
    const message = {
      ERR_PARSE_ARGS_UNKNOWN_OPTION: `不認得的選項：${opt}`,
      ERR_PARSE_ARGS_INVALID_OPTION_VALUE: `選項 ${opt} 的值不正確（可能少了值）`,
    }[err.code] ?? `參數有誤：${err.message}`;
    throw new CliError('E_USAGE', message);
  }
}

/** '30s'、'10m'、'500ms'、'2h'；純數字視為秒。回傳毫秒。 */
export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(String(text ?? '').trim());
  if (!m) throw new CliError('E_USAGE', `看不懂的時間長度：${text}`, '例如 30s、10m、500ms。');
  const unit = (m[2] || 's').toLowerCase();
  return Math.round(Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]);
}

/** 正整數選項（例如 --limit、--port） */
export function parsePositiveInt(text, name, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(text);
  if (!Number.isInteger(n) || n <= 0 || n > max) throw new CliError('E_USAGE', `${name} 必須是 1 到 ${max} 之間的整數：${text}`);
  return n;
}
