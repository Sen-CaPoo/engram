// 背景綁定（R-06，40 號 v0.4）：bindings 裡 state 為 'pending' 的項目（原記憶資料夾有內容，或當時有進行中的對話），
// 等該資料夾的對話都結束（transcript 30 分鐘沒有更新）後，呼叫 eg.identity.bind(path, { pid }, { mode: 'safe' }) 完成切換。
// 40 號 §15 沒有列出「待切換綁定」的 API，這裡用引擎自己的唯讀函式取得，不自行解析 vault。
import { hasActiveSession, scanEncodedDir } from '../core/transcripts.mjs';
import { readBindings } from '../core/vault.mjs';

export const SESSION_IDLE_MS = 30 * 60_000;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

/** 這台電腦待切換的綁定：[{ encoded, pid, path, method, state, ... }] */
export async function pendingBindings(eg) {
  const all = (await readBindings(eg.paths.vault, eg.machine.id)) ?? {};
  // 鍵是編碼資料夾名稱；設定檔備援的鍵是「編碼@路徑雜湊」（R-25）
  return Object.entries(all)
    .filter(([, b]) => b?.state === 'pending')
    .map(([key, b]) => ({ ...b, key, encoded: b.encoded ?? key.split('@')[0] }));
}

/**
 * 每次執行都重新讀取 pending 綁定。引擎仍回報 pending（例如檔案被占用）或失敗時退避重試，
 * 避免每分鐘重複呼叫 bind（每次呼叫都會產生一個 commit）。
 */
export function createPendingBinder({ eg, log }) {
  const backoff = new Map(); // 綁定的鍵 → { attempts, notBefore }

  function delay(key, now, reason) {
    const prev = backoff.get(key)?.attempts ?? 0;
    backoff.set(key, { attempts: prev + 1, notBefore: now + BACKOFF_MS[Math.min(prev, BACKOFF_MS.length - 1)] });
    log?.warn('bind', `背景綁定稍後重試（第 ${prev + 1} 次）：${reason}`);
  }

  return {
    async run({ now = Date.now() } = {}) {
      const result = { done: [], waiting: [], failed: [] };
      for (const b of await pendingBindings(eg)) {
        const item = { path: b.path, pid: b.pid };
        // SW-2：匯入計畫產生後來源又有變更，要由使用者重新規劃；自動接上會把計畫裡略過的檔案也整批複製進 vault
        if (b.reason === 'changed-since-plan') {
          result.waiting.push({ ...item, reason: b.reason });
          continue;
        }
        if ((backoff.get(b.key)?.notBefore ?? 0) > now) {
          result.waiting.push({ ...item, reason: 'backoff' });
          continue;
        }
        const scan = await scanEncodedDir(eg.paths.claudeHome, b.encoded);
        if (hasActiveSession(scan, SESSION_IDLE_MS, now)) {
          result.waiting.push({ ...item, reason: 'active-session' });
          continue;
        }
        try {
          const res = await eg.identity.bind(b.path, { pid: b.pid }, { mode: 'safe' });
          if (res?.state === 'pending') {
            result.waiting.push({ ...item, reason: res.deferredReason ?? 'pending' });
            delay(b.key, now, `${b.path}（${res.deferredReason ?? 'pending'}）`);
          } else {
            backoff.delete(b.key);
            result.done.push(item);
            log?.info('bind', `背景綁定完成：${b.path} → ${b.pid}`);
          }
        } catch (err) {
          result.failed.push({ ...item, error: err?.code ?? err?.message });
          delay(b.key, now, `${b.path}（${err?.code ?? err?.message}）`);
        }
      }
      return result;
    },
  };
}
