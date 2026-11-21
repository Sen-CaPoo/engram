// 第二輪審查 R4：2.0 新增的同步 JSON 衝突時，兩邊的內容都要留下，也不交給 LLM。
// - guardrails/rules.json：以規則 id 聯集（同一個 id 兩邊改得不同時留 addedAt 較新的）
// - env/profile.json：逐鍵合併（只有一邊有的保留；兩邊都改而值不同時留 updatedAt 較新的那一邊，另一邊的值記進衝突隔離區）
// - 自動駕駛的衝突任務遇到 env/、guardrails/、holding/、settings.json、release.json 的衝突不處理，留給使用者
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { mergeProfileJson, mergeRulesJson } from '../../src/core/jsonmerge.mjs';
import { resolveConflicts } from '../../src/autopilot/tasks/conflicts.mjs';
import { ageTree, machinePaths, makeBareRemote, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

const rule = (id, o = {}) => ({ id, tool: 'Bash', pattern: `zz${id.replace(/[^a-z0-9]/g, '')}\\s+--x`, flags: '', unless: '', action: 'hint', message: `${id} message`, source: 'global/x.md', addedAt: '2026-11-20', by: 'autopilot', ...o });
const rules = (list, extra = {}) => `${JSON.stringify({ v: 1, defaults: true, ...extra, rules: list }, null, 2)}\n`;
const profile = (env, o = {}) => `${JSON.stringify({ v: 1, env, settings: {}, skills: [], plugins: [], updatedAt: '2026-11-20T00:00:00.000Z', by: 'a', ...o }, null, 2)}\n`;

describe('合併函式', () => {
  test('rules.json：兩邊各加的規則都留下；同一個 id 兩邊都改時留 addedAt 較新的；一邊刪掉、另一邊沒動的就刪；兩邊算出來一樣', () => {
    const base = rules([rule('keep'), rule('gone')]);
    const ours = rules([rule('keep'), rule('gone'), rule('from-a')]);
    const theirs = rules([rule('keep'), rule('from-b')]);
    const a = JSON.parse(mergeRulesJson(ours, theirs, base));
    assert.deepEqual(a.rules.map((r) => r.id), ['keep', 'from-a', 'from-b']);
    assert.equal(a.defaults, true);
    assert.equal(mergeRulesJson(theirs, ours, base), mergeRulesJson(ours, theirs, base), '兩台各自合併得到同一份');
    const o2 = rules([rule('keep', { message: 'older edit', addedAt: '2026-11-19' })]);
    const t2 = rules([rule('keep', { message: 'newer edit', addedAt: '2026-11-21' })]);
    assert.equal(JSON.parse(mergeRulesJson(o2, t2, base)).rules.find((r) => r.id === 'keep').message, 'newer edit');
    assert.equal(mergeRulesJson('{ broken', theirs, base), theirs, '一邊讀不懂就留另一邊');
    assert.equal(mergeRulesJson('{ broken', 'nope', base), null);
  });

  test('profile.json：逐鍵合併；兩邊都改而值不同時留 updatedAt 較新的那一邊，回報輸的那一邊；技能與外掛取聯集（刪掉的照刪）', () => {
    const base = profile({ SHARED: '1', DROP: 'x' }, { skills: ['s-old'], plugins: [{ name: 'p1', marketplace: 'm' }] });
    const ours = profile({ SHARED: '1', DROP: 'x', FROM_A: 'a', BOTH: 'from-a' }, { updatedAt: '2026-11-20T01:00:00.000Z', by: 'pc-a', skills: ['s-old', 's-a'], plugins: [{ name: 'p1', marketplace: 'm' }] });
    const theirs = profile({ SHARED: '1', FROM_B: 'b', BOTH: 'from-b' }, { updatedAt: '2026-11-20T02:00:00.000Z', by: 'pc-b', skills: ['s-b'], plugins: [{ name: 'p1', marketplace: 'm' }, { name: 'p2', marketplace: 'm' }] });
    const r = mergeProfileJson(ours, theirs, base);
    const p = JSON.parse(r.text);
    assert.deepEqual(p.env, { BOTH: 'from-b', FROM_A: 'a', FROM_B: 'b', SHARED: '1' }, 'DROP 被 theirs 刪掉、ours 沒動：刪');
    assert.deepEqual(p.skills, ['s-a', 's-b'], 's-old 被 theirs 刪掉');
    assert.deepEqual(p.plugins.map((x) => x.name), ['p1', 'p2']);
    assert.equal(p.updatedAt, '2026-11-20T02:00:00.000Z');
    assert.deepEqual(r.losers, [{ area: 'env', key: 'BOTH', value: 'from-a' }]);
    assert.equal(mergeProfileJson(theirs, ours, base).text, r.text, '兩台各自合併得到同一份');
  });
});

describe('兩台電腦同時新增規則與環境變數', () => {
  test('同步之後兩邊的內容都在兩台；值不同的那一個記進衝突隔離區；自動駕駛的衝突任務不處理、不送 LLM', async () => {
    const r0 = mkTmp();
    try {
      const cliPath = writeDriverCli(r0);
      const remote = makeBareRemote(path.join(r0, 'remote.git'));
      const mA = machinePaths(r0, 'office');
      const mB = machinePaths(r0, 'home');
      await init({ ...mA, machineLabel: 'A', remote, cli: cliPath });
      const A = await open(mA);
      await A.sync();
      await init({ ...mB, machineLabel: 'B', remote, cli: cliPath });
      const B = await open(mB);
      await B.sync();
      await A.sync();
      await A.guardrails.add(rule('mem-from-a'));
      await A.env.set('FROM_A_MODE', '1');
      await A.env.set('BOTH_MODE', 'a');
      await B.guardrails.add(rule('mem-from-b'));
      await B.env.set('FROM_B_MODE', '2');
      await new Promise((r) => setTimeout(r, 20));
      await B.env.set('BOTH_MODE', 'b');
      ageTree(A.paths.vault); ageTree(B.paths.vault);
      await A.sync(); ageTree(B.paths.vault);
      await B.sync(); ageTree(A.paths.vault);
      await A.sync();
      for (const X of [A, B]) {
        const ids = (await X.guardrails.list()).rules.map((x) => x.id);
        assert.ok(ids.includes('mem-from-a') && ids.includes('mem-from-b'), `兩條規則都在：${ids}`);
        const env = JSON.parse(fs.readFileSync(path.join(X.paths.vault, 'env', 'profile.json'), 'utf8')).env;
        assert.equal(env.FROM_A_MODE, '1');
        assert.equal(env.FROM_B_MODE, '2');
        assert.equal(env.BOTH_MODE, 'b', '值不同：留較新的那一邊');
      }
      const list = (await B.conflicts.list()).filter((c) => c.ref === 'env/profile.json');
      assert.equal(list.length, 1, '輸的那一邊的值記進衝突隔離區');
      assert.ok(!(await B.conflicts.list()).some((c) => c.ref === 'guardrails/rules.json'), '規則檔沒有衝突紀錄');
      // 自動駕駛的衝突任務：不送 LLM、不刪紀錄，留給使用者
      const labels = [];
      const call = async (label) => { labels.push(label); return { ok: true, data: { decisions: [] } }; };
      call.state = {};
      const run = { actions: [], skipped: [], rejected: [], notes: [] };
      await resolveConflicts({ eg: B, call, run, paused: [], preferences: '' });
      assert.ok(!labels.includes('同步衝突'), '不送 LLM');
      assert.equal((await B.conflicts.list()).filter((c) => c.ref === 'env/profile.json').length, 1, '紀錄留著');
      assert.ok(run.skipped.some((x) => /env\/profile\.json/.test(x.why)), JSON.stringify(run.skipped));
    } finally { rmTmp(r0); }
  });
});
