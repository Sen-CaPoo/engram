// 對話回顧重構（Q7）與學習訊號換來源（Q9，2.0.0 WP6）。自己的沙盒；LLM 一律用假的判斷器。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { encodeProjectPath } from '../../src/core/paths.mjs';
import { AUDIT_SCHEMA, CARDS_SCHEMA, CONFLICT_SCHEMA, CURATE_SCHEMA, DREAM_ANALYZE_SCHEMA, DREAM_PLAN_SCHEMA, REVIEW_SCHEMA, SECRET_SCHEMA } from '../../src/autopilot/prompts.mjs';
import { MODELS } from '../../src/autopilot/llm.mjs';
import { createCaller } from '../../src/autopilot/pipeline.mjs';
import { autopilotStatus, runAutopilot } from '../../src/autopilot/run.mjs';
import { allFeedback, pausedCategories, updateMachineState } from '../../src/autopilot/state.mjs';
import { judgedCards } from '../../src/autopilot/tasks/cards.mjs';
import { secretCards } from '../../src/autopilot/tasks/secrets.mjs';
import { machinePaths, makeRepo, mkTmp, rmTmp, writeDriverCli } from '../core/helpers.mjs';

const KIND = new Map([[CURATE_SCHEMA, 'curate'], [REVIEW_SCHEMA, 'review'], [CARDS_SCHEMA, 'cards'], [CONFLICT_SCHEMA, 'conflict'], [SECRET_SCHEMA, 'secret'], [AUDIT_SCHEMA, 'audit'], [DREAM_ANALYZE_SCHEMA, 'analyze'], [DREAM_PLAN_SCHEMA, 'plan']]);
const EMPTY = { curate: { summary: '', items: [], dismiss: [] }, cards: { decisions: [] }, conflict: { decisions: [] }, secret: { decisions: [] }, audit: { decisions: [] }, analyze: { verified: [], contradicted: [], outdated: [], uncertain: [], older: [], new: [], corrections: [] }, plan: { summary: '', items: [] }, review: { verdicts: [] } };
function fakeJudge(handlers = {}) {
  const calls = [];
  const judge = async ({ schema, prompt, model }) => {
    const kind = KIND.get(schema) ?? 'unknown';
    calls.push({ kind, prompt, model });
    const h = handlers[kind];
    const data = typeof h === 'function' ? await h(prompt, calls) : h ?? EMPTY[kind];
    if (data && data.__fail) return { ok: false, usage: { input: 0, output: 0, costUsd: 0 }, ms: 1, error: { code: data.__fail, message: data.message ?? 'x' } };
    return { ok: true, data, usage: { input: 1, output: 1, costUsd: 0.01 }, ms: 1 };
  };
  judge.calls = calls;
  return judge;
}

const DAY = 86_400_000;
let root; let m; let eg; let repo; let pid;
const vf = (ref) => path.join(eg.paths.vault, ...ref.split('/'));
const raw = (ref) => fs.readFileSync(vf(ref), 'utf8');
const ref = (name) => `projects/${pid}/memory/${name}.md`;
const today = () => new Date().toISOString().slice(0, 10);
const resetScopes = () => updateMachineState(eg, (s) => { s.scopes = {}; delete s.limit; return s; });
const TOPICS = Array.from({ length: 30 }, (_, i) => `第${i}類作業`);
const CORRECTION = '不是這樣，我說過部署前要先跑 stylelint，不要再跳過了';
/** 這一則的主題（about）照抄了原話：同步的紀錄只能記固定的說明 */
const CORRECTION2 = '不要再把測試資料寫進正式的資料庫了，我說過很多次';
let verifiedRecent;

/** 一段這台電腦的對話紀錄（三小時前） */
function writeSession(sid, recs) {
  const dir = path.join(m.claudeHome, 'projects', encodeProjectPath(repo));
  fs.mkdirSync(dir, { recursive: true });
  const at = (i) => new Date(Date.now() - 3 * 3600_000 + i * 1000).toISOString();
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, `${recs.map((x, i) => JSON.stringify({ cwd: repo, sessionId: sid, timestamp: at(i), ...x })).join('\n')}\n`);
  const t = new Date(Date.now() - 3 * 3600_000);
  fs.utimesSync(file, t, t);
}

