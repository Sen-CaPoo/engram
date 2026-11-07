// 已退役的綁定（1.4.1）：H04「移除舊綁定」只刪 bindings.json 裡的紀錄，但舊資料夾在 ~/.claude/projects/<編碼>/ 的對話紀錄
// 還在（Claude Code 保留約 30 天）。對話回顧（/engram:dream、H20）原本只靠目前的綁定找對話，移除後就再也回顧不到。
// 這裡記下每個被移除的綁定屬於哪個專案、何時移除；對話回顧把「移除之前」寫入的對話一併算進那個專案。
// 移除綁定時，舊位置指向這個專案的記憶連結（junction）也會一起拆掉（見 core/index.mjs 的 forget-binding）。
// 對話紀錄本來就只在這台電腦，所以這份紀錄放 local/（不進 vault、不同步）。
//
// 同一個編碼資料夾可能先後屬於不同專案（路徑重用），也可能同時屬於好幾個專案（撞名）。對話歸屬用時間區間判斷：
// - 退役的綁定：從「別的專案在它綁定之前最後一次退役」到「它自己退役」之間寫的對話
// - 目前的綁定：「別的專案在它綁定之前最後一次退役」之後寫的對話
// 撞名並存（彼此綁定時對方都還在）時沒有這種退役，兩邊都算全部；不知道綁定時間時退回用退役時間判斷。
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './fsx.mjs';

const fileOf = (local) => path.join(local, 'retired-bindings.json');
// 移除當下可能還有幾秒的寫入（例如移除前最後一次存檔）：容許一分鐘
const GRACE_MS = 60_000;

/** @returns {Promise<{ key: string, pid: string, encoded: string, path: string|null, boundAt?: string|null, retiredAt: string }[]>} */
export async function readRetired(local) {
  const j = await readJson(fileOf(local), null);
  const list = Array.isArray(j?.bindings) ? j.bindings : [];
  return list.filter((b) => b && typeof b.pid === 'string' && b.pid && typeof b.encoded === 'string' && b.encoded && Number.isFinite(Date.parse(b.retiredAt)));
}

/**
 * 記下一個被移除的綁定（boundAt：那筆綁定的綁定時間）。同一筆綁定（key、專案、綁定時間都相同）再移除一次時以最新的為準；
 * 同一個 key 換過專案、或同一個專案移除後又綁回來的，各自保存（區間不同）。
 * claudeHome 有給時，順便清掉舊資料夾已經沒有任何對話紀錄的項目（Claude Code 清理過了，留著也沒用）。
 */
export async function retireBinding(local, { key, pid, encoded, path: p = null, boundAt = null }, { now = Date.now(), claudeHome } = {}) {
  if (typeof pid !== 'string' || !pid || typeof encoded !== 'string' || !encoded) return null;
  const bound = Number.isFinite(Date.parse(boundAt ?? '')) ? boundAt : null;
  const entry = { key: key ?? encoded, pid, encoded, path: p ?? null, boundAt: bound, retiredAt: new Date(now).toISOString() };
  const same = (b) => b.key === entry.key && b.pid === entry.pid && (b.boundAt ?? null) === entry.boundAt;
  const keep = (await readRetired(local)).filter((b) => !same(b) && (!claudeHome || hasTranscripts(claudeHome, b.encoded)));
  await writeJson(fileOf(local), { v: 1, bindings: [...keep, entry] });
  return entry;
}

/** 舊資料夾（含從 git 子資料夾啟動、編碼加了後綴的資料夾）還有沒有對話紀錄；判斷不了時當作有，寧可多留 */
function hasTranscripts(claudeHome, encoded) {
  const dir = path.join(claudeHome, 'projects');
  const has = (name) => { try { return fs.readdirSync(path.join(dir, name)).some((n) => n.endsWith('.jsonl')); } catch { return false; } };
  if (has(encoded)) return true;
  try {
    const prefix = `${encoded.toLowerCase()}-`;
    return fs.readdirSync(dir).some((n) => n.toLowerCase().startsWith(prefix) && has(n));
  } catch { return true; }
}

/** 專案合併（projects.link）：退役紀錄跟著改到合併後的專案，舊對話才不會變成沒有專案認領 */
export async function relinkRetired(local, fromPid, toPid) {
  const list = await readRetired(local);
  if (!list.some((b) => b.pid === fromPid)) return 0;
  let n = 0;
  const next = list.map((b) => (b.pid === fromPid ? (n++, { ...b, pid: toPid }) : b));
  await writeJson(fileOf(local), { v: 1, bindings: next });
  return n;
}

/**
 * 這個專案在某個編碼資料夾裡擁有的對話時間區間（毫秒，左開右閉）。
 * @param {object[]} retired  readRetired 的結果
 * @param {number|undefined} liveBoundAt  這個專案目前在這個編碼有綁定時，綁定的時間（不知道時給 -Infinity）；沒有綁定時給 undefined
 * @returns {[number, number][]}
 */
export function sessionWindows(retired, pid, encoded, liveBoundAt) {
  const k = String(encoded).toLowerCase();
  const rows = retired.filter((b) => b.encoded.toLowerCase() === k).map((b) => {
    const bound = Date.parse(b.boundAt ?? '');
    return { pid: b.pid, at: Date.parse(b.retiredAt), bound: Number.isFinite(bound) ? bound : null };
  });
  // 在 t 之前，別的專案最後一次退役的時間（那之前寫的對話屬於它）
  const othersBefore = (t) => rows.reduce((m, r) => (r.pid !== pid && r.at < t && r.at > m ? r.at : m), -Infinity);
  const from = (lo) => (lo === -Infinity ? -Infinity : lo + GRACE_MS);
  // 退役的綁定以它的綁定時間判斷：撞名並存時對方退役在它綁定之後，不會切掉它的區間
  const wins = rows.filter((r) => r.pid === pid).map((r) => [from(othersBefore(r.bound ?? r.at)), r.at + GRACE_MS]);
  if (liveBoundAt !== undefined) wins.push([from(othersBefore(liveBoundAt)), Infinity]);
  return wins;
}

export const inWindows = (t, wins) => Number.isFinite(t?.mtimeMs) && wins.some(([lo, hi]) => t.mtimeMs > lo && t.mtimeMs <= hi);
