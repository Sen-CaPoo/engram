// 已退役的綁定（1.4.1）：H04「移除舊綁定」只刪 bindings.json 裡的紀錄，但舊資料夾在 ~/.claude/projects/<編碼>/ 的對話紀錄
// 還在（Claude Code 保留約 30 天）。對話回顧（/engram:dream、H20）原本只靠目前的綁定找對話，移除後就再也回顧不到。
// 這裡記下每個被移除的綁定屬於哪個專案、何時移除；對話回顧把「移除之前」寫入的對話一併算進那個專案。
// 對話紀錄本來就只在這台電腦，所以這份紀錄放 local/（不進 vault、不同步）。
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './fsx.mjs';

const fileOf = (local) => path.join(local, 'retired-bindings.json');
// 移除當下可能還有幾秒的寫入（例如移除前最後一次存檔）：容許一分鐘
const GRACE_MS = 60_000;

/** @returns {Promise<{ key: string, pid: string, encoded: string, path: string|null, retiredAt: string }[]>} */
export async function readRetired(local) {
  const j = await readJson(fileOf(local), null);
  const list = Array.isArray(j?.bindings) ? j.bindings : [];
  return list.filter((b) => b && typeof b.pid === 'string' && b.pid && typeof b.encoded === 'string' && b.encoded && Number.isFinite(Date.parse(b.retiredAt)));
}

/**
 * 記下一個被移除的綁定。同一個 key 再移除一次時以最新的為準。
 * claudeHome 有給時，順便清掉舊資料夾已經沒有任何對話紀錄的項目（Claude Code 清理過了，留著也沒用）。
 */
export async function retireBinding(local, { key, pid, encoded, path: p = null }, { now = Date.now(), claudeHome } = {}) {
  if (typeof pid !== 'string' || !pid || typeof encoded !== 'string' || !encoded) return null;
  const entry = { key: key ?? encoded, pid, encoded, path: p ?? null, retiredAt: new Date(now).toISOString() };
  const keep = (await readRetired(local)).filter((b) => b.key !== entry.key && (!claudeHome || hasTranscripts(claudeHome, b.encoded)));
  await writeJson(fileOf(local), { v: 1, bindings: [...keep, entry] });
  return entry;
}

function hasTranscripts(claudeHome, encoded) {
  try { return fs.readdirSync(path.join(claudeHome, 'projects', encoded)).some((n) => n.endsWith('.jsonl')); } catch { return false; }
}

/**
 * 某個專案的退役編碼資料夾 → 移除時間（毫秒）。同一個編碼被移除過好幾次時取最晚的一次。
 * @returns {Promise<Map<string, number>>} 小寫編碼 → retiredAt
 */
export async function retiredEncodedFor(local, pid) {
  const map = new Map();
  for (const b of await readRetired(local)) {
    if (b.pid !== pid) continue;
    const k = b.encoded.toLowerCase();
    map.set(k, Math.max(map.get(k) ?? 0, Date.parse(b.retiredAt)));
  }
  return map;
}

/**
 * 別的專案退役的編碼資料夾 → 移除時間。同一個編碼之後又綁定給這個專案時，
 * 移除之前的對話屬於原本那個專案，不要兩邊都算（1.4.1 審查）。
 * @returns {Promise<Map<string, number>>}
 */
export async function retiredByOthers(local, pid) {
  const map = new Map();
  for (const b of await readRetired(local)) {
    if (b.pid === pid) continue;
    const k = b.encoded.toLowerCase();
    map.set(k, Math.max(map.get(k) ?? 0, Date.parse(b.retiredAt)));
  }
  return map;
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

/** 對話是不是在綁定移除之前寫的（之後才出現的對話不屬於已經不存在的舊資料夾） */
export const beforeRetired = (t, retiredAtMs) => Number.isFinite(t?.mtimeMs) && t.mtimeMs <= retiredAtMs + GRACE_MS;
