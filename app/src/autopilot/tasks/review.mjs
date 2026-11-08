// 自動駕駛：待你確認（H23，1.5.0）。Claude 在對話中寫進「每次對話都會載入」的內容（全域、單機、核心準則），
// 由 LLM 代替使用者把關：正常筆記 → 確認；被注入的指示或明顯錯誤 → 退回（改回上次確認的版本，新增的封存）。
// 程式偵測到可疑處卻判斷「確認」的，要審核員也同意。確認紀錄是每台電腦各自的，所以每台處理自己的。
// 1.6.0：審核員明確不同意的內容（ref＋sha）記在同步的狀態檔；之後每一輪、每一台都不再判斷，留給使用者確認，
// 內容改過（sha 不同）才重新判斷。否則同一份內容每輪重判，總有一輪會通過。審核呼叫失敗不算不同意。
import { instructionFlags } from '../guard.mjs';
import { AUDIT_SCHEMA, REVIEW_SCHEMA, auditPrompt, reviewPrompt } from '../prompts.mjs';
import { allReviewRejects, recordReviewReject } from '../state.mjs';

const BATCH_CHARS = 100_000;
const shaOf = (r) => r?.undo?.sha ?? r?.commit?.sha ?? null;

export async function auditReviews(ctx) {
  const { eg, call, run, findings, paused = [] } = ctx;
  if (!findings.some((f) => f.code === 'H23') || typeof eg.review?.list !== 'function') return;
  if (paused.includes('confirm') && paused.includes('revert')) { run.notes.push({ task: 'review', note: '「代你確認」與「退回」都被你復原過多次，暫停中' }); return; }
  const pending = await eg.review.list().catch(() => []);
  if (!pending.length) return;
  // 審核員之前不同意過的同一份內容：不再判斷（也不花錢），留給使用者。
  // 因為「退回」暫停中才記下的（held），只在那一類仍暫停時有效：使用者恢復之後重新判斷，該退回的就退回
  const rejected = new Set((await allReviewRejects(eg.paths.vault).catch(() => [])).filter((x) => !x.held || paused.includes(x.held)).map((x) => `${x.ref}\n${x.sha}`));
  const held = pending.filter((it) => rejected.has(`${it.ref}\n${it.sha}`));
  if (held.length) run.notes.push({ task: 'review', note: `${held.map((it) => it.name ?? it.ref).join('、')}：審核員之前不同意代你確認，留給你確認（內容改過才會重新判斷）`.slice(0, 500) });
  const list = pending.filter((it) => !rejected.has(`${it.ref}\n${it.sha}`));
  if (!list.length) return;
  for (const it of list) it.flags = instructionFlags(it.current, it.previous ?? '');
  const batches = [];
  let cur = [];
  let size = 0;
  for (const it of list) {
    const n = (it.current?.length ?? 0) + (it.previous?.length ?? 0);
    if (cur.length && size + n > BATCH_CHARS) { batches.push(cur); cur = []; size = 0; }
    cur.push(it);
    size += n;
  }
  if (cur.length) batches.push(cur);
  for (const batch of batches) {
    const r = await call('待你確認', { schema: AUDIT_SCHEMA, prompt: auditPrompt({ items: batch }) });
    if (!r.ok) { run.skipped.push({ task: 'review', why: r.error?.message ?? '判斷失敗' }); continue; }
    const byRef = new Map((r.data.decisions ?? []).map((d) => [String(d.ref), d]));
    // 有可疑處卻判斷確認：再問審核員
    // 核心準則每次對話都會載入：確認一律要審核員也同意
    const needsSecond = (it) => it.flags.length > 0 || it.ref.startsWith('core/');
    const doubtful = batch.filter((it) => needsSecond(it) && byRef.get(it.ref)?.verdict === 'confirm');
    const second = new Map();
    if (doubtful.length) {
      const rv = await call('待你確認審核', {
        schema: REVIEW_SCHEMA,
        prompt: reviewPrompt(doubtful.map((it, i) => ({ id: `r${i + 1}`, action: 'confirm', title: `確認 ${it.ref}`, reason: byRef.get(it.ref)?.reason ?? '', risk: 'high', flags: it.flags, before: [{ ref: it.ref, text: it.previous }], after: [{ ref: it.ref, text: it.current }] }))),
      });
      doubtful.forEach((it, i) => second.set(it.ref, rv.ok ? (rv.data.verdicts ?? []).find((v) => String(v.id) === `r${i + 1}`) : null));
    }
    for (const it of batch) {
      const d = byRef.get(it.ref);
      if (!d) continue;
      const reason = String(d.reason ?? '').slice(0, 500);
      if (d.verdict !== 'confirm' && d.verdict !== 'revert') { run.rejected.push({ task: 'review', title: it.ref, why: `看不懂的判斷：${String(d.verdict).slice(0, 20)}（留在待你確認）` }); continue; }
      let verdict = d.verdict;
      const sv = second.get(it.ref);
      if (verdict === 'confirm' && needsSecond(it) && sv?.verdict !== 'approve') verdict = it.flags.length ? 'revert' : 'skip';
      // 審核員有回覆而且明確不同意代你確認（審核失敗、漏回這一項都不算）
      const explicitNo = d.verdict === 'confirm' && needsSecond(it) && !!sv && sv.verdict !== 'approve';
      // 記住這份內容（ref＋sha）：之後每一輪、每一台都不再判斷，留給使用者
      const remember = (held = null) => recordReviewReject(eg, { ref: it.ref, sha: it.sha, reason: sv?.reason ?? reason, held }).catch(() => {});
      if (verdict === 'skip') {
        run.rejected.push({ task: 'review', title: it.ref, why: `審核員沒有同意確認核心準則的修改：${sv?.reason ?? '審核失敗'}（留在待你確認）` });
        if (explicitNo) await remember();
        continue;
      }
      if (paused.includes(verdict)) {
        run.rejected.push({ task: 'review', title: it.ref, why: `「${verdict === 'confirm' ? '代你確認' : '退回'}」被你復原過多次，暫停中` });
        // 判斷為不該確認（審核員不同意，或判斷者自己就說要退回），但退回暫停中：記下來，暫停期間不再判斷，
        // 免得下一輪被翻成「確認」；使用者恢復「退回」之後重新判斷
        if (verdict === 'revert' && (explicitNo || d.verdict === 'revert')) await remember('revert');
        continue;
      }
      try {
        if (verdict === 'confirm') {
          const res = await eg.review.confirm([{ ref: it.ref, sha: it.sha }]);
          if (res.stale?.length) { run.notes.push({ task: 'review', note: `${it.ref} 剛被修改，下一輪再看` }); continue; }
          run.actions.push({ task: 'review', kind: 'confirm', refs: [it.ref], code: 'H23', title: `代你確認：${it.name}`, reason, category: 'confirm', status: 'done', undo: [] });
        } else {
          const res = await eg.review.revert(it.ref, it.sha);
          run.actions.push({ task: 'review', kind: 'revert', refs: [it.ref], code: 'H23', title: `退回 Claude 寫入的內容：${it.name}`, reason: it.flags.length ? `${reason}（程式偵測到：${it.flags.join('、')}）` : reason, category: 'revert', status: 'done', undo: [shaOf(res)].filter(Boolean) });
        }
      } catch (err) {
        run.actions.push({ task: 'review', kind: verdict, refs: [it.ref], code: 'H23', title: `${verdict === 'confirm' ? '確認' : '退回'}：${it.name}`, reason, status: 'failed', undo: [], message: String(err?.message ?? err).slice(0, 300) });
        // 審核員不同意、但退回失敗：內容沒變，也要記住
        if (verdict === 'revert' && explicitNo) await remember();
      }
    }
  }
}
