// 給管理介面的整理記錄：附上每一項「建議之後記憶有沒有被改過」，執行前就先提醒使用者。
import { revOf } from '../cli/commands/safe.mjs';
import { CORE_REF } from './plan.mjs';
import { counts, listRecords, readRecord } from './store.mjs';

/** 目前的版本；不存在時 null */
async function revNow(eg, ref) {
  if (ref === CORE_REF) return revOf((await eg.core.read()).text ?? '');
  try { return revOf((await eg.memories.read(ref)).raw); } catch (err) {
    if (err?.code === 'E_NOT_FOUND') return null;
    throw err;
  }
}

export async function recordView(eg, id) {
  const rec = await readRecord(eg.paths.local, id);
  const cache = new Map();
  const rev = async (ref) => {
    if (!cache.has(ref)) cache.set(ref, await revNow(eg, ref));
    return cache.get(ref);
  };
  for (const it of rec.items) {
    it.changed = [];
    if (it.result || it.progress) continue; // 已經執行過（或執行到一半）：結果才是重點，版本會因為自己的修改而不同
    const checks = it.ref ? [[it.ref, it.base]] : [];
    for (const o of it.ops) {
      if (o.op === 'merge') o.refs.forEach((r, k) => { if (o.bases?.[k]) checks.push([r, o.bases[k]]); });
      else if (o.base) checks.push([o.ref, o.base]);
    }
    for (const [ref, base] of checks) if (base && (await rev(ref)) !== base && !it.changed.includes(ref)) it.changed.push(ref);
  }
  const command = ['ready', 'applying', 'finishing'].includes(rec.status) ? `/engram:tidy-apply ${rec.id}` : null;
  return { ...rec, counts: counts(rec), command };
}

/** 介面導覽列的徽章：待你決定、等執行、等 Claude 處理的份數 */
export async function tidySummary(localDir) {
  const list = await listRecords(localDir);
  const n = (s) => list.filter((r) => r.status === s).length;
  return { pending: n('pending'), ready: n('ready'), finishing: n('finishing'), total: list.length };
}
