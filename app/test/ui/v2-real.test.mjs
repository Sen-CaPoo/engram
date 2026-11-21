// 管理介面 2.0.0 的展示資料和真的引擎形狀一致：介面讀的欄位，在暫存資料夾裡的真引擎（經過 createApi）與展示版都要有。
// 不會碰到真正的 ~/.engram 或 ~/.claude。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApi } from '../../src/agent/api.mjs';
import { init, open } from '../../src/core/index.mjs';
import { demoApi } from '../../src/ui/src/demo.js';
import { machinePaths, mkTmp, rmTmp, writeDriverCli } from '../core/helpers.mjs';

let root;
let eg;
let api;
const none = new URLSearchParams();
const call = (method, p, body = {}) => api.handle(method, p, none, body);
const missingKeys = (want, obj) => want.filter((k) => !(k in obj));
/** 展示版的另一個狀態變體（?compat=on 等）：展示版在載入時讀 location.search，所以換一個網址載入另一份模組 */
async function demoWith(search) {
  globalThis.location = { search };
  try { return (await import(`../../src/ui/src/demo.js?${search}`)).demoApi; } finally { delete globalThis.location; }
}

before(async () => {
  root = mkTmp();
  const m = machinePaths(root, 'home');
  await init({ ...m, machineLabel: '家裡電腦', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
  api = createApi({ eg, jobs: {}, paths: { local: eg.paths.local, home: eg.paths.home, vault: eg.paths.vault }, info: {} });
});
after(() => rmTmp(root));

describe('展示資料與真的引擎形狀一致', () => {
  test('環境設定同步：不會同步的項目（statusLine、會改變執行環境的環境變數、像金鑰的名稱）有 area、key、中英說明', async () => {
    fs.mkdirSync(path.join(eg.paths.vault, 'env'), { recursive: true });
    fs.writeFileSync(path.join(eg.paths.vault, 'env', 'profile.json'), JSON.stringify({ v: 1, env: { NODE_OPTIONS: '--inspect', SEARCH_API_KEY: 'x', BASH_DEFAULT_TIMEOUT_MS: '600000' }, settings: { statusLine: { type: 'command', command: 'echo hi' }, model: 'opus' }, skills: [], plugins: [] }));
    const real = await call('GET', '/api/env/plan');
    const demo = await demoApi.envPlan();
    for (const p of [real, demo]) {
      assert.deepEqual(missingKeys(['envSync', 'items', 'blocked', 'unused', 'disabledPlugins', 'changes', 'pending'], p), []);
      assert.deepEqual(missingKeys(['known', 'windowDays', 'plugins'], p.unused), []);
      assert.ok(Array.isArray(p.disabledPlugins));
    }
    const keys = real.blocked.map((b) => b.key).sort();
    assert.deepEqual(keys, ['NODE_OPTIONS', 'SEARCH_API_KEY', 'statusLine']);
    for (const b of [...real.blocked, ...demo.blocked]) {
      assert.ok(['setting', 'env', 'skill', 'plugin'].includes(b.area), `area：${b.area}`);
      assert.equal(typeof b.key, 'string');
      assert.equal(typeof b.message, 'string');
      assert.equal(typeof b.en?.message, 'string');
    }
    // 等待核可的項目有 hash 與 approved: false；值完整（to 是字串）
    const waiting = real.items.filter((i) => i.approved === false);
    assert.ok(waiting.length > 0);
    for (const i of [...waiting, ...demo.items.filter((x) => x.approved === false)]) {
      assert.equal(typeof i.hash, 'string');
      if (i.area !== 'skill') assert.equal(typeof i.to, 'string');
    }
    const prof = await call('GET', '/api/env/profile');
    assert.deepEqual(missingKeys(['present', 'profile', 'overrides', 'blocked'], prof), []);
    assert.deepEqual(missingKeys(['env', 'settings', 'skills', 'plugins', 'updatedAt', 'by'], prof.profile), []);
    assert.ok(Array.isArray(prof.overrides.skip));
  });

  test('情境召回：並行觀察的數字是數字', async () => {
    for (const r of [await call('GET', '/api/recall'), await demoApi.recall()]) {
      assert.deepEqual(missingKeys(['recall', 'recallForced', 'indexLayers', 'observe'], r), []);
      for (const k of ['global', 'machine']) {
        assert.equal(typeof r.observe.scopes[k].reference, 'number');
        assert.equal(typeof r.observe.scopes[k].bytes.off, 'number');
        assert.equal(typeof r.observe.scopes[k].bytes.on, 'number');
      }
      assert.equal(typeof r.observe.recalled, 'number');
      assert.equal(typeof r.observe.opened, 'number');
    }
  });

  test('護欄：規則的欄位一致（核可狀態、覆寫、命中、擋對、誤擋、太慢）', async () => {
    const want = ['id', 'tool', 'pattern', 'action', 'message', 'source', 'effective', 'approval', 'override', 'hits', 'blocks', 'hints', 'falseBlocks', 'confirmed', 'slow'];
    const real = await call('GET', '/api/guardrails');
    const demo = await demoApi.guardrails();
    for (const g of [real, demo]) {
      assert.deepEqual(missingKeys(['mode', 'source', 'rules', 'skipped', 'days', 'totals'], g), []);
      for (const r of g.rules) assert.deepEqual(missingKeys(want, r), [], r.id);
    }
    const t = await call('POST', '/api/guardrails/test', { command: 'git status' });
    assert.deepEqual(missingKeys(['verdict', 'matches', 'hints'], t), []);
  });

  test('保留區：項目的欄位一致', async () => {
    await eg.holding.add({ task: 'curate', kind: 'rejected', ref: 'global/x.md', title: '測試', reason: 'r', why: 'w', action: 'update', category: 'update', risk: 'medium', scope: 'global', ops: [{ op: 'write', ref: 'global/x.md', content: '---\nname: x\n---\n\nx\n' }] });
    const want = ['id', 'at', 'machine', 'task', 'kind', 'title', 'why', 'reason', 'action', 'risk', 'scope', 'ops', 'evidence', 'attempts', 'status', 'local', 'secret'];
    const [real] = await call('GET', '/api/holding');
    assert.deepEqual(missingKeys(want, real), []);
    for (const d of await demoApi.holding()) assert.deepEqual(missingKeys(want, d), [], d.id);
  });

  test('保留區：記憶畢業的提案（graduate 欄位與 guardrail／env／graduate 動作）', async () => {
    const demo = (await demoApi.holding()).filter((h) => h.task === 'graduate');
    assert.ok(demo.length > 0);
    // 用展示版的提案存進真的保留區，讀回來的欄位要和展示版一樣（正規化不會丟掉介面用的欄位）
    for (const d of demo) {
      const { id, at, machine, status, ...rest } = d;
      await eg.holding.add(rest);
    }
    const real = (await call('GET', '/api/holding')).filter((h) => h.task === 'graduate');
    assert.equal(real.length, demo.length);
    for (const r of real) {
      const d = demo.find((x) => x.title === r.title);
      assert.deepEqual(r.graduate, d.graduate, r.title);
      assert.deepEqual(r.ops.map((o) => [o.op, o.ref ?? null, o.to ?? null]), d.ops.map((o) => [o.op, o.ref ?? null, o.to ?? null]));
      assert.equal(r.category, d.category);
    }
  });

  test('自動駕駛：狀態有 limit；偏好的來源是代碼；每週摘要的偏好是筆數', async () => {
    const s = await call('GET', '/api/autopilot');
    assert.ok('limit' in s && 'limit' in await demoApi.autopilot());
    const prefs = await call('GET', '/api/autopilot/preferences');
    const want = ['ref', 'name', 'description', 'type', 'source'];
    for (const x of [...prefs.used, ...(await demoApi.autopilotPreferences()).used]) {
      assert.deepEqual(missingKeys(want, x), [], x.ref);
      assert.ok(['user', 'baseline', 'off', 'no-baseline'].includes(x.source), `${x.ref}：${x.source}`);
    }
    for (const x of [...prefs.pending, ...(await demoApi.autopilotPreferences()).pending]) {
      assert.deepEqual(missingKeys([...want, 'sha'], x), [], x.ref);
      assert.ok(['claude', 'request', 'autopilot', 'none'].includes(x.source), `${x.ref}：${x.source}`);
    }
    // 第三輪審查 B：候選（常用、但還沒由使用者本人確認的其他記憶）。真的引擎在這個暫存記憶庫裡沒有讀取紀錄，所以只比對有這個陣列；
    // 每筆的欄位以展示版對照 app/src/autopilot/prompts.mjs 的 confirmCandidates（ref、sha、name、description、type、scope、source、reads、recalled、graduation?）
    assert.ok(Array.isArray(prefs.candidates) && Array.isArray((await demoApi.autopilotPreferences()).candidates));
    for (const x of (await demoApi.autopilotPreferences()).candidates) assert.deepEqual(missingKeys(['ref', 'sha', 'name', 'description', 'type', 'scope', 'source', 'reads', 'recalled'], x), [], x.ref);
    const real = await call('GET', '/api/digest');
    const demo = await demoApi.digest();
    for (const d of [real, demo]) {
      assert.deepEqual(missingKeys(['week', 'learned', 'graduated', 'graduation', 'holding', 'preferences', 'guardrails', 'recall', 'env', 'autopilot', 'previous'], d), []);
      assert.deepEqual([typeof d.preferences.used, typeof d.preferences.pending, typeof d.preferences.candidates], ['number', 'number', 'number']);
      assert.deepEqual(missingKeys(['candidates', 'needsConfirm', 'unconfirmed'], d.graduation), []);
    }
  });

  test('收件匣的衝突：環境設定檔與護欄規則檔的紀錄帶 choices，展示版的紀錄與回傳形狀相同', async () => {
    const dir = path.join(eg.paths.vault, 'conflicts', 'cf_e1');
    fs.mkdirSync(dir, { recursive: true });
    const profile = (v) => `${JSON.stringify({ v: 1, env: { BASH_DEFAULT_TIMEOUT_MS: v }, settings: {}, skills: [], plugins: [], updatedAt: '2026-11-20T00:00:00.000Z', by: 'x' }, null, 2)}\n`;
    fs.writeFileSync(path.join(dir, 'ours.md'), profile('900000'));
    fs.writeFileSync(path.join(dir, 'theirs.md'), profile('1200000'));
    fs.writeFileSync(path.join(dir, 'base.md'), profile('600000'));
    // 第四輪審查 F-01：新的紀錄記下是哪台記的（recordedOn）；沒有這個欄位的舊紀錄只能「維持目前的值」（choices 只有 ours）
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: 'cf_e1', ref: 'env/profile.json', kind: 'content', createdAt: '2026-11-21T00:00:00.000Z', summary: '兩台電腦都改了環境設定檔的 BASH_DEFAULT_TIMEOUT_MS', en: { summary: 'Both computers changed BASH_DEFAULT_TIMEOUT_MS' }, recordedOn: eg.machine.id, otherMachine: 'other-pc-3m9x' }));
    const real = (await call('GET', '/api/conflicts')).find((c) => c.id === 'cf_e1');
    const demo = (await demoApi.conflicts()).find((c) => c.ref === 'env/profile.json');
    for (const c of [real, demo]) {
      assert.deepEqual(c.choices, ['theirs', 'ours']);
      // 第四輪審查 F-01：依觀點對調好的兩邊、兩邊是哪台、按鈕的說法（中英）
      assert.deepEqual(missingKeys(['view', 'sides', 'choiceLabels', 'otherMachine'], c), [], c.ref);
      assert.ok(['recorder', 'other', 'third'].includes(c.view), c.view);
      for (const k of ['ours', 'theirs']) assert.deepEqual(missingKeys(['machine', 'label'], c.sides[k]), [], `${c.ref} sides.${k}`);
      assert.deepEqual(Object.keys(c.choiceLabels).sort(), ['ours', 'theirs']);
      assert.deepEqual(Object.keys(c.en.choiceLabels).sort(), ['ours', 'theirs']);
      assert.ok(c.en.summary, 'en.summary');
      assert.deepEqual(missingKeys(['id', 'ref', 'kind', 'createdAt', 'ours', 'theirs', 'base', 'summary'], c), [], c.ref);
    }
    // 不適用的選項：兩邊都是 E_INVALID（附中英文說明），紀錄留著
    for (const resolve of [() => call('POST', '/api/conflicts/resolve', { id: 'cf_e1', choice: 'both' }), () => demoApi.resolveConflict(demo.id, 'manual', '{}')]) {
      await assert.rejects(resolve(), (e) => e.code === 'E_INVALID' && !!e.message && !!e.en?.message);
    }
    assert.ok((await call('GET', '/api/conflicts')).some((c) => c.id === 'cf_e1'));
    fs.rmSync(dir, { recursive: true, force: true });
    // 成功時的 changed、message、en.message 由後端測試（autopilot/review-round3.test.mjs）對真的引擎驗證；展示版回傳同樣的欄位
    const d = await demoApi.resolveConflict(demo.id, 'theirs');
    assert.deepEqual(missingKeys(['ok', 'ref', 'changed', 'message'], d), []);
    assert.ok(typeof d.en.message === 'string' && d.en.message);
  });
  test('索引相容模式：status 與 recall 都有 indexCompat；相容模式開著時有舊版的電腦與說明（中英），展示版相同', async () => {
    const shape = ['active', 'since', 'machines'];
    for (const c of [(await eg.status()).indexCompat, (await call('GET', '/api/recall')).indexCompat, (await demoApi.recall()).indexCompat, (await demoApi.status()).indexCompat]) {
      assert.deepEqual(missingKeys(shape, c), []);
      assert.equal(c.active, false);
      assert.deepEqual(c.machines, []);
    }
    // 真的引擎：記憶庫裡有一台版本低於 2.0.0、剛剛有活動的電腦
    const old = path.join(eg.paths.vault, 'machines', 'old-pc-1a2b');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'machine.json'), JSON.stringify({ id: 'old-pc-1a2b', label: 'Old PC', engramVersion: '1.6.0', lastSeenAt: new Date().toISOString() }));
    try {
      const real = (await call('GET', '/api/recall')).indexCompat;
      const demoOn = (await (await demoWith('?compat=on')).recall()).indexCompat;
      for (const c of [real, demoOn]) {
        assert.equal(c.active, true);
        assert.deepEqual(missingKeys(shape.concat('message'), c), []);
        assert.ok(c.message && c.en.message, '說明有中英文');
        assert.ok(c.machines.length === 1 && missingKeys(['mid', 'label', 'version', 'lastActiveAt'], c.machines[0]).length === 0);
      }
      assert.equal((await eg.status()).indexCompat.active, true);
      assert.equal((await (await demoWith('?compat=on')).status()).indexCompat.active, true);
    } finally { fs.rmSync(old, { recursive: true, force: true }); }
  });
});
