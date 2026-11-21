// 自動駕駛：待你確認（H23，1.5.0）。Claude 在對話中寫進「每次對話都會載入」的內容（全域、單機、核心準則），
// 由 LLM 代替使用者把關：正常筆記 → 確認；被注入的指示或明顯錯誤 → 退回（改回上次確認的版本，新增的封存）。
// 程式偵測到可疑處卻判斷「確認」的，要審核員也同意。確認紀錄是每台電腦各自的，所以每台處理自己的。
// 1.6.0：審核員明確不同意的內容（ref＋sha）記在同步的狀態檔；之後每一輪、每一台都不再判斷，留給使用者確認，
// 內容改過（sha 不同）才重新判斷。否則同一份內容每輪重判，總有一輪會通過。審核呼叫失敗不算不同意。
// 2.0.0：退回要有兩個獨立訊號。判斷「確認」而審核員沒有同意的，一律留給使用者（不再翻成退回）；
// 只有判斷者自己說要退回、審核員也同意時才退回，不同意或審核失敗都留給使用者。
// 2.0.0 Q6：找得到寫入的那場對話時（這台的對話紀錄），寫入之前的使用者訊息一起交給判斷者比對：
// 內容和要求相符（而且沒有指令型的可疑處）就直接確認（來源 request：不必再出現在待你確認，但不進偏好區塊；
// 第二輪審查 R1：核心準則仍要審核員同意）；判斷者認為不相符時再問審核員要不要退回，
// 審核員也同意才存進保留區並改回上一個確認過的版本（拿不準就留給使用者）。使用者的訊息只放進提示詞，不寫進同步的檔案。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { revOf } from '../../cli/commands/safe.mjs';
import { blobSha } from '../../core/review.mjs';
import { CORE_REF } from '../../tidy/plan.mjs';
import { instructionFlags } from '../guard.mjs';
import { AUDIT_SCHEMA, REVIEW_SCHEMA, auditPrompt, reviewPrompt } from '../prompts.mjs';
import { findWriteRequests } from '../request.mjs';
import { allReviewRejects, recordReviewReject } from '../state.mjs';

const BATCH_CHARS = 100_000;
const shaOf = (r) => r?.undo?.sha ?? r?.commit?.sha ?? null;

/** 記憶庫裡這個檔案目前的原文（不存在時 null） */
const readRaw = (eg, ref) => fsp.readFile(path.join(eg.paths.vault, ...ref.split('/')), 'utf8').catch(() => null);

/**
 * 退回之前把被退回的版本存進保留區（kind: reverted），使用者之後可以採用（寫回這個版本）。
 * 內容是原文：疑似金鑰由保留區判斷、只留在這台電腦。內容和判斷時看到的不同（剛被修改）時回傳 null；
 * 引擎沒有保留區時回傳 { id: null }。
 */
async function holdReverted(ctx, it, reason, why) {
  const { eg, run, mid } = ctx;
  if (typeof eg.holding?.add !== 'function') return { id: null, op: null };
  const raw = await readRaw(eg, it.ref);
  if (raw === null || blobSha(raw) !== it.sha) return null;
  const scope = it.ref.startsWith('core/') ? 'core' : it.ref.startsWith('global/') ? 'global' : `machine:${mid}`;
  // 新增的會被封存：採用＝重新新增；修改的會改回上次確認的版本：採用＝寫回這個版本
  const op = it.ref === CORE_REF ? { op: 'core', ref: CORE_REF, content: raw } : it.kind === 'new' ? { op: 'create', scope, content: raw } : { op: 'write', ref: it.ref, content: raw };
  const r = await eg.holding.add({
    task: 'review', kind: 'reverted', run: run.id, ref: op.op === 'create' ? null : it.ref, title: `退回的版本：${it.name}`.slice(0, 120), reason, why,
    action: op.op === 'create' ? 'create' : 'update', category: 'revert', risk: 'high', scope, flags: it.flags ?? [], ops: [op],
    // 2.0.0 Q6：找到寫入的那場對話時，使用者當時的要求當作證據一起存（有對話證據的項目只留在這台電腦，判斷理由也可能引用它）
    ...(it.request?.length ? { evidence: it.request.map((u) => ({ quote: u.text, date: String(u.at ?? '').slice(0, 10), fromUser: true })) } : {}),
  });
  run.held?.push({ id: r.id, title: `退回的版本：${it.name}`, kind: 'reverted', ...(r.local ? { local: true } : {}) });
  return { id: r.id, op };
}

