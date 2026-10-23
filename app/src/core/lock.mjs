// 寫入鎖：同一台電腦上同時只有一個寫入者（hooks、常駐程式、介面、CLI 共用）。
// - 跨程序：鎖檔以獨占建立（wx），內容含 nonce、pid、startedAt、heartbeatAt；持有期間每 30 秒更新心跳。
// - 過期接手：持有程序已不存在，或心跳超過 staleMs（避免 PID 重用誤判）。接手時先把舊鎖檔 rename 到唯一名稱
//   （只有一個程序會成功），確認拿到的正是剛才判定過期的那一份，再參與 wx 競爭（M1）。
// - 釋放：只刪除 nonce 相符的鎖檔，不會刪到別人的（M2）。
// - 同一程序內：以 AsyncLocalStorage 判斷「同一條呼叫鏈」才可重入；並行的其他作業依序排隊（M3）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { E, EngramError } from './errors.mjs';
import { randomBase32 } from './ids.mjs';

const STALE_MS = 2 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const als = new AsyncLocalStorage();
const queues = new Map(); // lockPath → 程序內排隊的 Promise 尾端

function processAlive(pid) {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function readInfo(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function isStale(info, ageMs, staleMs) {
  if (!info) return ageMs > 5_000; // 寫到一半或損毀：給 5 秒寬限
  const beat = Date.parse(info.heartbeatAt ?? info.startedAt ?? 0) || 0;
  if (!processAlive(info.pid)) return true;
  return Date.now() - beat > staleMs; // 程序還在但心跳停了（卡死或 PID 被重用）
}

function readRaw(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/**
 * 接手過期鎖（M1）：先以 wx 取得短暫的「接手權」（lock.takeover），只有拿到的程序可以刪鎖；
 * 刪之前在接手權內重讀鎖檔，內容必須和剛才判定過期的那一份逐字相同、而且仍然過期。
 * 新建立的鎖心跳新鮮、持有者存活，永遠不會被判過期，所以不會被誤刪。
 */
function tryTakeOver(lockPath, staleRaw, staleMs) {
  const t = `${lockPath}.takeover`;
  try {
    const fd = fs.openSync(t, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (err) {
    if (err.code === 'EEXIST') {
      // 接手者自己當掉時留下的接手權：超過 10 秒就清掉
      try { if (Date.now() - fs.statSync(t).mtimeMs > 10_000) fs.rmSync(t, { force: true }); } catch { /* ignore */ }
    }
    return;
  }
  try {
    const raw = readRaw(lockPath);
    if (raw !== null && raw === staleRaw) {
      let age = 0;
      try { age = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { return; }
      let info = null;
      try { info = JSON.parse(raw); } catch { /* 損毀 */ }
      if (isStale(info, age, staleMs)) fs.rmSync(lockPath, { force: true });
    }
  } finally {
    try { fs.rmSync(t, { force: true }); } catch { /* ignore */ }
  }
}

async function acquireFile(lockPath, { op, waitMs, staleMs }) {
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  const nonce = randomBase32(12);
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      const now = new Date().toISOString();
      fs.writeSync(fd, JSON.stringify({ nonce, pid: process.pid, op, startedAt: now, heartbeatAt: now }));
      fs.closeSync(fd);
      return nonce;
    } catch (err) {
      if (!['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      if (err.code === 'EEXIST') {
        const raw = readRaw(lockPath);
        let info = null;
        try { info = raw ? JSON.parse(raw) : null; } catch { /* 寫到一半或損毀 */ }
        let age = 0;
        try { age = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { continue; }
        if (raw !== null && isStale(info, age, staleMs)) {
          tryTakeOver(lockPath, raw, staleMs);
          await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20)));
          continue;
        }
        if (Date.now() >= deadline) throw new EngramError(E.LOCKED, 'Engram 正在進行另一項操作', '稍後再試一次', { holder: info ? { pid: info.pid, op: info.op, startedAt: info.startedAt } : null }).withEn('Engram is busy with another operation', 'Try again in a moment');
      } else if (Date.now() >= deadline) {
        throw new EngramError(E.LOCKED, '無法建立鎖檔', '稍後再試一次', { code: err.code }).withEn('Could not create the lock file', 'Try again in a moment');
      }
      await new Promise((r) => setTimeout(r, Math.min(80 + attempt * 40, 400)));
    }
  }
}

function startHeartbeat(lockPath, nonce) {
  const t = setInterval(() => {
    const info = readInfo(lockPath);
    if (info?.nonce !== nonce) return;
    try { fs.writeFileSync(lockPath, JSON.stringify({ ...info, heartbeatAt: new Date().toISOString() })); } catch { /* 下次再試 */ }
  }, HEARTBEAT_MS);
  t.unref?.();
  return t;
}

function releaseFile(lockPath, nonce) {
  const info = readInfo(lockPath);
  if (info?.nonce === nonce) { try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ } }
}

/**
 * 在鎖內執行 fn。同一條呼叫鏈可重入；同一程序內的並行作業依序排隊；跨程序以鎖檔互斥。
 * @template T
 * @param {string} lockPath
 * @param {string} op
 * @param {() => Promise<T>} fn
 * @param {{ waitMs?: number, staleMs?: number }} [opts]
 * @returns {Promise<T>}
 */
export async function withLock(lockPath, op, fn, { waitMs = 15_000, staleMs = STALE_MS } = {}) {
  const held = als.getStore();
  if (held?.has(lockPath)) return fn(); // 同一條呼叫鏈：重入

  // 程序內排隊
  const prev = queues.get(lockPath) ?? Promise.resolve();
  let releaseQueue;
  const mine = new Promise((r) => { releaseQueue = r; });
  const tail = prev.then(() => mine);
  queues.set(lockPath, tail);
  const deadline = Date.now() + waitMs;
  try {
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new EngramError(E.LOCKED, 'Engram 正在進行另一項操作', '稍後再試一次').withEn('Engram is busy with another operation', 'Try again in a moment')), waitMs); });
    try { await Promise.race([prev, timeout]); } finally { clearTimeout(timer); }
    const nonce = await acquireFile(lockPath, { op, waitMs: Math.max(0, deadline - Date.now()), staleMs });
    const hb = startHeartbeat(lockPath, nonce);
    try {
      return await als.run(new Set([...(held ?? []), lockPath]), fn);
    } finally {
      clearInterval(hb);
      releaseFile(lockPath, nonce);
    }
  } finally {
    releaseQueue();
    if (queues.get(lockPath) === tail) queues.delete(lockPath);
  }
}

/**
 * 相容舊介面：取得鎖並回傳 release。只給測試使用；引擎內一律用 withLock。
 */
export async function acquireLock(lockPath, { op = 'write', waitMs = 15_000, staleMs = STALE_MS } = {}) {
  let release;
  const acquired = new Promise((res, rej) => {
    withLock(lockPath, op, () => new Promise((done) => { release = async () => done(); res(); }), { waitMs, staleMs }).catch(rej);
  });
  await acquired;
  return release;
}
