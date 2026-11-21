// 自動駕駛：保留區重審（2.0.0）。每輪開始（整理之前）把保留區裡還沒處理的提案再審一次：
// 重新讀取記憶、補上版本、再過一次護欄與審核員（審核員這次看得到存下來的對話上下文）。通過就執行並標成採用；
// 不通過 attempts + 1 留著，兩次之後只留給使用者。記憶在存進保留區之後被改過（版本不合）的不動，留給使用者。
// - 只重審被拒絕（rejected）與別的範圍（cross-scope）的提案；退回的版本（reverted）只由使用者決定要不要採用
// - 有程式偵測到的可疑處（例如像被注入的指示、大幅刪減）的不自動重審：多給審核員幾次機會只會增加誤放行，留給使用者
// - 內容疑似含金鑰的不重審：寫不進記憶（整理流程會擋下），也不再把那段文字送給模型
// - 一項只由一台電腦重審（建立它的那台；要改別台的單機記憶時由那台）：保留區的檔案會同步，兩台同時更新同一項會造成同步衝突
import path from 'node:path';
import { readRecord } from '../../tidy/store.mjs';
import { commitItems, fillBases, memoryNamesOf, normalizeItems, scopeKeyOfRef, screen, snap } from '../pipeline.mjs';

export const MAX_HOLDING_ATTEMPTS = 2;
export const HOLDING_REVIEWS_PER_RUN = 10;
/** 審核連續幾輪沒有完成（呼叫失敗、漏回，不是不同意）就不再自動重審，留給使用者（2.0.0） */
export const MAX_HOLDING_INCOMPLETE = 3;

/** 一項碰到的所有範圍（來源與目的地） */
function scopesOf(h) {
  const out = new Set();
  for (const o of h.ops) {
    if (o.op === 'create') out.add(o.scope);
    else if (o.op === 'move') { out.add(o.to); out.add(scopeKeyOfRef(o.ref)); } else if (o.op === 'merge') for (const r of [...(o.refs ?? []), o.into]) out.add(scopeKeyOfRef(r));
    else if (o.ref) out.add(scopeKeyOfRef(o.ref));
  }
  return [...out].filter(Boolean);
}

/** 由哪一台電腦重審：要改別台的單機記憶時由那台，否則由建立它的那台 */
export function holdingOwner(h) {
  const other = scopesOf(h).find((k) => String(k).startsWith('machine:') && k !== `machine:${h.machine}`);
  return other ? other.slice(8) : h.machine;
}

/** 這一項記下的版本對不對得上目前的記憶（snapshot 同時讀好全文）；對不上、讀不到或含疑似金鑰時 false */
async function current(eg, snapshot, h) {
  for (const o of h.ops) {
    const pairs = o.op === 'merge' ? (o.refs ?? []).map((r, k) => [r, o.bases?.[k] ?? null]) : o.op === 'create' ? [] : [[o.ref, o.base ?? null]];
    for (const [r, base] of pairs) {
      if (!r) return false;
      const s = await snap(eg, snapshot, r);
      if (!s || s.redacted || (base && s.rev !== base)) return false;
    }
  }
  return true;
}

