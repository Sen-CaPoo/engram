// 匯入精靈的後端：計畫、沙盒演練、套用、還原。常駐程式的 /api/import/* 與 CLI 的 engram import 都呼叫這裡。
// 安全原則（22 號文件）：
//   1. 一律先產生計畫，使用者調整後才套用。
//   2. 套用前可以先在沙盒演練，演練不碰真實的 ~/.claude 與 vault。
//   3. 套用只「複製」進 vault 並綁定；原始記憶檔保留不刪，直到使用者在驗證後自己決定。
//   4. 每次套用都有還原點與紀錄，「還原」會解除綁定並 revert 匯入產生的 commit（歷史只增不改）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { setTempDir } from '../core/fsx.mjs';
import { applyEdits, holdChanged, itemKey, publicPlan, sanitizeEdits } from './plan.mjs';
import { rehearse } from './rehearse.mjs';

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
const recordDir = (eg) => path.join(eg.paths.local, 'import');

async function readRecords(eg) {
  const dir = recordDir(eg);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of (await fsp.readdir(dir)).filter((n) => n.endsWith('.json') && !n.startsWith('rehearsal-'))) {
    try { out.push(JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'))); } catch { /* 損毀的紀錄略過 */ }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

async function writeRecord(eg, rec) {
  await fsp.mkdir(recordDir(eg), { recursive: true });
  const file = path.join(recordDir(eg), `${rec.tag}.json`);
  await fsp.writeFile(`${file}.tmp`, JSON.stringify(rec, null, 2));
  await fsp.rename(`${file}.tmp`, file);
}

/** 產生計畫（含最近一次匯入的狀態，讓精靈知道能不能還原）。 */
export async function planImport(eg) {
  const plan = publicPlan(await eg.sweepLegacy({ dryRun: true }));
  const last = (await readRecords(eg)).find((r) => !r.undoneAt);
  const budget = eg.indexBudget ? await eg.indexBudget() : null;
  return {
    ...plan, budget, applied: !!last, tag: last?.tag ?? null,
    lastImport: last ? { tag: last.tag, at: last.at, copied: last.copied, bound: last.bound.length, backupOnly: last.backupOnly?.length ?? 0, failed: last.failed ?? null } : null,
  };
}

/** 沙盒演練：用真實資料的複本完整跑一次匯入、驗證與還原。 */
export async function rehearseImport(eg, { edits } = {}) {
  const engine = await import('../core/index.mjs');
  const sandbox = path.join(eg.paths.local, 'tmp', `rehearsal-${stamp()}`);
  await fsp.mkdir(sandbox, { recursive: true });
  try {
    const { readSweepLog } = await import('../core/sweep.mjs');
    const { _imports, ...swept } = await readSweepLog(eg.paths.local);
    const report = await rehearse({ engine, realClaude: eg.paths.claudeHome, sandbox, machineLabel: `${eg.machine.label}（演練）`, edits: sanitizeEdits(edits), swept });
    const summary = {
      ok: report.ok, ms: report.ms, at: report.finishedAt,
      totals: report.plan.totals, accounting: report.accounting, restore: report.restore,
      realUntouched: { ok: report.realUntouched.ok, changed: report.realUntouched.changed.length },
      selfTest: report.selfTest,
      health: report.health, steps: report.steps.map(({ name, ms }) => ({ name, ms })),
    };
    await fsp.mkdir(recordDir(eg), { recursive: true });
    await fsp.writeFile(path.join(recordDir(eg), `rehearsal-${stamp()}.json`), JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    // 演練裡開啟的沙盒引擎把暫存檔位置設到了沙盒；改回這台電腦的，否則之後的寫入會重建已刪除的沙盒資料夾
    setTempDir(path.join(eg.paths.local, 'tmp'));
    await fsp.rm(sandbox, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

/**
 * 匯入時使用者親自改過範圍的記憶，不要馬上又出現「改回去」的卡片（H08 建議改單機、H09 建議升級全域）。
 * 用收件匣原本的「忽略」：doctor 照常列出，使用者也能在收件匣恢復。
 */
async function dismissDecided(eg, plan, edits) {
  const decided = new Set();
  for (const s of plan.sources) {
    for (const it of s.items) if (edits.items[itemKey(s.encoded, it.file)]?.scope && it.action === 'copy') decided.add(`${it.scope}|${it.file.toLowerCase()}`);
  }
  if (!decided.size || typeof eg.health !== 'function' || !eg.findings?.dismiss) return 0;
  let n = 0;
  for (const f of await eg.health()) {
    if (!['H08', 'H09'].includes(f.code) || f.refs?.length !== 1) continue;
    const ref = f.refs[0];
    const scope = ref.startsWith('global/') ? 'global' : ref.startsWith('projects/') ? 'project' : null;
    if (!decided.has(`${scope}|${path.posix.basename(ref).toLowerCase()}`)) continue;
    await eg.findings.dismiss(f.id);
    n++;
  }
  return n;
}

/** 套用：建立還原點 → 依調整後的計畫收編並綁定 → 留下紀錄。 */
export async function applyImport(eg, { edits } = {}) {
  const clean = sanitizeEdits(edits);
  const raw = await eg.sweepLegacy({ dryRun: true });
  const { plan, held } = holdChanged(raw, applyEdits(raw, clean), clean.revs);
  if (!plan.sources.length && held.length) {
    return { ok: true, tag: null, restorePoint: null, copied: 0, skipped: 0, bound: 0, archived: 0, backupOnly: 0, deferred: held };
  }
  // 匯入紀錄的名稱必須唯一（同一秒內的兩次套用不可互相覆寫紀錄）
  let tag = `engram-import-${stamp()}`;
  for (let i = 2; fs.existsSync(path.join(recordDir(eg), `${tag}.json`)); i++) tag = `engram-import-${stamp()}-${i}`;
  const before = (await eg.history({ limit: 1 }))[0]?.sha ?? null;
  const startedAt = new Date().toISOString();
  let result;
  try {
    result = await eg.sweepLegacy({ dryRun: false, plan, bindSources: true });
  } catch (err) {
    // 中途失敗：引擎已撤銷失敗那一步未提交的寫入，並在錯誤附上還原點；這裡留下紀錄，讓使用者能「還原到匯入前」
    const restorePoint = err.restorePoint;
    if (!restorePoint) throw err;
    await writeRecord(eg, {
      tag, at: startedAt, machine: eg.machine.id, before, edits: clean, totals: plan.totals, copied: 0, skipped: 0,
      restorePoint, commits: [], bound: [], deferred: held, backupOnly: [],
      failed: { code: err.code ?? null, message: String(err.message ?? err) },
    });
    throw Object.assign(err, { tag, hint: `已完成的部分可以還原：在管理介面的「匯入既有記憶」按「還原到匯入前」，或執行 engram import undo ${tag}。` });
  }
  const rec = {
    tag, at: new Date().toISOString(), machine: eg.machine.id, before, edits: clean,
    totals: plan.totals, copied: result.copied, skipped: result.skipped,
    restorePoint: result.restorePoint ?? null, commits: result.commits, bound: result.bound,
    deferred: [...held, ...result.deferred], backupOnly: result.backupOnly ?? [],
  };
  await writeRecord(eg, rec);
  await dismissDecided(eg, plan, clean).catch(() => {});
  return {
    ok: true, tag, restorePoint: rec.restorePoint, copied: result.copied, skipped: result.skipped,
    bound: result.bound.length, archived: plan.totals.archived, backupOnly: rec.backupOnly.length,
    deferred: rec.deferred.map((d) => ({ path: d.path, reason: d.reason })),
  };
}

/** 還原：解除這次匯入建立的綁定（junction 換回實體資料夾），再依序 revert 匯入的 commit。 */
export async function undoImport(eg, { tag } = {}) {
  const rec = (await readRecords(eg)).find((r) => r.tag === tag && !r.undoneAt);
  if (!rec) throw Object.assign(new Error('找不到這次匯入的紀錄，或已經還原過'), { code: 'E_NOT_FOUND', hint: '在「匯入既有記憶」頁面重新整理，確認目前的匯入狀態。' });
  // 引擎的一鍵還原會先保存匯入後新寫的記憶，再把備份放回、移除綁定與設定，只 revert 這次匯入的 commit
  if (rec.restorePoint && eg.rollbackImport) {
    const r = await eg.rollbackImport(rec.restorePoint);
    rec.undoneAt = new Date().toISOString();
    rec.undo = r;
    await writeRecord(eg, rec);
    return { ok: r?.ok !== false, ...r };
  }
  const unbound = [];
  for (const b of rec.bound) {
    try { await eg.identity.unbind(b.path); unbound.push(b.path); } catch { /* 資料夾已不存在時略過 */ }
  }
  const reverted = [];
  for (const sha of [...rec.commits].reverse()) {
    const r = await eg.undo(sha);
    if (r?.ok) reverted.push(sha);
  }
  rec.undoneAt = new Date().toISOString();
  rec.undo = { unbound, reverted };
  await writeRecord(eg, rec);
  return { ok: reverted.length === rec.commits.length, unbound: unbound.length, reverted: reverted.length };
}
