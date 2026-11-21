// engram agent：每位使用者一個背景程序，提供管理介面（127.0.0.1:4777）並在程序內執行所有排程工作（ADR §04、§07）。
// 由工作排程器的登入工作 \Engram\Agent 啟動；SessionStart hook 發現心跳過期時也會在背景啟動它。
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadEngine } from '../cli/engine.mjs';
import { CliError } from '../cli/errors.mjs';
import { createLogger, pruneLogs } from '../cli/log.mjs';
import { appVersion, DEFAULT_PORT, localPaths } from '../cli/paths.mjs';
import { detectClaudeVersion, runProbe as realRunProbe } from '../cli/probe/index.mjs';
import { BACKGROUND_ENV, spawnDetachedNode } from '../cli/proc.mjs';
import { createNotifier } from '../scheduler/notify.mjs';
import { status as realSchedulerStatus } from '../scheduler/task.mjs';
import { createApi } from './api.mjs';
import { createEventHub } from './events.mjs';
import { HEARTBEAT_MS, isFresh, pingAgent, readHeartbeat, writeHeartbeat } from './heartbeat.mjs';
import { createAgentInfo } from './info.mjs';
import { createJobs } from './jobs.mjs';
import { createSettings } from './settings.mjs';
import { createAgentServer } from './server.mjs';
import { pruneRecords, tidyDir } from '../tidy/store.mjs';

const DAY = 864e5;
const LOADED_RETAIN_DAYS = 30;
const SESSION_CACHE_EVERY_MS = 5 * 60_000;

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** 另一個常駐程式的心跳是新的、而且連得上 → 回傳它的心跳；否則 null */
async function otherAgent(paths) {
  const hb = readHeartbeat(paths);
  if (hb && hb.pid !== process.pid && isFresh(hb) && (await pingAgent(hb, 1000))) return hb;
  return null;
}

/** 每日維護：日誌保留 14 天、local/loaded/ 保留 30 天、整理記錄保留 90 天 */
async function maintenance(paths, log) {
  await pruneLogs(paths.logs).catch((err) => log.warn('maintenance', err));
  await pruneRecords(paths.local).catch((err) => log.warn('maintenance', err));
  const cutoff = Date.now() - LOADED_RETAIN_DAYS * DAY;
  for (const n of await fsp.readdir(paths.loaded).catch(() => [])) {
    const file = path.join(paths.loaded, n);
    const st = await fsp.stat(file).catch(() => null);
    if (st && st.mtimeMs < cutoff) await fsp.rm(file, { force: true }).catch(() => {});
  }
}

/** 整理記錄有變化（Claude 建立或執行、另一個分頁存了決定）：通知介面重新讀取。暫存檔與鎖檔不算。 */
function watchTidy(localDir, events, log) {
  const dir = tidyDir(localDir);
  let timer = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const w = fs.watch(dir, (_evt, name) => {
      if (name && !String(name).endsWith('.json')) return;
      clearTimeout(timer);
      timer = setTimeout(() => events.emit('tidy', { at: new Date().toISOString() }), 300);
      timer.unref?.();
    });
    w.on('error', (err) => { log.warn('tidy-watch', err); w.close(); });
    return { close: () => { clearTimeout(timer); w.close(); } };
  } catch (err) {
    log.warn('tidy-watch', `無法監看整理記錄（${dir}）：${err.message}`);
    return { close() {} };
  }
}

/**
 * 啟動常駐程式。已有另一個常駐程式在執行時回傳 { alreadyRunning }。
 * 測試時可注入引擎、路徑、介面資料夾與各項外部動作。
 */
