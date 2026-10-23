// 指令輸出：--json 時印機器可讀的 JSON；否則印給人看的正體中文。錯誤一律「訊息＋建議」。
import { toErrorInfo } from './errors.mjs';

export function createOutput({ json = false, stdout = process.stdout, stderr = process.stderr } = {}) {
  return {
    json,
    /** human 可以是字串或字串陣列（null／undefined 的行略過） */
    result(data, human) {
      if (json) stdout.write(`${JSON.stringify(data ?? null, null, 2)}\n`);
      else if (human != null) stdout.write(`${[].concat(human).filter((l) => l != null).join('\n')}\n`);
    },
    error(err) {
      const info = toErrorInfo(err);
      if (json) stdout.write(`${JSON.stringify({ error: info }, null, 2)}\n`);
      else stderr.write(`錯誤：${info.message}（${info.code}）\n建議：${info.hint}\n`);
    },
  };
}

// ───────── 共用的中文標籤 ─────────

export const SYNC_LABEL = { ok: '已同步', syncing: '同步中', offline: '離線', auth: '需要登入 GitHub', error: '同步失敗', never: '尚未同步' };
export const SEVERITY_LABEL = { high: '高', medium: '中', low: '低', auto: '自動' };

export function scopeLabel(scope) {
  const s = typeof scope === 'string' ? { kind: scope } : scope ?? {};
  if (s.kind === 'global') return '全域';
  if (s.kind === 'project') return s.pid ? `專案 ${s.pid}` : '專案';
  if (s.kind === 'machine') return s.mid ? `單機 ${s.mid}` : '單機';
  return '未知範圍';
}
