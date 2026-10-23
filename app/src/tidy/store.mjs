// 整理記錄的存取：~/.engram/local/tidy/<id>.json（只屬於這台電腦、不同步）。
// 記錄是「Claude 的建議＋使用者的決定＋執行結果」，由 engram tidy create 建立、介面寫入決定、engram tidy apply 執行。
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CliError } from '../cli/errors.mjs';
import { readJson, withFileLock, writeJsonAtomic } from '../cli/fsutil.mjs';

export const RECORD_VERSION = 1;
export const ID_RE = /^\d{8}-\d{6}-[a-z0-9]{4}$/;

/** 決定：採用建議、維持原狀、封存、依備註調整（交給 Claude） */
export const DECISIONS = ['accept', 'keep', 'archive', 'custom'];
/** 狀態：待你決定 → 已產生執行指令 → 執行中 → Claude 處理備註項目中 → 已完成 */
export const STATUSES = ['pending', 'ready', 'applying', 'finishing', 'done'];
export const NOTE_MAX = 4000;
/** 執行中（applying）超過這麼久，視為上次執行中斷（程序被關掉，PID 也可能已被別的程式重用） */
export const STALE_APPLY_MS = 2 * 3600_000;
const LOCK_OPTS = { waitMs: 10_000, staleMs: 60_000 };

export const tidyDir = (localDir) => path.join(localDir, 'tidy');
const recordFile = (localDir, id) => path.join(tidyDir(localDir), `${id}.json`);
const lockFile = (localDir, id) => path.join(tidyDir(localDir), `${id}.lock`);

export function assertId(id) {
  if (!ID_RE.test(String(id ?? ''))) {
    throw new CliError('E_INVALID', `不是整理記錄的 id：${String(id ?? '').slice(0, 60)}`, 'id 的格式像 20261024-153012-k3p9；engram tidy list 可以列出所有記錄').withEn(`Not a tidy-up record id: ${String(id ?? '').slice(0, 60)}`, 'An id looks like 20261024-153012-k3p9. Run engram tidy list to see all records.');
  }
  return String(id);
}

