// 常駐程式的心跳檔 local/agent.json：{ pid, port, token, startedAt, beatAt, version, lastSyncAt }。
// hooks 與 CLI 用它判斷常駐程式是否活著、怎麼連線。這個模組要保持輕量（hook 的冷啟動會載入它）。
import http from 'node:http';
import { readJsonSync, writeJsonAtomic } from '../cli/fsutil.mjs';

export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 90_000;

export function readHeartbeat(paths) {
  return readJsonSync(paths.agentFile, null);
}

export function isFresh(hb, now = Date.now()) {
  const t = Date.parse(hb?.beatAt ?? '');
  return Number.isFinite(t) && now - t < STALE_MS;
}

/** 給 status／doctor 顯示用 */
export function agentState(paths, now = Date.now()) {
  const hb = readHeartbeat(paths);
  if (hb && isFresh(hb, now)) {
    return { running: true, pid: hb.pid, port: hb.port, beatAt: hb.beatAt, lastSyncAt: hb.lastSyncAt ?? null };
  }
  return { running: false, lastBeatAt: hb?.beatAt ?? null };
}

/** 心跳檔含 token：權限盡量只限本人（Windows 上由使用者設定檔資料夾的 ACL 保護）。 */
export function writeHeartbeat(paths, info) {
  return writeJsonAtomic(paths.agentFile, info, { mode: 0o600 });
}

/**
 * 對常駐程式發一個 API 請求。逾時或連線失敗回傳 null，不丟例外。
 * @returns {Promise<{ status: number, body: any } | null>}
 */
export function requestAgent(hb, method, urlPath, body, timeoutMs = 300) {
  if (!hb?.port || !hb?.token) return Promise.resolve(null);
  return new Promise((resolve) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const req = http.request(
      {
        host: '127.0.0.1',
        port: hb.port,
        method,
        path: urlPath,
        headers: {
          Host: `127.0.0.1:${hb.port}`,
          'X-Engram-Token': hb.token,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
          } catch {
            // 非 JSON 回應只看狀態碼
          }
          done({ status: res.statusCode, body: parsed });
        });
        res.on('error', () => done(null));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done(null);
    }, timeoutMs);
    req.on('error', () => done(null));
    req.end(data);
  });
}

export async function pingAgent(hb, timeoutMs = 500) {
  const r = await requestAgent(hb, 'GET', '/api/agent', undefined, timeoutMs);
  return r?.status === 200;
}
