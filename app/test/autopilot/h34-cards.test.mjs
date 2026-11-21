// 第二輪審查 #1(a)：H34（疑似同一個專案的合併建議）不交給自動駕駛：合併是無法只靠 commit 完整還原的結構性操作，
// 而且樣板 clone、fork、刻意分開的兩份 clone 都會符合條件，只留給使用者在收件匣決定。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JUDGED_CODES, judgedCards, ruleCards } from '../../src/autopilot/tasks/cards.mjs';

const card = {
  id: 'H34:abc1234567', code: 'H34', severity: 'medium', title: '「甲」可能和「乙」是同一個專案', detail: '相同的 git 遠端',
  refs: ['projects/jia', 'projects/yi'], pid: 'jia', fix: { action: 'link-projects', args: { from: 'jia', to: 'yi' }, label: '合併到「乙」' },
};

function fakeEngine() {
  const applied = [];
  const dismissed = [];
  return {
    applied, dismissed,
    paths: { local: 'C:\\unused', vault: 'C:\\unused\\vault' },
    apply: async (fix) => { applied.push(fix); return { ok: true }; },
    findings: { dismiss: async (id) => { dismissed.push(id); } },
    secrets: { preview: async () => ({ after: '' }) },
    history: async () => [],
    settings: { get: async () => ({}) },
  };
}

describe('H34 不交給自動駕駛', () => {
  test('JUDGED_CODES 不含 H34', () => {
    assert.ok(!JUDGED_CODES.includes('H34'));
    assert.deepEqual(JUDGED_CODES, ['H05', 'H18', 'H19']);
  });

  test('judgedCards：只有 H34 卡片時完全不呼叫模型、不套用；H34 不會被送進混合的判斷批次', async () => {
    const eg = fakeEngine();
    const prompts = [];
    const call = async (_name, { prompt }) => { prompts.push(prompt); return { ok: true, data: { decisions: [{ card: card.id, action: 'apply', fix: 1, reason: '同一個專案' }] } }; };
    const run = { actions: [], rejected: [], skipped: [], notes: [] };
    await judgedCards({ eg, call, run, feedback: [], now: Date.now(), findings: [card] });
    assert.equal(prompts.length, 0, '沒有可判斷的卡片就不問模型');
    assert.deepEqual(eg.applied, []);
    // 混著 H19：H19 照常判斷，H34 不出現在提示詞裡，即使模型回了 H34 的決定也不套用
    const h19 = { id: 'H19:1', code: 'H19', title: '可能屬於另一個資料夾', detail: 'x', refs: [], fixes: [{ label: '搬過去' }] };
    await judgedCards({ eg, call, run, feedback: [], now: Date.now(), findings: [card, h19] });
    assert.equal(prompts.length, 1);
    assert.ok(!prompts[0].includes('H34') && !prompts[0].includes('link-projects') && !prompts[0].includes(card.title), '提示詞裡沒有 H34 卡片');
    assert.ok(!eg.applied.some((f) => f.action === 'link-projects'), '模型回了 H34 的決定也不套用');
    assert.deepEqual(eg.dismissed, [], '也不會被判斷成忽略');
  });

  test('ruleCards（規則處理的卡片）也不碰 H34', async () => {
    const eg = fakeEngine();
    const run = { actions: [], rejected: [], skipped: [], notes: [] };
    await ruleCards({ eg, run, findings: [card], now: Date.now(), paused: [] });
    assert.deepEqual(eg.applied, []);
    assert.equal(run.actions.length, 0);
  });
});