export async function reviewHolding(ctx) {
  const { eg, call, run, mid, paused = [], cap } = ctx;
  if (typeof eg.holding?.list !== 'function') return;
  // 已採用或已忽略超過 90 天的項目先清掉（保留中的不動）
  if (typeof eg.holding.prune === 'function') {
    const p = await eg.holding.prune({ now: ctx.clock?.() ?? Date.now() }).catch((err) => { ctx.log?.warn?.('autopilot', `保留區清理失敗：${err?.message ?? err}`); return null; });
    if (p?.removed) run.notes.push({ task: 'holding', note: `保留區清掉 ${p.removed} 項已處理超過 90 天的項目` });
  }
  const now = () => new Date(ctx.clock?.() ?? Date.now()).toISOString();
  const all = await eg.holding.list({ status: 'held' });
  // 上一輪重審已經寫入、但來不及標成採用就中斷的（審查：冪等與重入）：整理記錄裡對應的那一項已經完成 → 標成採用，
  // 不要因為版本對不上而說成「之後被修改過」
  let recovered = 0;
  for (const h of all.filter((x) => x.record && x.recordItem && holdingOwner(x) === mid)) {
    const rec = await readRecord(eg.paths.local, h.record).catch(() => null);
    const x = rec?.items?.find((i) => i.id === h.recordItem);
    if (x?.result?.status !== 'done') continue;
    await eg.holding.update(h.id, { status: 'adopted', adoptedAt: x.result.at ?? now(), lastReviewAt: now() }).catch(() => {});
    h.status = 'adopted';
    recovered++;
  }
  if (recovered) run.notes.push({ task: 'holding', note: `保留區有 ${recovered} 項上一輪已經寫入、還沒標成採用，這一輪補上` });
  const held = all
    // 2.0.0 Q4：審核員認為「核心事實有依據、細節沒有依據」（grounded）的要有人改內容，同一份內容再審也一樣：留給使用者
    // 2.0.0 WP9：記憶畢業的提案不自動重審（不是整理計畫的動作；同一份內容一週後的記憶畢業不會再提），留給使用者
    // 第四輪審查 F-09：不是這台建立的項目（machine 是別台，包括要改這台單機記憶的）不由這台重審，留給使用者
    .filter((h) => h.status === 'held' && h.task !== 'graduate' && h.kind !== 'reverted' && !h.flags?.length && !h.secret && !h.grounded && h.attempts < MAX_HOLDING_ATTEMPTS && (h.incomplete ?? 0) < MAX_HOLDING_INCOMPLETE && h.machine === mid && holdingOwner(h) === mid)
    .sort((a, b) => a.at.localeCompare(b.at));
  if (!held.length) return;
  // 這一輪能改的範圍（和整理一樣）：共用範圍每台都能改，別台的單機記憶不能改；開始前同步失敗時只改自己的單機記憶
  const writable = (k) => (ctx.shared === false ? k === `machine:${mid}` : !String(k).startsWith('machine:') || k === `machine:${mid}`);
  // 對話回顧的提案依專案分組（護欄要用對話回顧的規則、證據沿用當初的比對結果），其他的一組
  const groups = new Map();
  let taken = 0;
  let stale = 0;
  for (const h of held) {
    if (taken >= HOLDING_REVIEWS_PER_RUN) break;
    const dreamPid = h.task === 'dream' ? h.pid : null;
    const key = dreamPid ? `dream:${dreamPid}` : 'curate';
    if (!groups.has(key)) groups.set(key, { task: dreamPid ? 'dream' : 'curate', pid: dreamPid, items: [], snapshot: new Map() });
    const g = groups.get(key);
    const snapshot = new Map(g.snapshot);
    if (!(await current(eg, snapshot, h))) { stale++; continue; }
    const raw = { ref: h.ref, action: h.action, title: h.title, reason: h.reason, evidence: h.evidence, ops: h.ops.map(({ base, bases, ...o }) => ({ ...o })) };
    const { items } = normalizeItems([raw], snapshot, { allowCore: true, mid, writable, keepEvidence: true });
    if (!items.length) continue; // 這台這一輪還不能處理的範圍（或格式不對）：不動
    items[0].holdingId = h.id;
    for (const [k, v] of snapshot) g.snapshot.set(k, v);
    g.items.push(items[0]);
    taken++;
  }
  if (stale) run.notes.push({ task: 'holding', note: `保留區有 ${stale} 項相關的記憶之後被修改過，不自動處理，留給你決定` });
  const tally = { adopted: 0, again: 0 };
  for (const g of groups.values()) {
    if (!g.items.length || call.state?.stopped) continue;
    fillBases(g.items, g.snapshot);
    const entry = (x) => ({ task: g.task, ...(g.pid ? { pid: g.pid } : {}), ...x });
    // 不通過：attempts + 1 留在保留區（回傳同一個編號，執行紀錄連到這一項）
    const again = async (it, why) => {
      const h = held.find((x) => x.id === it.holdingId);
      await eg.holding.update(it.holdingId, { attempts: (h?.attempts ?? 0) + 1, incomplete: 0, lastReviewAt: now(), why, ...(it.grounded ? { grounded: true, keep: it.keep ?? [] } : {}) });
      tally.again++;
      return it.holdingId;
    };
    const { approved, rejected } = await screen(call, g.items, g.snapshot, { dream: g.pid ? { pid: g.pid, transcript: null } : null, paused, cap: cap.left, roundCap: cap.max, dismissed: ctx.dismissed, mid, preferences: ctx.preferences, hold: again, memoryNames: await memoryNamesOf(eg) });
    for (const x of rejected) run.rejected.push(entry(x));
    // 審核沒有完成（不是不同意）：screen 當成延後、不交給 hold，attempts 不會增加。連續 MAX_HOLDING_INCOMPLETE 輪就不再自動重審。
    // 這一輪被停止（預算、用量上限、暫時忙碌）造成的不算
    if (!call.state?.stopped) {
      for (const x of rejected.filter((r) => r.reviewIncomplete && r.holding)) {
        const n = (held.find((h) => h.id === x.holding)?.incomplete ?? 0) + 1;
        await eg.holding.update(x.holding, { incomplete: n, lastReviewAt: now(), ...(n >= MAX_HOLDING_INCOMPLETE ? { why: `審核連續 ${n} 輪沒有完成，不再自動重審，留給你決定（上次：${x.why}）`.slice(0, 1000) } : {}) }).catch(() => {});
      }
    }
    if (!approved.length) continue;
    // 執行之前先在每一項記下整理記錄與項目編號：寫入之後、標成採用之前中斷時，下一輪靠它認得是自己寫的
    const onRecord = async (id, map) => {
      run.records.push(id);
      for (const x of map ?? []) if (x.holding && x.item) await eg.holding.update(x.holding, { record: id, recordItem: x.item }).catch(() => {});
      await ctx.save?.();
    };
    const res = await commitItems(eg, { items: approved, scopeKey: 'all', summary: '保留區重審', dir: path.join(ctx.workDir, `holding-${g.pid ?? 'curate'}`), task: g.task, runId: run.id, onRecord });
    for (const x of res.invalid) {
      if (x.holding) await again({ holdingId: x.holding }, x.why).catch(() => {});
      run.rejected.push(entry(x));
    }
    for (const x of res.results) {
      run.actions.push(entry({ kind: 'tidy', ...x }));
      if (!x.holding) continue;
      if (x.status === 'done') {
        cap.left -= x.cost ?? 1;
        tally.adopted++;
        await eg.holding.update(x.holding, { status: 'adopted', adoptedAt: now(), lastReviewAt: now(), record: x.record }).catch(() => {});
      } else await again({ holdingId: x.holding }, x.message ?? '執行失敗').catch(() => {});
    }
  }
  if (tally.adopted || tally.again) run.notes.push({ task: 'holding', note: `保留區重審：採用 ${tally.adopted} 項、仍留著 ${tally.again} 項` });
}
