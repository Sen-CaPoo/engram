// 自動駕駛：收件匣卡片（1.5.0）。
// - 規則就能處理的：H06 撞名改名、H17 綁定修正、H14 同步、H24 核心準則建議、H04 舊綁定（資料夾消失超過 14 天才移除）
// - 要判斷的：H05 收編、H18 大量刪除、H19 可能屬於另一個資料夾 → LLM 決定套用哪個修正、忽略或延後
// H07～H12、H16、H21、H22 由範圍整理處理；H13、H15、H20、H23 各有自己的任務。
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../../cli/fsutil.mjs';
import { CARDS_SCHEMA, cardsPrompt } from '../prompts.mjs';

const DAY = 86_400_000;
const H04_AFTER_MS = 14 * DAY;
export const JUDGED_CODES = ['H05', 'H18', 'H19'];

const shaOf = (r) => r?.undo?.sha ?? r?.commit?.sha ?? null;

/** 這個版本能不能用 engram undo 單獨復原（綁定、匯入類的 commit 不行） */
async function undoableSha(eg, sha) {
  if (!sha) return null;
  const h = (await eg.history({ limit: 30 }).catch(() => [])).find((c) => c.sha.startsWith(String(sha)));
  return h?.undoable ? sha : null;
}
const seenFile = (local) => path.join(local, 'autopilot', 'seen.json');

/** 規則就能處理的卡片 */
export async function ruleCards(ctx) {
  const { eg, run, findings, now, paused = [] } = ctx;
  const off = (cat) => paused.includes(cat);
  const push = async (f, title, r, extra = {}) => run.actions.push({ task: 'cards', kind: 'card', card: f?.id ?? null, code: f?.code ?? null, title, reason: extra.reason ?? '', status: r?.ok === false ? 'failed' : 'done', undo: [await undoableSha(eg, shaOf(r))].filter(Boolean), ...extra });
  const fail = (f, title, err) => run.actions.push({ task: 'cards', kind: 'card', card: f.id, code: f.code, title, reason: '', status: 'failed', undo: [], message: String(err?.message ?? err).slice(0, 300) });

  // H17 只處理引擎能直接修的（重新綁定、允許讀取、對齊綁定方式）；其他的要在介面操作，略過
  for (const f of findings.filter((x) => x.code === 'H17' && !off('card-H17') && ['rebind', 'allow-read', 'reconcile-bindings'].includes(x.fix?.action))) {
    try { await push(f, `修正綁定：${f.title}`, await eg.apply(f.fix), { reason: f.detail, category: 'card-H17' }); } catch (err) { fail(f, `修正綁定：${f.title}`, err); }
  }
  // H06：自動駕駛把撞名改名當成「自動」處理，但使用者設為「關閉」、或相容性探測暫停了綁定時不改
  const pausedFile = (await readJson(path.join(eg.paths.local, 'paused.json'), null)) ?? {};
  const renameMode = (await eg.settings.get().catch(() => ({})))?.collisionRename ?? 'ask';
  if (findings.some((x) => x.code === 'H06') && eg.collisions && renameMode !== 'off' && !pausedFile.junction && !pausedFile.user && !off('rename')) {
    try {
      const r = await eg.collisions.apply({});
      if (r.renamed?.length) run.actions.push({ task: 'cards', kind: 'rename', code: 'H06', title: `依命名規則改名 ${r.renamed.length} 個撞名的資料夾`, reason: r.renamed.map((x) => `${path.basename(x.from)} → ${path.basename(x.to)}`).join('、'), category: 'rename', status: 'done', undo: [], renameId: r.id });
    } catch (err) { run.skipped.push({ task: 'cards', why: `撞名改名失敗：${err.message}` }); }
  }
  if (findings.some((x) => x.code === 'H14')) {
    const r = await eg.sync().catch((err) => ({ ok: false, error: { message: err.message } }));
    if (!r?.ok) run.notes.push({ task: 'cards', note: `同步仍然失敗（通常要你重新登入 GitHub：在終端機執行 gh auth login）：${r?.error?.message ?? ''}`.slice(0, 300) });
  }
  // 核心準則的建議更新：1.6.0 起任何一台都可以套用（兩台套用同樣的文字，同步時不會衝突）；開始前同步失敗時先不改共用的核心準則
  if (ctx.shared !== false && !off('core') && findings.some((x) => x.code === 'H24') && typeof eg.core?.suggestions === 'function') {
    try {
      const ids = (await eg.core.suggestions()).map((s) => s.id);
      if (ids.length) await push(findings.find((x) => x.code === 'H24'), '加入核心準則的建議更新', await eg.core.applySuggestions(ids), { reason: 'Engram 內建的記憶寫入協定更新', category: 'core' });
    } catch (err) { run.skipped.push({ task: 'cards', why: `核心準則建議：${err.message}` }); }
  }
  // H04：資料夾不見了。可能只是外接硬碟沒接、或暫時搬開；連續 14 天都不見才移除舊綁定（對話紀錄仍可回顧）
  const seen = (await readJson(seenFile(eg.paths.local), null)) ?? {};
  const live = new Set();
  for (const f of findings.filter((x) => x.code === 'H04' && x.fix && !off('card-H04'))) {
    live.add(f.id);
    seen[f.id] ??= new Date(now).toISOString();
    if (now - Date.parse(seen[f.id]) < H04_AFTER_MS) continue;
    try { await push(f, `移除舊綁定：${f.title}`, await eg.apply(f.fix), { reason: `${f.detail}（已經連續 14 天以上找不到這個資料夾）`, category: 'card-H04' }); delete seen[f.id]; } catch (err) { fail(f, `移除舊綁定：${f.title}`, err); }
  }
  for (const k of Object.keys(seen)) if (!live.has(k)) delete seen[k];
  await writeJsonAtomic(seenFile(eg.paths.local), seen);
}

