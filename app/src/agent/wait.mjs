// 啟動常駐程式之後的確認：等它真的開始服務，起不來時從日誌找出原因（engram install、engram ui 共用）。
import { sleep } from '../cli/fsutil.mjs';
import { readLogs } from '../cli/log.mjs';
import { isFresh, pingAgent, readHeartbeat } from './heartbeat.mjs';

/** 等到心跳是新的而且連得上；逾時回傳 null。 */
export async function waitForAgent(paths, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hb = readHeartbeat(paths);
    if (isFresh(hb) && (await pingAgent(hb))) return hb;
    await sleep(250);
  }
  return null;
}

/** since 之後常駐程式最後一筆錯誤（例如連接埠被占用）；沒有時回傳 null。 */
export async function agentStartError(paths, since) {
  const [last] = await readLogs(paths.logs, 'agent', { level: 'error', limit: 1 });
  return last && Date.parse(last.at) >= since ? last.msg : null;
}