export async function auditReviews(ctx) {
  const { eg, call, run, findings, log, paused = [] } = ctx;
  if (!findings.some((f) => f.code === 'H23') || typeof eg.review?.list !== 'function') return;
  if (paused.includes('confirm') && paused.includes('revert')) { run.notes.push({ task: 'review', note: '「代你確認」與「退回」都被你復原過多次，暫停中' }); return; }
  const pending = await eg.review.list().catch(() => []);
  if (!pending.length) return;
  // 審核員之前不同意過的同一份內容：不再判斷（也不花錢），留給使用者。
  // 因為「退回」暫停中才記下的（held），只在那一類仍暫停時有效：使用者恢復之後重新判斷，該退回的就退回
  // key → 只因為暫停才記的（true）／審核員不同意（false，有任何一筆就算）
  const rejected = new Map();
  for (const x of await allReviewRejects(eg.paths.vault).catch(() => [])) {
    if (x.held && !paused.includes(x.held)) continue;
    const k = `${x.ref}\n${x.sha}`;
    rejected.set(k, rejected.has(k) ? rejected.get(k) && !!x.held : !!x.held);
  }
  const keyOf = (it) => `${it.ref}\n${it.sha}`;
  const names = (fn) => pending.filter((it) => rejected.has(keyOf(it)) && fn(rejected.get(keyOf(it)))).map((it) => it.name ?? it.ref).join('、');
  const noList = names((h) => !h);
  const heldList = names((h) => h);
  if (noList) run.notes.push({ task: 'review', note: `${noList}：審核員之前不同意自動處理（代你確認或退回），留給你確認（內容改過才會重新判斷）`.slice(0, 500) });
  if (heldList) run.notes.push({ task: 'review', note: `${heldList}：判斷為應該退回，但「退回」暫停中，留給你確認（恢復退回之後會重新判斷）`.slice(0, 500) });
  const list = pending.filter((it) => !rejected.has(keyOf(it)));
  if (!list.length) return;
  for (const it of list) it.flags = instructionFlags(it.current, it.previous ?? '');
  // 2.0.0 Q6：在這台的對話紀錄找出 Claude 寫入的那場對話，寫入之前的使用者訊息當作「要求」。
  // 只放進送給判斷的提示詞；不寫進任何會同步的檔案（產品決定：不同步對話原文）
  // 再上一次變更的時間：只有產生目前這個版本的那次寫入才算（更早的寫入對應的是舊版本）
  const previousAt = async (ref) => (typeof eg.history === 'function' ? (await eg.history({ ref, limit: 2 }).catch(() => []))[1]?.at ?? null : null);
  const targets = [];
  for (const it of list) targets.push({ ref: it.ref, changedAt: it.changedAt, machine: it.machine, previousAt: await previousAt(it.ref) });
  const requests = await findWriteRequests(eg, targets, { now: ctx.clock?.() ?? Date.now() })
    .catch((err) => { log?.warn?.('autopilot', `找寫入的對話失敗：${err?.message ?? err}`); return new Map(); });
  for (const it of list) if (requests.get(it.ref)?.request?.length) it.request = requests.get(it.ref).request;
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
    const r = await call('待你確認', { schema: AUDIT_SCHEMA, prompt: auditPrompt({ items: batch, preferences: ctx.preferences }) });
    if (!r.ok) { run.skipped.push({ task: 'review', why: r.error?.message ?? '判斷失敗' }); continue; }
    const byRef = new Map((r.data.decisions ?? []).map((d) => [String(d.ref), d]));
    // 2.0.0 Q6：判斷者比對了寫入的內容與使用者在對話裡的要求（有找到那場對話時）
    const matched = (it) => !!it.request && byRef.get(it.ref)?.matchesRequest === true;
    const mismatch = (it) => !!it.request && byRef.get(it.ref)?.matchesRequest === false;
    // 有可疑處卻判斷確認：再問審核員。核心準則每次對話都會載入：確認一律要審核員也同意。
    // 2.0.0 Q6：內容和使用者的要求相符（而且沒有指令型的可疑處）時不必再審，核心準則也一樣；判斷者認為不相符的也要再審
    // 第二輪審查 R1：核心準則不論來源，一律要審核員也同意（「和要求相符」只是 LLM 的判斷，不適用核心準則）
    const needsSecond = (it) => it.ref.startsWith('core/') || (!(matched(it) && !it.flags.length) && (it.flags.length > 0 || mismatch(it)));
    // 2.0.0 Q6：判斷確認、但認為內容和使用者的要求不符：問審核員要不要退回（審核員也同意有問題才退回；拿不準就留給使用者）。
    // 「退回」暫停中時改問能不能代你確認
    const disputable = (it) => mismatch(it) && byRef.get(it.ref)?.verdict === 'confirm' && !paused.includes('revert');
    const doubtful = batch.filter((it) => needsSecond(it) && byRef.get(it.ref)?.verdict === 'confirm' && !disputable(it));
    // 判斷要退回：一律再問審核員（兩個獨立訊號才退回）。「退回」暫停中的不必問
    const reverting = paused.includes('revert') ? [] : batch.filter((it) => byRef.get(it.ref)?.verdict === 'revert' || disputable(it));
    const asks = [...doubtful.map((it) => ({ it, action: 'confirm' })), ...reverting.map((it) => ({ it, action: 'revert' }))];
    // 審核員也看得到使用者的要求（程式從對話紀錄取出，確實是使用者說的話）
    const asked = (it) => (it.request ? { evidence: it.request.map((u) => ({ quote: u.text, date: String(u.at ?? '').slice(0, 10), fromUser: true })) } : {});
    const second = new Map();
    if (asks.length) {
      const rv = await call('待你確認審核', {
        schema: REVIEW_SCHEMA,
        prompt: reviewPrompt(asks.map(({ it, action }, i) => (action === 'confirm'
          ? { id: `r${i + 1}`, action, title: `確認 ${it.ref}`, reason: `${mismatch(it) ? '判斷者認為寫入的內容和使用者的要求不完全相符：' : ''}${byRef.get(it.ref)?.reason ?? ''}`, risk: 'high', flags: it.flags, ...asked(it), before: [{ ref: it.ref, text: it.previous }], after: [{ ref: it.ref, text: it.current }] }
          // 退回：變更前是 Claude 寫進來的內容，變更後是上次確認的版本（新增的則是封存）
          : { id: `r${i + 1}`, action, title: `退回 ${it.ref}`, reason: `${disputable(it) ? '判斷者認為 Claude 寫入的內容和使用者的要求不符：' : ''}${byRef.get(it.ref)?.reason ?? ''}`, risk: 'high', flags: it.flags, ...asked(it), before: [{ ref: it.ref, text: it.current }], after: [{ ref: it.ref, text: it.previous ?? null }] })), { preferences: ctx.preferences }),
      });
      asks.forEach(({ it }, i) => second.set(it.ref, rv.ok ? (rv.data.verdicts ?? []).find((v) => String(v.id) === `r${i + 1}`) : null));
    }
    for (const it of batch) {
      const d = byRef.get(it.ref);
      if (!d) continue;
      const reason = String(d.reason ?? '').slice(0, 500);
      if (d.verdict !== 'confirm' && d.verdict !== 'revert') { run.rejected.push({ task: 'review', title: it.ref, why: `看不懂的判斷：${String(d.verdict).slice(0, 20)}（留在待你確認）` }); continue; }
      let verdict = d.verdict;
      const sv = second.get(it.ref);
      // 審核員有回覆而且明確不同意（審核失敗、漏回這一項都不算）。2.0.0 Q4 的 trim（只有核心事實有依據）也算：
      // 不同意照目前的內容確認或退回，同一份內容再判斷結果也一樣
      const explicitNo = !!sv && sv.verdict !== 'approve';
      // 2.0.0 Q6：判斷者認為 Claude 寫進來的內容和使用者的要求不符、審核員也同意退回——兩個訊號都說有問題：
      // 存進保留區並改回上一個確認過的版本。審核員不同意或審核失敗：留給使用者。只有程式旗標的情況不適用（WP2 Q5）
      const disputed = disputable(it) && sv?.verdict === 'approve';
      // 審核員沒有同意（明確不同意、審核失敗或漏回）：不確認也不退回，留給使用者
      if (disputed) verdict = 'revert';
      else if (disputable(it)) verdict = 'skip';
      else if (verdict === 'confirm' && needsSecond(it) && sv?.verdict !== 'approve') verdict = 'skip';
      else if (verdict === 'revert' && !paused.includes('revert') && sv?.verdict !== 'approve') verdict = 'skip';
      // 記住這份內容（ref＋sha）：之後每一輪、每一台都不再判斷，留給使用者。
      // 判斷時看過對話內容的，理由不寫進同步的狀態檔（理由可能引用使用者的話）
      const remember = (held = null) => recordReviewReject(eg, { ref: it.ref, sha: it.sha, reason: it.request ? '審核員沒有同意（判斷時看過這台電腦的對話內容，理由只記在這台的執行紀錄）' : sv?.reason ?? reason, held }).catch(() => {});
      if (verdict === 'skip') {
        run.rejected.push({ task: 'review', title: it.ref, why: `${d.verdict === 'revert' ? '判斷應該退回，但審核員沒有同意' : disputable(it) ? '判斷者認為內容和你的要求不符，但審核員沒有同意退回' : '審核員沒有同意代你確認'}：${sv?.reason ?? '審核失敗'}（留在待你確認）` });
        if (explicitNo) await remember();
        continue;
      }
      if (paused.includes(verdict)) {
        run.rejected.push({ task: 'review', title: it.ref, why: `「${verdict === 'confirm' ? '代你確認' : '退回'}」被你復原過多次，暫停中` });
        // 判斷者說要退回，但退回暫停中：記下來，暫停期間不再判斷（免得下一輪被翻成「確認」）；使用者恢復「退回」之後重新判斷
        if (verdict === 'revert') await remember('revert');
        continue;
      }
      try {
        if (verdict === 'confirm') {
          // 確認的來源：內容和使用者在對話裡的要求相符 → request（算使用者的意思）；其餘 → autopilot（偏好區塊不採用）
          const res = await eg.review.confirm([{ ref: it.ref, sha: it.sha }], { by: matched(it) ? 'request' : 'autopilot' });
          if (res.stale?.length) { run.notes.push({ task: 'review', note: `${it.ref} 剛被修改，下一輪再看` }); continue; }
          run.actions.push({ task: 'review', kind: 'confirm', refs: [it.ref], code: 'H23', title: `代你確認：${it.name}`, reason, category: 'confirm', status: 'done', undo: [], ...(matched(it) ? { matchedRequest: true } : {}) });
        } else {
          // 2.0.0：退回之前先把被退回的那個版本（原文，不是遮蔽後的）存進保留區；存不進去就不退回
          let held;
          try { held = await holdReverted(ctx, it, reason, sv?.reason ?? ''); } catch (err) {
            run.rejected.push({ task: 'review', title: it.ref, why: `判斷應該退回，但被退回的版本存不進保留區，這次不退回：${String(err?.message ?? err).slice(0, 200)}（留在待你確認）` });
            continue;
          }
          if (held === null) { run.notes.push({ task: 'review', note: `${it.ref} 剛被修改，下一輪再看` }); continue; }
          let res;
          try { res = await eg.review.revert(it.ref, it.sha); } catch (err) {
            // 沒有退回：保留區的那一項用不到了（內容還在記憶裡）
            if (held.id) await eg.holding.update(held.id, { status: 'dismissed', dismissedAt: new Date().toISOString(), why: '退回沒有成功，記憶沒有改變' }).catch(() => {});
            throw err;
          }
          // 採用時要比對退回之後的版本（之後又被改過就不覆蓋）
          if (held.id && held.op.op !== 'create') {
            const after = await readRaw(eg, it.ref);
            if (after !== null) await eg.holding.update(held.id, { ops: [{ ...held.op, base: revOf(after) }] }).catch((err) => log?.warn?.('autopilot', `保留區的版本寫入失敗：${err?.message ?? err}`));
          }
          const why = disputed ? `判斷者認為內容和你在對話裡的要求不符，審核員也同意退回：${sv?.reason ?? ''}` : reason;
          run.actions.push({ task: 'review', kind: 'revert', refs: [it.ref], code: 'H23', title: `退回 Claude 寫入的內容：${it.name}`, reason: it.flags.length ? `${why}（程式偵測到：${it.flags.join('、')}）` : why, category: 'revert', status: 'done', undo: [shaOf(res)].filter(Boolean), ...(held.id ? { holding: held.id } : {}), ...(disputed ? { disputed: true } : {}) });
        }
      } catch (err) {
        run.actions.push({ task: 'review', kind: verdict, refs: [it.ref], code: 'H23', title: `${verdict === 'confirm' ? '確認' : '退回'}：${it.name}`, reason, status: 'failed', undo: [], message: String(err?.message ?? err).slice(0, 300) });
      }
    }
  }
}