export async function startAgent({
  port = DEFAULT_PORT,
  engine,
  paths = localPaths(),
  uiDir,
  echo = false,
  schedulerStatus = realSchedulerStatus,
  notifier,
  runProbe = realRunProbe,
  detectVersion = detectClaudeVersion,
  handleSignals = true,
} = {}) {
  // 背景執行的 git 不得跳出認證視窗（R-10）；引擎呼叫的 git 會繼承這些環境變數
  Object.assign(process.env, BACKGROUND_ENV);
  const log = createLogger(paths.logs, 'agent', { echo });

  const existing = await otherAgent(paths);
  if (existing) return { alreadyRunning: existing };

  const eg = engine ?? (await loadEngine());
  const token = randomBytes(24).toString('base64url');
  const events = createEventHub();
  const settings = createSettings(paths);
  const agentNotifier = notifier ?? createNotifier({ paths, baseUrl: `http://127.0.0.1:${port}/` });
  // 自動更新成功之後換成新版（2.0.0 R2）：等更新工作結束，再由 restartAndVerify（install/autoupdate.mjs）停掉舊的常駐程式（放掉連接埠與心跳、
  // 等執行中的工作做完）、啟動新版，並在時限內確認新版的心跳；起得來才通知「已自動更新」，起不來就退回、啟動舊版、通知。
  // 這個舊程序在確認完之前不結束：舊程式的程式碼已經載入記憶體，新版壞掉也照樣能退回；不能在更新流程裡直接結束自己（doctor 與通知還沒做完）
  const restartAgent = (handoff) => {
    const timer = setTimeout(() => {
      import('../../install/autoupdate.mjs').then(({ restartAndVerify }) => restartAndVerify({
        ...handoff,
        stopAgent: stop,
        spawnAgent: (bin) => spawnDetachedNode([bin, 'agent']),
        killProcess: (pid) => process.kill(pid),
        readHeartbeat: () => readHeartbeat(paths),
        notify: (n) => agentNotifier.notify(n),
        exit: (code) => process.exit(code),
        log: (msg) => log.warn('update', msg),
      })).catch((err) => log.error('agent', err));
    }, 3000);
    timer.unref?.();
  };
  const jobs = createJobs({
    eg, paths, events, log, runProbe, detectVersion, settings, restartAgent,
    notifier: agentNotifier,
  });
  const agent = { pid: process.pid, version: appVersion(), startedAt: new Date().toISOString(), port };
  const info = createAgentInfo({ agent, jobs, schedulerStatus });
  const api = createApi({ eg, jobs, paths, info, settings });
  const server = createAgentServer({ token, api, events, uiDir, log });

  try {
    await listen(server, port);
  } catch (err) {
    events.close();
    if (err.code !== 'EADDRINUSE') throw err;
    // 兩個常駐程式同時啟動：晚到的那個安靜退出
    await new Promise((r) => setTimeout(r, 1000));
    const winner = await otherAgent(paths);
    if (winner) return { alreadyRunning: winner };
    throw new CliError('E_PORT_IN_USE', `連接埠 ${port} 已被其他程式占用`, '關閉占用該連接埠的程式後再試；管理介面的網址固定，所以不能換連接埠。').withEn(`Port ${port} is already in use by another program`, 'Close the program that is using the port and try again. The dashboard address is fixed, so the port cannot be changed.');
  }
  agent.port = server.address().port;

  const beat = () => writeHeartbeat(paths, {
    pid: agent.pid,
    port: agent.port,
    token,
    startedAt: agent.startedAt,
    beatAt: new Date().toISOString(),
    version: agent.version,
    lastSyncAt: jobs.lastSyncAt(),
  }).catch((err) => log.warn('heartbeat', err));
  await beat();
  const beatTimer = setInterval(beat, HEARTBEAT_MS);
  const dailyTimer = setInterval(() => maintenance(paths, log), DAY);
  beatTimer.unref();
  dailyTimer.unref();
  maintenance(paths, log);
  // 1.4.0：回顧用的子代理要讀 local/dream。Claude Code 只在對話開始時套用 additionalDirectories，而且資料夾要已經存在，
  // 所以常駐程式一啟動（登入、engram update 之後）就建立資料夾並加進設定，之後開的對話第一次回顧就讀得到
  // 這兩項和啟動時的網路同步同時排隊，寫入鎖被占用（E_LOCKED）時等鎖再做，不直接記成失敗（S2）
  if (typeof eg.dream?.ensureReadable === 'function') jobs.retryLocked(() => eg.dream.ensureReadable()).catch((err) => log.warn('dream', err));
  // 確認紀錄的起點：升級後常駐程式一啟動就建立（不等每日健康檢查），之後 Claude 寫的內容才會列入「待你確認」
  if (typeof eg.review?.baseline === 'function') jobs.retryLocked(() => eg.review.baseline()).catch((err) => log.warn('review', err));
  jobs.start();
  // 2.0.0 S5：開場 hook 快速路徑用的快取最多用 15 分鐘；同步間隔可能比這長、同步也可能暫停，所以每 5 分鐘另外重寫一次
  // （存檔與同步之後由 jobs 寫；寫入時先記簽章再讀內容，和同步同時進行也不會留下錯的快取）
  const writeSessionCache = () => {
    if (typeof eg.sessionCache?.write === 'function') eg.sessionCache.write().catch((err) => log.warn('session-cache', err));
  };
  const sessionCacheTimer = setInterval(writeSessionCache, SESSION_CACHE_EVERY_MS);
  sessionCacheTimer.unref();
  writeSessionCache();
  const tidyWatcher = watchTidy(paths.local, events, log);
  log.info('agent', `已啟動：http://127.0.0.1:${agent.port}/（pid ${agent.pid}，Engram ${agent.version}）`);

  let stopping = null;
  function stop() {
    stopping ??= (async () => {
      clearInterval(beatTimer);
      clearInterval(dailyTimer);
      clearInterval(sessionCacheTimer);
      tidyWatcher.close();
      await jobs.stop();
      events.close();
      await new Promise((r) => server.close(() => r()));
      // 只刪自己的心跳檔
      if (readHeartbeat(paths)?.pid === agent.pid) await fsp.rm(paths.agentFile, { force: true }).catch(() => {});
      log.info('agent', '已停止');
    })();
    return stopping;
  }
  if (handleSignals) {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.once(sig, () => stop().finally(() => process.exit(0)));
  }
  return { server, port: agent.port, token, jobs, events, stop };
}
