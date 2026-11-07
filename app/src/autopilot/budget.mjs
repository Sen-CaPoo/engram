// 自動駕駛的用量帳本（1.5.0）：local/autopilot/usage-YYYY-MM.json（只屬於這台電腦）。
// 金額是 claude -p 回報的 API 牌價（total_cost_usd）：用訂閱登入時不另外計費，但代表訂閱額度的消耗，拿來當上限的尺度。
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../cli/fsutil.mjs';

export const DEFAULT_MONTHLY_USD = 30;
export const RUN_USD = 5;

const pad = (n) => String(n).padStart(2, '0');
export const monthKey = (now = Date.now()) => { const d = new Date(now); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const ledgerFile = (local, month) => path.join(local, 'autopilot', `usage-${month}.json`);

export async function readLedger(local, now = Date.now()) {
  const month = monthKey(now);
  const j = await readJson(ledgerFile(local, month), null);
  return { month, costUsd: Number(j?.costUsd) || 0, input: Number(j?.input) || 0, output: Number(j?.output) || 0, calls: Number(j?.calls) || 0, byModel: j?.byModel ?? {} };
}

/** 記一筆用量（同一台電腦同時只有一輪在跑，所以不必鎖） */
export async function charge(local, model, usage, now = Date.now()) {
  const l = await readLedger(local, now);
  const m = l.byModel[model] ?? { costUsd: 0, input: 0, output: 0, calls: 0 };
  for (const o of [l, m]) {
    o.costUsd = Math.round((o.costUsd + (usage?.costUsd ?? 0)) * 1e6) / 1e6;
    o.input += usage?.input ?? 0;
    o.output += usage?.output ?? 0;
    o.calls += 1;
  }
  l.byModel[model] = m;
  await writeJsonAtomic(ledgerFile(local, l.month), { ...l, updatedAt: new Date(now).toISOString() });
  return l;
}

/**
 * 一輪的預算：每月上限扣掉已用的，再以每輪上限封頂。
 * @returns {{ monthly, used, remaining, run }}
 */
export async function runBudget(local, monthlyUsd = DEFAULT_MONTHLY_USD, now = Date.now()) {
  const l = await readLedger(local, now);
  const remaining = Math.max(0, monthlyUsd - l.costUsd);
  return { monthly: monthlyUsd, used: l.costUsd, remaining, run: Math.min(RUN_USD, remaining) };
}