const pad = (n) => String(n).padStart(2, '0');
export function newId(now = new Date()) {
  const d = now;
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const tail = [...randomBytes(4)].map((b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  return `${stamp}-${tail}`;
}

/** 讀取一份記錄；不存在時丟 E_NOT_FOUND */
export async function readRecord(localDir, id) {
  const rec = await readJson(recordFile(localDir, assertId(id)));
  if (!rec || rec.v !== RECORD_VERSION) {
    throw new CliError('E_NOT_FOUND', `找不到整理記錄：${id}`, '它可能已被刪除；engram tidy list 可以列出所有記錄').withEn(`Tidy-up record not found: ${id}`, 'It may have been deleted. Run engram tidy list to see all records.');
  }
  return rec;
}

export async function writeRecord(localDir, rec) {
  rec.updatedAt = new Date().toISOString();
  await writeJsonAtomic(recordFile(localDir, assertId(rec.id)), rec);
  return rec;
}

/** 讀取 → 修改 → 寫回，同一份記錄同時只有一個程序在改（介面自動儲存與 engram tidy 指令可能同時進行） */
export async function updateRecord(localDir, id, fn) {
  return withRecordLock(localDir, id, async () => {
    const rec = await readRecord(localDir, id);
    const out = await fn(rec);
    await writeRecord(localDir, rec);
    return out ?? rec;
  });
}

/** 同一份記錄的鎖；等太久時給看得懂的說明（介面切到英文時顯示英文） */
async function withRecordLock(localDir, id, fn) {
  try {
    return await withFileLock(lockFile(localDir, assertId(id)), fn, LOCK_OPTS);
  } catch (err) {
    if (err?.code !== 'E_LOCKED' || err instanceof CliError) throw err;
    throw new CliError('E_LOCKED', '這份整理記錄正在被另一個程序修改，稍後再試一次').withEn('Another process is updating this tidy-up record. Try again in a moment.');
  }
}

/** 真的還在執行中：狀態是 applying、執行它的程序還在，而且沒有超過 STALE_APPLY_MS */
export function applyingNow(rec, now = Date.now()) {
  if (rec.status !== 'applying') return false;
  if (now - Date.parse(rec.applyingSince ?? 0) > STALE_APPLY_MS) return false;
  const pid = rec.applyingPid;
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

export async function deleteRecord(localDir, id) {
  return withRecordLock(localDir, id, async () => {
    if (applyingNow(await readRecord(localDir, id))) throw busy();
    await fsp.rm(recordFile(localDir, id), { force: true });
    return { ok: true };
  });
}

export function busy() {
  return new CliError('E_LOCKED', '這份整理記錄正在執行中', '等 Claude 執行完再試；如果執行中斷了，重新執行 /engram:tidy-apply 會從中斷的地方繼續').withEn('This tidy-up record is being carried out', 'Wait for Claude to finish. If the run was interrupted, running /engram:tidy-apply again resumes where it stopped.');
}

/** 每一項目前的狀況（列表與 CLI 摘要用） */
export function counts(rec) {
  const c = { items: rec.items.length, suggested: 0, decided: 0, accept: 0, keep: 0, archive: 0, custom: 0, done: 0, kept: 0, failed: 0, skipped: 0, undone: 0, waiting: 0 };
  for (const it of rec.items) {
    if (it.action !== 'keep') c.suggested++;
    if (it.decision) { c.decided++; c[it.decision]++; }
    const r = it.result?.status;
    if (r === 'needs-claude') c.waiting++;
    else if (r && Object.hasOwn(c, r)) c[r]++;
  }
  return c;
}

/** 列表：新的在前；壞掉的檔案略過 */
export async function listRecords(localDir) {
  const dir = tidyDir(localDir);
  const names = (await fsp.readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json') && ID_RE.test(n.slice(0, -5)));
  const out = [];
  for (const n of names) {
    const rec = await readJson(path.join(dir, n));
    if (!rec || rec.v !== RECORD_VERSION || !Array.isArray(rec.items)) continue;
    out.push({ id: rec.id, createdAt: rec.createdAt, updatedAt: rec.updatedAt, appliedAt: rec.appliedAt ?? null, scope: rec.scope, request: rec.request ?? '', summary: rec.summary, status: rec.status, counts: counts(rec) });
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** 已完成或放著沒處理超過 days 天的記錄：刪除（常駐程式每日維護） */
export async function pruneRecords(localDir, { days = 90, now = Date.now() } = {}) {
  const cutoff = now - days * 864e5;
  let removed = 0;
  for (const r of await listRecords(localDir)) {
    // 90 天沒有任何更新：不論狀態（執行中斷、等 Claude 處理卻沒有下文）都清掉
    if (Date.parse(r.updatedAt ?? r.createdAt) < cutoff) {
      await fsp.rm(recordFile(localDir, r.id), { force: true }).catch(() => {});
      removed++;
    }
  }
  return removed;
}

/** 這個項目可以選哪些決定：建議保留的不需要「採用」；新增類（沒有對象記憶）不能封存 */
export function allowedDecisions(item) {
  const list = item.action === 'keep' ? ['keep', 'archive', 'custom'] : ['accept', 'keep', 'archive', 'custom'];
  return item.ref && item.ref !== 'core/CORE.md' ? list : list.filter((d) => d !== 'archive');
}

/**
 * 介面寫入決定與備註。changes：{ [項目 id]: { decision?, note? } }；decision 給 null 表示清除。
 * 執行中或已執行完的記錄不能再改。
 */
export async function setDecisions(localDir, id, changes) {
  if (!changes || typeof changes !== 'object') throw new CliError('E_INVALID', '缺少要儲存的決定').withEn('Missing the decisions to save');
  return updateRecord(localDir, id, (rec) => {
    if (!['pending', 'ready'].includes(rec.status)) throw locked(rec);
    const byId = new Map(rec.items.map((it) => [it.id, it]));
    for (const [itemId, ch] of Object.entries(changes)) {
      const it = byId.get(itemId);
      if (!it) throw new CliError('E_NOT_FOUND', `找不到項目：${itemId}`).withEn(`Item not found: ${itemId}`);
      if (ch?.decision !== undefined) {
        if (ch.decision !== null && !allowedDecisions(it).includes(ch.decision)) throw new CliError('E_INVALID', `項目 ${itemId} 不能選「${ch.decision}」`).withEn(`Item ${itemId} cannot be set to "${ch.decision}"`);
        it.decision = ch.decision;
      }
      if (ch?.note !== undefined) {
        const note = String(ch.note ?? '');
        if (note.length > NOTE_MAX) throw new CliError('E_INVALID', `備註太長（上限 ${NOTE_MAX} 字）`).withEn(`The note is too long (limit ${NOTE_MAX} characters)`);
        it.note = note;
      }
    }
    // 已產生執行指令之後又改成「未決定」或「依備註調整」卻沒有備註：退回待決定，要重新產生執行指令
    if (rec.status === 'ready' && rec.items.some((it) => !it.decision || (it.decision === 'custom' && !String(it.note ?? '').trim()))) {
      rec.status = 'pending';
      delete rec.readyAt;
    }
  });
}

function locked(rec) {
  return rec.status === 'applying'
    ? busy()
    : new CliError('E_INVALID', '這份整理記錄已經執行過，不能再修改決定', '要重新整理時，回到「記憶整理」開始新的一次').withEn('This tidy-up record has already been carried out, so its decisions can no longer change', 'To tidy up again, start a new one from Tidy-up.');
}

/**
 * 「產生執行指令」：沒有決定的項目一律當成維持原狀；「依備註調整」一定要有備註。
 * 回傳要貼給 Claude 的指令。
 */
export async function markReady(localDir, id) {
  return updateRecord(localDir, id, (rec) => {
    if (!['pending', 'ready'].includes(rec.status)) throw locked(rec);
    const missing = rec.items.filter((it) => it.decision === 'custom' && !String(it.note ?? '').trim());
    if (missing.length) {
      throw new CliError('E_INVALID', `「依備註調整」的項目要寫備註：${missing.map((it) => it.name).join('、')}`, '寫下要 Claude 怎麼調整，或改選其他處理方式')
        .withEn(`Items set to "Adjust per note" need a note: ${missing.map((it) => it.name).join(', ')}`, 'Write how Claude should adjust them, or pick another option.');
    }
    for (const it of rec.items) if (!it.decision) it.decision = 'keep';
    rec.status = 'ready';
    rec.readyAt = new Date().toISOString();
    return { ok: true, command: `/engram:tidy-apply ${rec.id}`, counts: counts(rec) };
  });
}