before(async () => {
  root = mkTmp();
  m = machinePaths(root, 'home');
  await init({ ...m, machineLabel: 'T', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
  await eg.settings.set({ autopilot: 'on' });
  repo = makeRepo(path.join(root, 'work', 'portal'));
  pid = (await eg.identity.bind(repo, { create: { name: '入口網站' } })).pid;
  for (const [i, t] of TOPICS.entries()) {
    await eg.memories.create({ scope: { kind: 'project', pid }, name: `topic-${i}`, type: 'project', description: `${t}的做法`, body: `${t}：第 ${i} 號主題的細節。${'這是一段很長的說明文字，用來讓記憶全文變大。'.repeat(30)}\n\n**Why:** 專案慣例。\n**How to apply:** 開發時。` });
  }
  await eg.memories.create({ scope: { kind: 'project', pid }, name: 'lint-rule', type: 'project', description: '前端的 lint 設定', body: '前端用 stylelint 檢查樣式，設定檔在 .stylelintrc.json（2026-11-01 確認）。\n\n**Why:** 統一樣式。\n**How to apply:** 改樣式前。' });
  verifiedRecent = (await eg.memories.create({ scope: { kind: 'project', pid }, name: 'node-version', type: 'project', description: '專案用的 Node 版本', body: '專案用 Node 22（2026-10-01 確認）。\n\n**Why:** 相依套件要求。\n**How to apply:** 設定環境時。' })).ref;
  await eg.memories.write(verifiedRecent, { frontmatter: { 'metadata.engram.verified': new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10) } });
  await eg.review.baseline();
});
after(() => rmTmp(root));

describe('Q7 對話回顧重構', () => {
  let judge;
  before(async () => {
    writeSession('ee11ee11-0000-4000-8000-000000000001', [
      { type: 'user', message: { role: 'user', content: '幫我看一下 stylelint 的設定為什麼沒生效，專案還是用 Node 22 嗎？' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '設定檔 .stylelintrc.json 的路徑正確；Node 版本仍是 22。' }] } },
      { type: 'user', message: { role: 'user', content: CORRECTION } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '了解，之後部署前都會先跑 stylelint。Claude 說的這句話不能當成糾正。' }] } },
      { type: 'user', message: { role: 'user', content: CORRECTION2 } },
    ]);
    judge = fakeJudge({
      analyze: { ...EMPTY.analyze, verified: [{ ref: verifiedRecent, claim: 'Node 22', quote: '專案還是用 Node 22 嗎', date: today() }, { ref: ref('lint-rule'), claim: 'stylelint', quote: '設定檔 .stylelintrc.json 的路徑正確', date: today() }], corrections: [{ quote: CORRECTION, date: today(), about: '部署前要先跑 stylelint，不要跳過' }, { quote: 'Claude 說的這句話不能當成糾正', date: today(), about: '假的糾正' }, { quote: CORRECTION2, date: today(), about: CORRECTION2 }] },
      plan: { summary: '', items: [{ ref: verifiedRecent, action: 'verify', title: '確認 Node 版本仍正確', reason: '對話提到', evidence: [{ quote: '專案還是用 Node 22 嗎', date: today() }], ops: [{ op: 'verify', ref: verifiedRecent }] }] },
      review: (p) => ({ verdicts: p.split(/^## 項目 /m).slice(1).map((seg) => ({ id: seg.split('｜')[0].trim(), verdict: 'approve', reason: 'x' })) }),
    });
    await runAutopilot(eg, { judge, reason: 'test' });
  });

  test('Q7.1 逐段分析只附預篩出的相關記憶全文（最多 12 筆，加上對話讀過或寫過的），其餘只附名稱與說明', async () => {
    const a = judge.calls.find((c) => c.kind === 'analyze');
    assert.ok(a, '有分析呼叫');
    assert.ok(a.prompt.includes('設定檔在 .stylelintrc.json'), '相關的記憶附全文');
    const full = TOPICS.filter((t, i) => a.prompt.includes(`第 ${i} 號主題的細節`));
    assert.ok(full.length <= 11, `其餘的記憶不附全文（附了 ${full.length} 筆）`);
    const brief = TOPICS.filter((t) => a.prompt.includes(`${t}的做法`));
    assert.equal(brief.length, TOPICS.length, '每一筆至少有名稱與說明');
    const all = (await eg.memories.list({ pid })).reduce((n, x) => n + raw(x.ref).length, 0);
    assert.ok(a.prompt.length < all, `提示詞比所有記憶的全文還短（${a.prompt.length}／${all}）`);
  });

  test('Q7.2 30 天內確認過的記憶：送給彙整之前就濾掉 verified，提示詞說明不要只為了確認而提出；彙整硬提出的 verify 也不執行', () => {
    const p = judge.calls.find((c) => c.kind === 'plan');
    assert.ok(p);
    const findings = p.prompt.slice(p.prompt.indexOf('## 分析者找到的證據'));
    assert.ok(!findings.includes(verifiedRecent), '30 天內確認過的 verified 被濾掉');
    assert.ok(findings.includes(ref('lint-rule')), '其他的照常');
    assert.match(p.prompt, /不要提出只為了確認仍正確的項目/);
    const verified = String(raw(verifiedRecent).match(/verified: ['"]?([0-9-]+)/)?.[1]);
    assert.equal(verified, new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10), '驗證日期沒有被改');
  });

  test('Q9 糾正：出自使用者的才記下（同步的回饋紀錄只記固定的分類與雜湊，主題與原話只留在本機，第二輪審查 N2），不算復原、不會暫停任何類別', async () => {
    const fb = await allFeedback(eg.paths.vault);
    const cs = fb.filter((f) => f.kind === 'correction');
    assert.equal(cs.length, 2, JSON.stringify(cs));
    assert.deepEqual(cs.map((c) => c.title), ['（使用者的一則糾正；內容只記在發現它的那台電腦）', '（使用者的一則糾正；內容只記在發現它的那台電腦）']);
    const synced = fs.readFileSync(path.join(eg.paths.vault, 'machines', eg.machine.id, 'autopilot.json'), 'utf8');
    assert.ok(!synced.includes('我說過部署前') && !synced.includes('測試資料寫進正式'), '同步的檔案不含使用者的原話（主題照抄原話的也不含）');
    const local = fs.readFileSync(path.join(eg.paths.local, 'autopilot', 'corrections.json'), 'utf8');
    assert.ok(local.includes(CORRECTION) && local.includes(CORRECTION2), '原話只留在本機');
    assert.deepEqual(pausedCategories(fb), []);
    assert.ok(!(await autopilotStatus(eg)).feedback.some((f) => f.kind === 'correction'), '自動駕駛頁的復原紀錄不列糾正');
    // 同一則糾正再記一次（例如延後的對話批次重新分析）：不重複
    const { recordCorrections } = await import('../../src/autopilot/state.mjs');
    assert.equal(await recordCorrections(eg, [{ key: cs[0].key, about: '部署前要先跑 stylelint，不要跳過', date: today() }]), 0);
    assert.equal((await allFeedback(eg.paths.vault)).filter((f) => f.kind === 'correction').length, 2);
  });

  test('Q9 之後的整理與回顧彙整提示詞帶上最近的糾正（本機記下的原話；第三輪審查 N2 殘留：不帶主題）', async () => {
    await resetScopes();
    const j = fakeJudge();
    await runAutopilot(eg, { judge: j, reason: 'test' });
    const c = j.calls.find((x) => x.kind === 'curate');
    assert.ok(c, '有整理呼叫');
    assert.match(c.prompt, /參考資料：使用者在對話中糾正過 Claude 的事/);
    // 主題和原話共用超過 10 個字：本機也改用固定說明，原話照樣附上（第二輪審查 N2）
    assert.ok(c.prompt.includes(CORRECTION), '這台電腦的提示詞附上本機記下的原話');
    assert.ok(c.prompt.includes(CORRECTION2), '這台電腦的提示詞附上本機記下的原話');
    const { dreamPlanPrompt } = await import('../../src/autopilot/prompts.mjs');
    const dp = dreamPlanPrompt({ projectName: 'x', pid: 'p-1', memories: '', findings: [], others: [], feedback: [], corrections: [{ at: '2026-11-20T00:00:00Z', date: '2026-11-20', title: '主題文字', quote: '不要再跳過 lint 了，我說過很多次' }, { at: '2026-11-20T00:00:00Z', date: '2026-11-20', title: '沒有原話的主題' }] });
    assert.ok(dp.includes('使用者的原話：「不要再跳過 lint 了，我說過很多次」'), '帶原話');
    assert.ok(!dp.includes('主題文字') && !dp.includes('沒有原話的主題'), '不帶主題，沒有原話的不列');
  });
});

describe('Q7.3／Q7.4 簡單分類用較小的模型；執行紀錄有每種工作的呼叫次數與金額', () => {
  // 第二輪審查 N6：把真的金鑰判成不是金鑰的後果太重，卡片也沒有第二道把關；兩者用量本來就很小，改回主要模型
  test('收件匣卡片與疑似金鑰的判斷用主要模型（第二輪審查 N6）', async () => {
    const judge = fakeJudge({ secret: { __fail: 'E_LLM' } });
    const run = { calls: [], actions: [], rejected: [], skipped: [], notes: [] };
    const call = createCaller({ judge, local: eg.paths.local, run, budgetUsd: 10 });
    await judgedCards({ eg, call, run, feedback: [], now: Date.now(), findings: [{ id: 'h19-test', code: 'H19', title: '可能屬於另一個資料夾', detail: 'x', refs: [], fixes: [{ label: '搬過去' }] }] });
    const token = ['gh', 'p_', 'Z9y8X7w6V5'.repeat(4).slice(0, 36)].join('');
    fs.writeFileSync(vf('global/ci-note.md'), `---\nname: ci-note\ndescription: CI 的設定\nmetadata:\n  type: reference\n---\n\nCI 權杖：${token}\n`);
    await secretCards({ eg, call, run, findings: [{ id: 'h13-test', code: 'H13', refs: ['global/ci-note.md'] }] });
    fs.rmSync(vf('global/ci-note.md'), { force: true });
    assert.equal(judge.calls.find((c) => c.kind === 'cards')?.model, MODELS.main);
    assert.equal(judge.calls.find((c) => c.kind === 'secret')?.model, MODELS.main);
  });

  test('summary.callsByTask：每種工作的呼叫次數與約當金額', async () => {
    await resetScopes();
    const r = await runAutopilot(eg, { judge: fakeJudge(), reason: 'test' });
    const by = r.run.summary.callsByTask;
    assert.ok(by && by.curate?.calls >= 1, JSON.stringify(by));
    assert.equal(by.curate.costUsd, Math.round(by.curate.calls * 0.01 * 10000) / 10000);
    assert.equal(Object.values(by).reduce((n, x) => n + x.calls, 0), r.run.summary.calls);
    assert.ok(r.run.calls.every((c) => typeof c.task === 'string'));
  });
});
