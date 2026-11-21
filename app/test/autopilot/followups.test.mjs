// WP6 留下的收尾（2.0.0 WP9 一併處理）：
// 1. 沒有來源的舊確認紀錄：晚於那台電腦開啟自動駕駛的時間 → 視為自動駕駛代為確認
// 2. 偏好區塊採用與還沒採用的項目（GET /api/autopilot/preferences）
// 3. 暫時忙碌（busy）連續 6 次之後等下一個每日排程
// 4. 一個項目動到的記憶數超過一輪的上限 → 送進保留區，不再永遠延後
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createJobs } from '../../src/agent/jobs.mjs';
import { init, open } from '../../src/core/index.mjs';
import { AUDIT_SCHEMA, CARDS_SCHEMA, CONFLICT_SCHEMA, CURATE_SCHEMA, DREAM_ANALYZE_SCHEMA, DREAM_PLAN_SCHEMA, REVIEW_SCHEMA, SECRET_SCHEMA } from '../../src/autopilot/prompts.mjs';
import { screen } from '../../src/autopilot/pipeline.mjs';
import { runAutopilot } from '../../src/autopilot/run.mjs';
import { updateMachineState } from '../../src/autopilot/state.mjs';
import { blobSha, reviewKey, reviewedIndex } from '../../src/core/review.mjs';
import { preferencesBlock } from '../../src/autopilot/prompts.mjs';
import { createApi } from '../../src/agent/api.mjs';
import { main } from '../../src/cli/main.mjs';
import { capture } from '../shell/helpers.mjs';
import { git, machinePaths, mkTmp, rmTmp, writeDriverCli } from '../core/helpers.mjs';

const HOUR = 3_600_000;

const KIND = new Map([[CURATE_SCHEMA, 'curate'], [REVIEW_SCHEMA, 'review'], [CARDS_SCHEMA, 'cards'], [CONFLICT_SCHEMA, 'conflict'], [SECRET_SCHEMA, 'secret'], [AUDIT_SCHEMA, 'audit'], [DREAM_ANALYZE_SCHEMA, 'analyze'], [DREAM_PLAN_SCHEMA, 'plan']]);
const EMPTY = { curate: { summary: '', items: [], dismiss: [] }, cards: { decisions: [] }, conflict: { decisions: [] }, secret: { decisions: [] }, audit: { decisions: [] }, analyze: { verified: [], contradicted: [], outdated: [], uncertain: [], older: [], new: [], corrections: [] }, plan: { summary: '', items: [] }, review: { verdicts: [] } };

/** 假的判斷器：依 schema 找處理函式 */
function fakeJudge(handlers = {}) {
  const calls = [];
  const judge = async ({ schema, prompt, model }) => {
    const kind = KIND.get(schema) ?? 'unknown';
    calls.push({ kind, prompt, model });
    const h = handlers[kind];
    const data = typeof h === 'function' ? await h(prompt, calls) : h ?? EMPTY[kind];
    return { ok: true, data, usage: { input: 1000, output: 100, costUsd: 0.01 }, ms: 1 };
  };
  judge.calls = calls;
  return judge;
}

