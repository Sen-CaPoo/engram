// 讀 Claude Code 的 ~/.claude/projects/<編碼>/：transcript 的 cwd 與 sessionId、記憶資料夾狀態。
// 只讀，不寫。用 transcript 第一行附近的 cwd 判斷來源，不反推編碼名稱。
// 注意（E24／F36）：從 git 子資料夾啟動時，transcript 放在「子資料夾的編碼」，記憶用的卻是「repo 根目錄的編碼」。
// 所以「使用某個記憶資料夾的 session」（users）要跨資料夾收集：子資料夾的編碼一定以「根目錄編碼-」開頭，再用 cwd 確認。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isLink, linkTarget } from './fsx.mjs';
import { encodeProjectPath, memoryRootFor, normalizeFsPath } from './paths.mjs';

const HEAD_BYTES = 64 * 1024;

/** 讀 jsonl 開頭，找出 cwd 與 sessionId（不解析整檔）。 */
export function readTranscriptHead(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const text = buf.subarray(0, n).toString('utf8');
    let cwd = null;
    let sessionId = null;
    for (const line of text.split('\n').slice(0, 80)) {
      if (!line.includes('"cwd"') && !line.includes('"sessionId"')) continue;
      try {
        const obj = JSON.parse(line);
        cwd ??= typeof obj.cwd === 'string' ? obj.cwd : null;
        sessionId ??= typeof obj.sessionId === 'string' ? obj.sessionId : null;
        if (cwd && sessionId) break;
      } catch { /* 被截斷的最後一行 */ }
    }
    return { cwd, sessionId: sessionId ?? path.basename(file, '.jsonl') };
  } catch {
    return { cwd: null, sessionId: path.basename(file, '.jsonl') };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** 只讀這個編碼資料夾本身：transcript（附上它實際使用的記憶編碼 memEnc）與記憶資料夾狀態。 */
async function scanOwn(claudeHome, encoded) {
  const dir = path.join(claudeHome, 'projects', encoded);
  const sessions = [];
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { /* 不存在 */ }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const file = path.join(dir, e.name);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
    const head = readTranscriptHead(file);
    // 路徑超過 200 字元時官方會加 hash，算不出來（null）：只能當作用的是自己這個資料夾
    const memEnc = head.cwd ? encodeProjectPath(memoryRootFor(head.cwd).root) : null;
    sessions.push({ ...head, mtimeMs, memEnc });
  }
  const memPath = path.join(dir, 'memory');
  const junction = isLink(memPath);
  let files = [];
  try {
    files = (await fsp.readdir(memPath, { withFileTypes: true }))
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.md'))
      .map((d) => d.name).sort();
  } catch { /* 沒有記憶資料夾 */ }
  return { encoded, dir, sessions, memory: { path: memPath, exists: junction || fs.existsSync(memPath), isJunction: junction, target: junction ? linkTarget(memPath) : null, files } };
}

const sameEnc = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
/** 這個 session 用的是不是 encoded 的記憶資料夾（看不出來時，當作用的是它自己所在的資料夾）。 */
const usesOwn = (s, encoded) => !s.cwd || !s.memEnc || sameEnc(s.memEnc, encoded);

/** roots：使用這個記憶資料夾的 session 的專案根目錄；lastActivityMs 也以這些 session 為準。 */
function finish(own, users) {
  const rootSet = new Map();
  for (const s of users) {
    if (!s.cwd) continue;
    const { root } = memoryRootFor(s.cwd);
    rootSet.set(root.toLowerCase(), root);
  }
  return { ...own, users, roots: [...rootSet.values()], lastActivityMs: users.reduce((m, s) => Math.max(m, s.mtimeMs), 0) };
}

async function projectDirNames(claudeHome) {
  try {
    return (await fsp.readdir(path.join(claudeHome, 'projects'), { withFileTypes: true }))
      .filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name);
  } catch { return []; }
}

/**
 * 掃描一個編碼資料夾。sessions 是這個資料夾裡的 transcript；users 是「使用這個記憶資料夾」的 session，
 * 包含從 git 子資料夾啟動、transcript 放在別的編碼資料夾的那些（E24）。roots、lastActivityMs 以 users 為準。
 * @returns {Promise<{ encoded, dir, sessions: object[], users: object[], roots: string[], lastActivityMs, memory: { path, exists, isJunction, target, files: string[] } }>}
 */
export async function scanEncodedDir(claudeHome, encoded) {
  const own = await scanOwn(claudeHome, encoded);
  const users = own.sessions.filter((s) => usesOwn(s, encoded));
  const prefix = `${encoded.toLowerCase()}-`;
  for (const n of await projectDirNames(claudeHome)) {
    if (!n.toLowerCase().startsWith(prefix)) continue;
    const sub = await scanOwn(claudeHome, n);
    users.push(...sub.sessions.filter((s) => sameEnc(s.memEnc, encoded)));
  }
  return finish(own, users);
}

/** 掃描所有編碼資料夾（每個資料夾只讀一次，再把 session 歸到它實際使用的記憶資料夾）。 */
export async function scanAll(claudeHome) {
  const owns = [];
  for (const n of await projectDirNames(claudeHome)) owns.push(await scanOwn(claudeHome, n));
  const users = new Map(owns.map((o) => [o.encoded.toLowerCase(), []]));
  for (const o of owns) {
    for (const s of o.sessions) {
      if (usesOwn(s, o.encoded)) users.get(o.encoded.toLowerCase()).push(s);
      else users.get(s.memEnc.toLowerCase())?.push(s); // 記憶資料夾還不存在時不歸給任何人
    }
  }
  return owns.map((o) => finish(o, users.get(o.encoded.toLowerCase())));
}

/** 建立 sessionId → cwd 對照（用於 originSessionId 精確歸屬）。 */
export function sessionIndex(scans) {
  const map = new Map();
  for (const s of scans) for (const t of s.sessions) if (t.sessionId && t.cwd) map.set(t.sessionId, normalizeFsPath(t.cwd));
  return map;
}

/** 是否有進行中的對話正在使用這個記憶資料夾（transcript 在 windowMs 內更新過，含從子資料夾啟動的）。 */
export function hasActiveSession(scan, windowMs = 30 * 60_000, now = Date.now()) {
  return (scan.users ?? scan.sessions).some((s) => now - s.mtimeMs < windowMs);
}