/** 要判斷的卡片：一次問 LLM，再逐張執行 */
export async function judgedCards(ctx) {
  const { eg, call, run, findings, feedback, now } = ctx;
  // 開始前沒有同步時略過 H19（會把共用的專案記憶搬到別的專案）與 H05 收編（依過期的專案清單可能建立重複的專案）；
  // H18 大量刪除看的是這台自己待推送的狀態，照常處理
  const cards = findings.filter((x) => JUDGED_CODES.includes(x.code) && (x.fixes?.length || x.fix) && !(ctx.paused ?? []).includes(`card-${x.code}`) && (ctx.shared !== false || x.code === 'H18'));
  if (!cards.length) return;
  const rows = [];
  for (const c of cards) {
    const fixes = c.fixes?.length ? c.fixes : [c.fix];
    let context = '';
    if (c.code === 'H19') {
      const ref = c.refs?.[0];
      if (ref) context = (await eg.secrets.preview(ref).then((p) => p.after).catch(() => '')).slice(0, 8000);
    } else if (c.code === 'H18') {
      const hist = await eg.history({ limit: 15 }).catch(() => []);
      context = [`被刪除的記憶：${(c.refs ?? []).join('、')}`, '最近的變更紀錄：', ...hist.map((h) => `- ${h.at} ${h.machine ?? ''} ${h.action ?? ''} ${(h.refs ?? []).slice(0, 5).join('、')} ${h.subject ?? ''}`)].join('\n');
    }
    rows.push({ id: c.id, code: c.code, title: c.title, detail: c.detail, fixes: fixes.map((f) => ({ label: f.label })), context });
  }
  const r = await call('收件匣卡片', { schema: CARDS_SCHEMA, prompt: cardsPrompt({ cards: rows, feedback: feedback.slice(-20) }) });
  if (!r.ok) { run.skipped.push({ task: 'cards', why: r.error?.message ?? '卡片判斷失敗' }); return; }
  for (const d of r.data.decisions ?? []) {
    const c = cards.find((x) => x.id === String(d.card));
    if (!c) continue;
    const reason = String(d.reason ?? '').slice(0, 500);
    if (d.action === 'apply') {
      const fixes = c.fixes?.length ? c.fixes : [c.fix];
      const fix = fixes[(Number.isInteger(d.fix) ? d.fix : 1) - 1];
      if (!fix) { run.rejected.push({ task: 'cards', title: c.title, why: `沒有第 ${d.fix} 個修正` }); continue; }
      try {
        const res = await eg.apply(fix);
        if (res?.needsUi) { run.rejected.push({ task: 'cards', title: c.title, why: '這個修正要在介面操作' }); continue; }
        run.actions.push({ task: 'cards', kind: 'card', card: c.id, code: c.code, title: `${fix.label}：${c.title}`, reason, category: `card-${c.code}`, status: 'done', undo: [await undoableSha(eg, shaOf(res))].filter(Boolean), ...(c.code === 'H05' ? { note: '收編屬於匯入，要從匯入頁整批還原' } : {}) });
      } catch (err) {
        run.actions.push({ task: 'cards', kind: 'card', card: c.id, code: c.code, title: `${fix.label}：${c.title}`, reason, status: 'failed', undo: [], message: String(err?.message ?? err).slice(0, 300) });
      }
    } else {
      const days = d.action === 'defer' ? 3 : 90;
      await eg.findings.dismiss(c.id, { until: new Date(now + days * DAY).toISOString() }).catch(() => {});
      run.actions.push({ task: 'cards', kind: 'dismiss', card: c.id, code: c.code, title: `${d.action === 'defer' ? '延後' : '不處理'}：${c.title}`, reason, status: 'done', undo: [] });
    }
  }
}
