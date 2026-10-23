// 常駐程式自己的設定（每台電腦各自一份，不同步）：同步間隔、健康檢查時間、使用者手動暫停。
// 暫停狀態同時寫進 local/paused.json，讓引擎的 SessionStart 也知道要跳過自動接上。
import path from 'node:path';
import { readJsonSync, writeJsonAtomic } from '../cli/fsutil.mjs';

export const DEFAULTS = Object.freeze({ syncIntervalMin: 10, healthTime: '09:30', paused: false });
const INTERVALS = new Set([5, 10, 15, 30]);

export function createSettings(paths) {
  const file = path.join(paths.local, 'agent-settings.json');
  const pausedFile = path.join(paths.local, 'paused.json');
  let cur = { ...DEFAULTS, ...(readJsonSync(file, {}) ?? {}) };

  /** 依目前的使用者暫停與探測暫停，重寫 local/paused.json（引擎讀這個檔） */
  async function writePaused(probePaused = []) {
    const p = {
      user: !!cur.paused,
      junction: !!cur.paused || probePaused.includes('bind') || probePaused.includes('junction'),
      normalize: !!cur.paused || probePaused.includes('normalize'),
    };
    await writeJsonAtomic(pausedFile, p);
    return p;
  }

  return {
    get: () => ({ ...cur }),
    syncEveryMs: () => cur.syncIntervalMin * 60_000,
    healthAt: () => {
      const [hour, minute] = cur.healthTime.split(':').map(Number);
      return { hour, minute };
    },
    paused: () => !!cur.paused,
    writePaused,
    /** 只接受認得的欄位與合法的值；回傳更新後的設定 */
    async set(patch = {}) {
      const next = { ...cur };
      if (patch.syncIntervalMin !== undefined) {
        const n = Number(patch.syncIntervalMin);
        if (!INTERVALS.has(n)) throw Object.assign(new Error('同步間隔只能是 5、10、15 或 30 分鐘'), { code: 'E_INVALID', en: { message: 'The sync interval must be 5, 10, 15 or 30 minutes' } });
        next.syncIntervalMin = n;
      }
      if (patch.healthTime !== undefined) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(patch.healthTime))) throw Object.assign(new Error('時間格式為 HH:MM'), { code: 'E_INVALID', en: { message: 'The time format is HH:MM' } });
        next.healthTime = String(patch.healthTime);
      }
      if (patch.paused !== undefined) next.paused = !!patch.paused;
      cur = next;
      await writeJsonAtomic(file, cur);
      return { ...cur };
    },
  };
}