const mem = ({ name, description, type = 'reference', body }) => `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;

describe('3. 暫時忙碌的重試有上限', () => {
  /** 假的排程：runAutopilot 依序回傳 results 裡的結果（'busy' 或 'ok'） */
  function setup(results) {
    const root = mkTmp();
    fs.writeFileSync(path.join(root, 'agent-jobs.json'), JSON.stringify({ jobs: { curate: { enabled: true } } }));
    const fakeEg = { settings: { get: async () => ({ autopilot: 'on' }) }, status: async () => ({}), paths: { vault: root, claudeHome: root } };
    let k = 0;
    const deps = {
      eg: fakeEg, paths: { jobsFile: path.join(root, 'agent-jobs.json'), dirty: path.join(root, 'dirty'), vault: root },
      events: { emit() {} }, log: { info() {}, warn() {}, error() {}, debug() {} }, notifier: { notify() {} },
      runProbe: async () => ({ checks: [] }), detectVersion: async () => null,
      runAutopilot: async () => {
        const r = results[Math.min(k++, results.length - 1)];
        return { ok: true, run: { id: 'ap-20261120-100000-abcd', status: 'done', summary: { changes: 0, rejected: 0, costUsd: 0, stopped: r === 'busy' ? 'busy' : null } } };
      },
      isIdle: async () => true,
    };
    const jobs = createJobs(deps);
    const info = () => jobs.list().find((j) => j.id === 'curate');
    return { root, jobs, info, deps };
  }

  test('前 5 次照 30 分鐘重試、不算執行過；第 6 次之後上次執行時間前進，等下一個每日排程', async () => {
    const { root, jobs, info } = setup(Array(6).fill('busy'));
    try {
      for (let i = 1; i <= 5; i++) {
        const t = Date.now();
        const r = await jobs.run('curate', 'schedule');
        assert.match(r.note, /暫時忙碌/);
        assert.equal(info().lastRunAt ?? null, null, `第 ${i} 次：不算執行過`);
        const next = Date.parse(info().nextRunAt);
        assert.ok(next >= t + 29 * 60_000 && next <= Date.now() + 31 * 60_000, `第 ${i} 次：30 分鐘後再試（${info().nextRunAt}）`);
      }
      const t = Date.now();
      const r = await jobs.run('curate', 'schedule');
      assert.match(r.note, /連續 6 次/);
      assert.ok(Date.parse(info().lastRunAt) >= t - 1000, '第 6 次：記為執行過');
      const next = Date.parse(info().nextRunAt);
      assert.ok(next >= t + 19 * HOUR, `等下一個每日排程（${info().nextRunAt}）`);
      await jobs.stop();
    } finally { rmTmp(root); }
  });

  test('中間有一次正常完成就重新計算；計數記在排程狀態檔（常駐程式重新啟動也接續）', async () => {
    const { root, jobs, info, deps } = setup(['busy', 'busy', 'busy', 'ok', 'busy', 'busy', 'busy', 'busy', 'busy', 'busy']);
    try {
      for (let i = 0; i < 4; i++) await jobs.run('curate', 'schedule');
      assert.ok(info().lastRunAt, '正常完成的那一輪記為執行過');
      const after = info().lastRunAt;
      for (let i = 0; i < 4; i++) await jobs.run('curate', 'schedule');
      assert.equal(info().lastRunAt, after, '重新計算：連續 4 次忙碌仍照 30 分鐘重試');
      await jobs.stop();
      // 重新啟動：沿用已經連續的次數（4），再 2 次就到上限
      const again = createJobs(deps);
      await again.run('curate', 'schedule');
      assert.equal(again.list().find((j) => j.id === 'curate').lastRunAt, after, '第 5 次');
      const r = await again.run('curate', 'schedule');
      assert.match(r.note, /連續 6 次/);
      assert.notEqual(again.list().find((j) => j.id === 'curate').lastRunAt, after, '第 6 次：記為執行過');
      await again.stop();
    } finally { rmTmp(root); }
  });
});

describe('4. 動到的記憶數超過一輪的上限：送進保留區，不再永遠延後', () => {
  let root;
  let eg;
  const names = ['note-a', 'note-b', 'note-c', 'note-d', 'note-e', 'note-f'];
  const ref = (n) => `global/${n}.md`;

  test('setup', async () => {
    root = mkTmp();
    const m = machinePaths(root, 'home');
    await init({ ...m, machineLabel: 'test-pc', userName: 'Tester', cli: writeDriverCli(root) });
    eg = await open(m);
    await eg.settings.set({ autopilot: 'on' });
    for (const n of names) await eg.memories.create({ scope: { kind: 'global' }, name: n, type: 'reference', description: `${n} desc`, body: `${n} body (2026-11-01).` });
    await eg.review.baseline();
  });

  /** 合併 5 筆＋改寫 1 筆：動到 6 筆記憶，超過這個記憶庫一輪的上限（至少 5 筆） */
  const bigItem = () => ({
    ref: ref('note-a'), action: 'merge', title: 'merge five notes and rewrite one', reason: 'duplicates',
    ops: [
      { op: 'merge', refs: names.slice(0, 5).map(ref), into: ref('note-a'), content: mem({ name: 'note-a', description: 'merged notes', body: names.slice(0, 5).map((n) => `${n} body (2026-11-01).`).join('\n') }) },
      { op: 'write', ref: ref('note-f'), content: mem({ name: 'note-f', description: 'note-f desc', body: 'note-f body (2026-11-01). more detail.' }) },
    ],
  });

  test('screen：一項超過一輪的上限 → 不送審、不延後，交給保留區並寫明原因', async () => {
    const snapshot = new Map();
    const { snap } = await import('../../src/autopilot/pipeline.mjs');
    for (const n of names) await snap(eg, snapshot, ref(n));
    const calls = [];
    const call = async (label) => { calls.push(label); return { ok: true, data: { verdicts: [] } }; };
    const held = [];
    const { approved, rejected } = await screen(call, [bigItem()], snapshot, { cap: 5, roundCap: 5, mid: eg.machine.id, hold: async (it, why) => { held.push(why); return 'hd-20261121-000000-abcd'; } });
    assert.equal(approved.length, 0);
    assert.equal(calls.length, 0, '不必花錢送審');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].deferred, undefined, '不是延後');
    assert.match(rejected[0].why, /超過自動處理的範圍，留給你決定/);
    assert.match(held[0] ?? '', /超過自動處理的範圍，留給你決定/);
  });

  test('整理：超過上限的項目存進保留區，這個範圍記為整理過（下一輪不再重新整理）', async () => {
    await updateMachineState(eg, (s) => { s.scopes = {}; return s; });
    const judge = fakeJudge({ curate: (p) => (p.includes('範圍：global') ? { summary: '', items: [bigItem()], dismiss: [] } : EMPTY.curate) });
    const r = await runAutopilot(eg, { judge, reason: 'test' });
    const x = r.run.rejected.find((y) => y.title === 'merge five notes and rewrite one');
    assert.ok(x, JSON.stringify(r.run.rejected));
    assert.equal(x.deferred, undefined);
    assert.ok(x.holding, '存進保留區');
    const h = await eg.holding.get(x.holding);
    assert.match(h.why, /超過自動處理的範圍，留給你決定/);
    assert.equal(h.ops.length, 2, '完整的動作都在');
    const again = fakeJudge({ curate: (p) => (p.includes('範圍：global') ? { summary: '', items: [bigItem()], dismiss: [] } : EMPTY.curate) });
    await runAutopilot(eg, { judge: again, reason: 'test' });
    assert.ok(!again.calls.some((c) => c.kind === 'curate' && c.prompt.includes('範圍：global')), '全域記為整理過：下一輪不再重新整理');
    for (const n of names) assert.match(fs.readFileSync(path.join(eg.paths.vault, 'global', `${n}.md`), 'utf8'), new RegExp(`${n} body`), '記憶沒有被改');
  });

  test('cleanup', () => rmTmp(root));
});

describe('1. 沒有來源的舊確認紀錄、2. 偏好區塊採用與還沒採用的項目', () => {
  let root;
  let eg;
  const OTHER = 'other-pc';
  const vf = (ref) => path.join(eg.paths.vault, ...ref.split('/'));
  const raw = (ref) => fs.readFileSync(vf(ref), 'utf8');
  /** 1.5／1.6 的確認紀錄：沒有 by（哪一台寫的由資料夾決定） */
  const writeLegacy = (mid, ref, at) => {
    const sha = blobSha(raw(ref));
    const dir = path.join(eg.paths.vault, 'machines', mid, 'reviewed');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${reviewKey(ref)}-${sha.slice(0, 12)}.json`), JSON.stringify({ ref, sha, at }));
    return sha;
  };
  const feedback = (name, description) => eg.memories.create({ scope: { kind: 'global' }, name, type: 'feedback', description, body: `${description}（2026-10-01 使用者要求）。\n\n**Why:** 使用者偏好。\n**How to apply:** 每次。` });

  test('setup', async () => {
    root = mkTmp();
    const m = machinePaths(root, 'home');
    await init({ ...m, machineLabel: 'test-pc', userName: 'Tester', cli: writeDriverCli(root) });
    eg = await open(m);
    await eg.review.baseline();
    await feedback('pref-early', '提交訊息用正體中文');
    await feedback('pref-late', '測試資料一律用假的名稱');
    await feedback('pref-other', '回覆先講結論');
    await feedback('pref-explicit', '日期寫絕對日期');
    await feedback('pref-new', '指令一次只跑一個');
  });

  test('1. 晚於這台開啟自動駕駛的時間 → 自動駕駛代為確認（不進偏好區塊）；更早的 → 使用者；有來源的不受影響', async () => {
    await updateMachineState(eg, (s) => { s.enabledAt = '2026-11-05T00:00:00.000Z'; return s; });
    const early = writeLegacy(eg.machine.id, 'global/pref-early.md', '2026-11-01T08:00:00.000Z');
    const late = writeLegacy(eg.machine.id, 'global/pref-late.md', '2026-11-10T08:00:00.000Z');
    await eg.review.confirm([{ ref: 'global/pref-explicit.md', sha: blobSha(raw('global/pref-explicit.md')) }], { by: 'user' });
    const idx = await reviewedIndex(eg.paths.vault);
    assert.ok(idx.get('global/pref-early.md').trusted.has(early), '開啟之前的舊紀錄：使用者');
    assert.ok(!idx.get('global/pref-late.md').trusted.has(late), '開啟之後的舊紀錄：自動駕駛');
    assert.ok(idx.get('global/pref-late.md').shas.has(late), '仍然算確認過（不會回到待你確認）');
    assert.ok(idx.get('global/pref-explicit.md').trusted.size > 0, '有來源的紀錄照舊');
    const pending = (await eg.review.list()).map((x) => x.ref);
    assert.ok(!pending.includes('global/pref-late.md') && !pending.includes('global/pref-early.md'));
    const block = await preferencesBlock(eg);
    assert.match(block, /pref-early（feedback）/);
    assert.ok(!block.includes('pref-late'), block);
  });

  test('1. 自動駕駛關閉後（enabledAt 被清掉），用記憶庫歷史裡第一次開啟的時間；看寫紀錄的那一台', async () => {
    // 另一台：2026-11-01 開啟過自動駕駛（狀態檔第一次提交的時間），之後關閉（enabledAt 清掉）
    const dir = path.join(eg.paths.vault, 'machines', OTHER);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'machine.json'), JSON.stringify({ id: OTHER, label: 'other', lastSeenAt: new Date().toISOString() }));
    fs.writeFileSync(path.join(dir, 'autopilot.json'), JSON.stringify({ v: 1, enabledAt: '2026-11-01T00:00:00.000Z' }));
    git(eg.paths.vault, 'add', '-A', `machines/${OTHER}`);
    git(eg.paths.vault, 'commit', '-q', '--date=2026-11-01T00:00:00Z', '-m', `engram(${OTHER}): autopilot on`);
    fs.writeFileSync(path.join(dir, 'autopilot.json'), JSON.stringify({ v: 1, enabledAt: null }));
    git(eg.paths.vault, 'add', '-A', `machines/${OTHER}`);
    git(eg.paths.vault, 'commit', '-q', '-m', `engram(${OTHER}): autopilot off`);
    // 另一台寫的紀錄（2026-11-03）：晚於另一台第一次開啟（11-01），早於這台的開啟時間（11-05）→ 依另一台判斷：自動駕駛
    const sha = writeLegacy(OTHER, 'global/pref-other.md', '2026-11-03T00:00:00.000Z');
    const idx = await reviewedIndex(eg.paths.vault);
    assert.ok(idx.get('global/pref-other.md').shas.has(sha));
    assert.ok(!idx.get('global/pref-other.md').trusted.has(sha), '另一台第一次開啟之後寫的：自動駕駛');
    // 之後又重新開啟（enabledAt 從重新開啟的時間算起）：仍以第一次開啟的時間為準
    fs.writeFileSync(path.join(dir, 'autopilot.json'), JSON.stringify({ v: 1, enabledAt: '2026-11-20T00:00:00.000Z' }));
    git(eg.paths.vault, 'add', '-A', `machines/${OTHER}`);
    git(eg.paths.vault, 'commit', '-q', '-m', `engram(${OTHER}): autopilot on`);
    assert.ok(!(await reviewedIndex(eg.paths.vault)).get('global/pref-other.md').trusted.has(sha), '重新開啟之後：仍是自動駕駛');
    assert.ok(!(await preferencesBlock(eg)).includes('pref-other'));
  });

  test('2. eg.autopilot.preferences：採用的項目（名稱、說明、確認來源）與還沒採用的（只有自動駕駛確認過或完全沒確認，附 ref 與 sha）', async () => {
    const r = await eg.autopilot.preferences();
    // 第三輪審查 B 多了 candidates（常用、還沒由使用者確認的其他記憶）
    assert.deepEqual(Object.keys(r).sort(), ['candidates', 'pending', 'used'], '和管理介面約定的形狀');
    const adopted = (ref) => r.used.find((x) => x.ref === ref);
    const pending = (ref) => r.pending.find((x) => x.ref === ref);
    assert.deepEqual(adopted('global/pref-early.md'), { ref: 'global/pref-early.md', name: 'pref-early', description: '提交訊息用正體中文', type: 'feedback', source: 'user' });
    assert.equal(adopted('global/pref-explicit.md')?.source, 'user');
    assert.equal(adopted('core/CORE.md')?.source, 'baseline', '核心準則：起點');
    assert.equal(adopted('core/CORE.md')?.type, 'core');
    assert.deepEqual(pending('global/pref-late.md'), { ref: 'global/pref-late.md', sha: blobSha(raw('global/pref-late.md')), name: 'pref-late', description: '測試資料一律用假的名稱', type: 'feedback', source: 'autopilot' });
    assert.equal(pending('global/pref-new.md')?.source, 'none', '完全沒確認過');
    assert.equal(pending('global/pref-other.md')?.source, 'autopilot');
    assert.ok(!adopted('global/pref-late.md') && !pending('global/pref-early.md'));
    // 和偏好區塊一致：採用的都在區塊裡，還沒採用的都不在
    const block = await preferencesBlock(eg);
    for (const x of r.used.filter((y) => y.type !== 'core')) assert.ok(block.includes(`${x.name}（`), x.ref);
    for (const x of r.pending) assert.ok(!block.includes(`${x.name}（`), x.ref);
    // 核心準則有自動駕駛代為確認的新版本：採用較早確認過的版本，新版本列在還沒採用
    const cur = raw('core/CORE.md');
    await eg.core.write(`${cur.replace(/\n*$/, '\n')}\n- 自動駕駛加上的一行規則。\n`, { reviewed: 'autopilot' });
    const r2 = await eg.autopilot.preferences();
    assert.equal(r2.used.find((x) => x.ref === 'core/CORE.md')?.version, 'previous');
    assert.deepEqual(r2.pending.find((x) => x.ref === 'core/CORE.md'), { ref: 'core/CORE.md', sha: blobSha(raw('core/CORE.md')), name: 'CORE.md', description: '', type: 'core', source: 'autopilot' });
  });

  test('2. GET /api/autopilot/preferences；用既有的 POST /api/review/confirm 確認之後就採用', async () => {
    const api = createApi({ eg, jobs: { run() {}, toggle() {} }, paths: { local: eg.paths.local, vault: eg.paths.vault, home: eg.paths.home }, info: { statusSummary: () => ({}) } });
    const get = () => api.handle('GET', '/api/autopilot/preferences', new URLSearchParams(), {});
    const r = await get();
    const late = r.pending.find((x) => x.ref === 'global/pref-late.md');
    assert.ok(late);
    await api.handle('POST', '/api/review/confirm', new URLSearchParams(), { items: [{ ref: late.ref, sha: late.sha }] });
    const after = await get();
    assert.equal(after.used.find((x) => x.ref === 'global/pref-late.md')?.source, 'user');
    assert.ok(!after.pending.some((x) => x.ref === 'global/pref-late.md'));
    assert.match(await preferencesBlock(eg), /pref-late（feedback）/);
  });

  test('自動駕駛的狀態：limit 是所有電腦裡還沒到期、重置時間最晚的用量上限（{ at, resetAt, machine }），都過了就是 null', async () => {
    const { autopilotStatus } = await import('../../src/autopilot/run.mjs');
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    assert.equal((await autopilotStatus(eg, { now })).limit, null);
    await updateMachineState(eg, (s) => { s.limit = { at: iso(now - 3_600_000), resetAt: iso(now + 3_600_000) }; return s; });
    const file = path.join(eg.paths.vault, 'machines', OTHER, 'autopilot.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), limit: { at: iso(now - 600_000), resetAt: iso(now + 2 * 3_600_000) } }));
    assert.deepEqual((await autopilotStatus(eg, { now })).limit, { at: iso(now - 600_000), resetAt: iso(now + 2 * 3_600_000), machine: OTHER });
    assert.deepEqual((await autopilotStatus(eg, { now: now + 2.5 * 3_600_000 })).limit, null, '都已經重置');
    assert.equal((await autopilotStatus(eg, { now: now + 1.5 * 3_600_000 })).limit.machine, OTHER);
    await updateMachineState(eg, (s) => { delete s.limit; return s; });
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), limit: undefined }));
  });

  test('2. CLI：engram autopilot preferences（--json 與文字）', async () => {
    const run = async (argv) => {
      const o = capture();
      const code = await main(argv, { loadEngine: async () => eg, stdout: o.stream, stderr: capture().stream, stdin: { isTTY: true }, cwd: root, env: {} });
      return { code, text: o.text };
    };
    const j = await run(['autopilot', 'preferences', '--json']);
    assert.equal(j.code, 0);
    const data = JSON.parse(j.text);
    assert.ok(Array.isArray(data.used) && Array.isArray(data.pending));
    assert.ok(data.pending.some((x) => x.ref === 'global/pref-new.md' && x.source === 'none'));
    const t = await run(['autopilot', 'preferences']);
    assert.match(t.text, /還沒採用/);
    assert.match(t.text, /global\/pref-new\.md/);
  });

  test('cleanup', () => rmTmp(root));
});
