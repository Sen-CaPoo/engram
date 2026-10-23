// 程序內排程器：牆上時鐘跳躍偵測、到期判斷、檔案監看的安靜期、同步失敗與健康檢查的通知、探測暫停、背景綁定。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import { createJobs, detectClockJump, lastDailySlot, nextDailySlot, TICK_MS } from '../../src/agent/jobs.mjs';
import { createPendingBinder, pendingBindings } from '../../src/agent/pending.mjs';
import { CliError } from '../../src/cli/errors.mjs';
import { createLogger } from '../../src/cli/log.mjs';
import { PAUSE_ON_FAIL, claudeArgs, pausedFrom } from '../../src/cli/probe/index.mjs';
import { createFakeEngine } from './fake-engine.mjs';
import { mkTmp, rmTmp, useHomes } from './helpers.mjs';

let root;
let paths;
before(() => {
  root = mkTmp();
  paths = useHomes(root);
});
after(() => rmTmp(root));
beforeEach(() => fs.rmSync(paths.local, { recursive: true, force: true }));
// 每個測試結束前等所有排程器寫完 agent-jobs.json，避免寫到下一個測試的檔案
const created = [];
afterEach(async () => {
  for (const j of created.splice(0)) await j.flush();
});

const T0 = new Date(2026, 9, 22, 11, 0, 0).getTime(); // 本地時間 2026-10-22 11:00（已過當天 09:30）

/** 建立排程器；預設把所有工作都標成剛跑過，避免測試互相干擾 */
function setup({ fresh = true, eg = createFakeEngine({ home: paths.home }), probe = null } = {}) {
  let now = T0;
  const emitted = [];
  const notified = [];
  if (fresh) {
    const ran = new Date(T0).toISOString();
    fs.mkdirSync(paths.local, { recursive: true });
    fs.writeFileSync(paths.jobsFile, JSON.stringify({
      jobs: Object.fromEntries(['sync', 'health', 'probe', 'curate'].map((id) => [id, { lastRunAt: ran }])),
      versionCheckedAt: ran,
      claudeVersion: '2.1.306',
      probe,
    }));
  }
  const jobs = createJobs({
    eg,
    paths,
    events: { emit: (name, data) => emitted.push({ name, data }) },
    log: createLogger(paths.logs, 'agent'),
    notifier: { notify: async (n) => notified.push(n) },
    runProbe: async () => ({ at: new Date(now).toISOString(), claudeVersion: '2.1.307', ok: false, checks: [{ id: 'C3', label: 'junction', ok: false, detail: 'x' }] }),
    detectVersion: async () => '2.1.306',
    now: () => now,
  });
  created.push(jobs);
  return { jobs, eg, emitted, notified, advance: (ms) => { now += ms; }, at: () => now };
}

const syncStarts = (emitted) => emitted.filter((e) => e.name === 'sync' && e.data.state === 'start').map((e) => e.data.reason);

describe('牆上時鐘跳躍', () => {
  test('偵測規則：比預期多 90 秒以上或時間倒退', () => {
    assert.equal(detectClockJump(0, TICK_MS), false);
    assert.equal(detectClockJump(0, TICK_MS + 90_000), false);
    assert.equal(detectClockJump(0, TICK_MS + 90_001), true);
    assert.equal(detectClockJump(0, 8 * 3_600_000), true);
    assert.equal(detectClockJump(100_000, 90_000), true);
    assert.equal(detectClockJump(100_000, 98_000), false);
  });

  test('睡眠恢復（計時器間隔變成 1 小時）→ 立刻同步', async () => {
    const { jobs, emitted, advance } = setup();
    await jobs.tick();
    advance(TICK_MS);
    await jobs.tick();
    assert.deepEqual(syncStarts(emitted), [], '正常間隔不應觸發同步');
    advance(3_600_000);
    await jobs.tick();
    assert.deepEqual(syncStarts(emitted), ['resume']);
    await jobs.flush();
  });
});

describe('到期判斷', () => {
  test('每日 09:30：最近一次與下一次', () => {
    const slot = new Date(lastDailySlot(T0));
    assert.equal(`${slot.getDate()} ${slot.getHours()}:${slot.getMinutes()}`, '22 9:30');
    const early = new Date(2026, 9, 22, 8, 0).getTime();
    assert.equal(new Date(lastDailySlot(early)).getDate(), 21);
    assert.equal(new Date(nextDailySlot(T0)).getDate(), 23);
  });

  test('從未執行過：同步、健康檢查、探測都到期；每週整理預設關閉', async () => {
    const { jobs, emitted } = setup({ fresh: false });
    const list = Object.fromEntries(jobs.list().map((j) => [j.id, j]));
    assert.equal(list.sync.nextRunAt, new Date(T0).toISOString());
    assert.equal(list.health.nextRunAt, new Date(T0).toISOString());
    assert.equal(list.curate.enabled, false);
    assert.equal(list.curate.nextRunAt, null);
    await jobs.tick();
    assert.deepEqual(syncStarts(emitted), ['schedule']);
    await jobs.flush();
  });

  test('健康檢查錯過 09:30 → 下次啟動補跑', async () => {
    fs.mkdirSync(paths.local, { recursive: true });
    fs.writeFileSync(paths.jobsFile, JSON.stringify({ jobs: { health: { lastRunAt: new Date(2026, 9, 21, 9, 30).toISOString() } } }));
    const { jobs } = setup({ fresh: false });
    assert.equal(jobs.list().find((j) => j.id === 'health').nextRunAt, new Date(T0).toISOString());
  });

  test('剛跑過：下次同步在 10 分鐘後、健康檢查在明天 09:30', () => {
    const { jobs } = setup();
    const list = Object.fromEntries(jobs.list().map((j) => [j.id, j]));
    assert.equal(list.sync.nextRunAt, new Date(T0 + 600_000).toISOString());
    assert.equal(list.health.nextRunAt, new Date(nextDailySlot(T0)).toISOString());
  });
});

describe('執行結果與通知', () => {
  test('每個工作記錄 lastRunAt 與 lastResult { ok, ms, note }', async () => {
    const { jobs } = setup();
    const r = await jobs.run('sync', 'manual');
    assert.equal(r.ok, true);
    assert.match(r.note, /同步完成/);
    const sync = jobs.list().find((j) => j.id === 'sync');
    assert.equal(sync.lastRunAt, new Date(T0).toISOString());
    assert.deepEqual(Object.keys(sync.lastResult), ['ok', 'ms', 'note', 'en']);
    // 管理介面切到英文時顯示 en
    assert.match(sync.lastResult.en.note, /Sync complete/);
    assert.deepEqual(Object.keys(sync.en), ['label', 'schedule']);
    assert.equal(sync.en.label, 'Network sync');
  });

  test('每個工作都有英文名稱與排程說明；結果備註附英文（失敗時依錯誤的英文訊息）', async () => {
    const { jobs, eg } = setup();
    for (const j of jobs.list()) {
      assert.ok(j.en.label && !/[一-鿿]/.test(j.en.label), j.id);
      assert.ok(j.en.schedule && !/[一-鿿]/.test(j.en.schedule), j.id);
    }
    // 引擎的失敗訊息有英文版時，備註也附英文；沒有時只有中文（介面退回中文）
    eg.sync = async () => ({ ok: false, state: 'offline', error: { code: 'E_OFFLINE', message: '連不到 GitHub', en: { message: 'Cannot reach GitHub' } } });
    const failed = await jobs.run('sync', 'manual');
    assert.equal(failed.ok, false);
    assert.equal(failed.note, 'E_OFFLINE：連不到 GitHub');
    assert.equal(failed.en.note, 'E_OFFLINE: Cannot reach GitHub');
    eg.sync = async () => ({ ok: false, state: 'offline', error: { code: 'E_OFFLINE', message: '連不到 GitHub' } });
    const noEn = await jobs.run('sync', 'manual');
    assert.equal(noEn.note, 'E_OFFLINE：連不到 GitHub');
    assert.equal(noEn.en, undefined);
    // 丟出的 CliError 也一樣
    eg.health = async () => { throw new CliError('E_INVALID', '參數錯誤').withEn('Invalid argument'); };
    const thrown = await jobs.run('health', 'manual');
    assert.equal(thrown.en.note, 'E_INVALID: Invalid argument');
  });

  test('舊版存檔的 lastResult 沒有 en 也能載入與顯示', () => {
    fs.mkdirSync(paths.local, { recursive: true });
    fs.writeFileSync(paths.jobsFile, JSON.stringify({ jobs: { sync: { lastRunAt: new Date(T0).toISOString(), lastResult: { ok: true, ms: 5, note: '同步完成：舊紀錄' } } } }));
    const { jobs } = setup({ fresh: false });
    const sync = jobs.list().find((j) => j.id === 'sync');
    assert.deepEqual(sync.lastResult, { ok: true, ms: 5, note: '同步完成：舊紀錄' });
    assert.equal(sync.en.label, 'Network sync');
  });

  test('1.0.0 存的探測結果沒有 en：依契約 id 補上英文名稱，不改中文', () => {
    const old = { at: new Date(T0).toISOString(), claudeVersion: '2.1.306', ok: true, checks: [{ id: 'C1', label: '舊的中文名稱', ok: true, detail: '' }, { id: 'C9', label: '不存在的契約', ok: true, detail: '' }] };
    const { jobs } = setup({ probe: old });
    const [c1, c9] = jobs.probe().checks;
    assert.equal(c1.label, '舊的中文名稱');
    assert.ok(c1.en.label && !/[一-鿿]/.test(c1.en.label));
    assert.equal(c9.en, undefined);
  });

  test('鎖被占用 → 不算失敗，1 分鐘後重試', async () => {
    const { jobs, eg } = setup();
    eg.sync = async () => ({ ok: false, state: 'locked', error: { code: 'E_LOCKED', message: '鎖' } });
    const r = await jobs.run('sync');
    assert.equal(r.ok, true);
    assert.equal(jobs.list().find((j) => j.id === 'sync').nextRunAt, new Date(T0 + 60_000).toISOString());
  });

  test('同步連續失敗超過 24 小時才通知，導向「裝置與同步」', async () => {
    const { jobs, eg, notified, advance } = setup();
    eg.sync = async () => ({ ok: false, state: 'offline', error: { code: 'E_OFFLINE', message: '連不到 GitHub' } });
    assert.equal((await jobs.run('sync')).ok, false);
    advance(23 * 3_600_000);
    await jobs.run('sync');
    assert.equal(notified.length, 0);
    advance(2 * 3_600_000);
    await jobs.run('sync');
    assert.deepEqual(notified.map((n) => [n.key, n.page]), [['sync-failed', 'devices']]);
    eg.sync = async () => ({ ok: true, state: 'ok', committed: 0, pulled: 0, pushed: false, conflicts: [], held: [], skipped: { recent: [], secrets: [] } });
    await jobs.run('sync');
    await jobs.flush();
    assert.equal(JSON.parse(fs.readFileSync(paths.jobsFile, 'utf8')).syncFailingSince, null);
  });

  test('健康檢查有高等級發現 → 通知並推送 finding 事件', async () => {
    const { jobs, notified, emitted } = setup();
    await jobs.run('health');
    assert.equal(notified.length, 1);
    assert.equal(notified[0].page, 'inbox');
    assert.equal(notified[0].key, 'health:H01:acme-gateway-3fa9k');
    assert.ok(emitted.some((e) => e.name === 'finding' && e.data.findings.length === 1));
  });

  test('探測失敗 → 依對照表暫停、通知導向「排程與紀錄」；C3 只停用 junction，背景綁定照常（R-52）', async () => {
    const { jobs, eg, notified } = setup();
    const r = await jobs.run('probe');
    assert.equal(r.ok, false);
    assert.deepEqual(jobs.paused(), ['junction']);
    assert.equal(jobs.claudeVersion(), '2.1.307');
    assert.equal(notified[0].page, 'schedule');
    assert.doesNotMatch((await jobs.run('bind')).note, /已暫停/);
    assert.equal(eg.calls.filter((c) => c.name === 'identity.reconcile').length, 1, '背景綁定先依權限模式對齊既有綁定');
  });

  test('R-52：權限模式或 junction 暫停狀態改變時，tick 觸發背景綁定重新對齊；沒變就不觸發', async () => {
    const { jobs, eg, advance } = setup();
    const reconciles = () => eg.calls.filter((c) => c.name === 'identity.reconcile').length;
    await jobs.run('bind');
    assert.equal(reconciles(), 1);
    advance(60_000);
    await jobs.tick();
    await jobs.flush();
    assert.equal(reconciles(), 1, '模式沒變、沒有待切換的綁定 → 不觸發');
    await jobs.run('probe'); // C3 失敗 → 停用 junction，模式改變
    advance(60_000);
    await jobs.tick();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(reconciles(), 2, '停用 junction 後重新對齊');
  });

  test('R-49：只在目前版本還沒有探測結果時執行，不每天重跑', async () => {
    const probeJob = (jobs) => jobs.list().find((j) => j.id === 'probe');
    // 目前版本已有結果：沒有下次時間（依事件觸發）
    const same = setup({ probe: { claudeVersion: '2.1.306', ok: true, checks: [] } });
    same.advance(3 * 24 * 3600_000);
    assert.equal(probeJob(same.jobs).nextRunAt, null);
    // 結果是舊版本的（例如改版後）：立即執行；剛失敗過則至少隔一小時
    const old = setup({ probe: { claudeVersion: '2.1.305', ok: true, checks: [] } });
    assert.equal(Date.parse(probeJob(old.jobs).nextRunAt), T0 + 3600_000);
    old.advance(3600_000);
    assert.equal(Date.parse(probeJob(old.jobs).nextRunAt), old.at());
  });

  test('R-49：探測的 claude 不載入 MCP 與使用者層設定，只保留 local 層', () => {
    for (const argv of [claudeArgs(), claudeArgs({ tools: true, mode: 'acceptEdits' })]) {
      assert.equal(argv[argv.indexOf('--setting-sources') + 1], 'local');
      assert.ok(argv.includes('--strict-mcp-config'));
      assert.deepEqual(JSON.parse(argv[argv.indexOf('--mcp-config') + 1]), { mcpServers: {} });
      assert.equal(argv[argv.indexOf('--model') + 1], 'haiku');
    }
  });

  test('C5 失敗時同步帶 normalize: false', async () => {
    const { jobs, eg } = setup({ probe: { ok: false, checks: [{ id: 'C5', ok: false }] } });
    await jobs.run('sync');
    assert.deepEqual(eg.calls.find((c) => c.name === 'sync').args[0], { network: true, normalize: false });
  });

  test('開關存進 agent-jobs.json，重新啟動後沿用', async () => {
    const a = setup();
    a.jobs.toggle('watch', false);
    await a.jobs.flush();
    const b = setup({ fresh: false });
    assert.equal(b.jobs.list().find((j) => j.id === 'watch').enabled, false);
    assert.throws(() => a.jobs.toggle('nope', true), (e) => e.code === 'E_NOT_FOUND');
  });
});

describe('檔案監看', () => {
  test('vault 變更：1 秒內合併成 change 事件；安靜 30 秒後本機 commit；.git 內的變更忽略', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { jobs, eg, emitted } = setup();
      jobs.onVaultChange('.git\\index');
      assert.equal(jobs.list().find((j) => j.id === 'watch').nextRunAt, null);
      jobs.onVaultChange('global\\a.md');
      jobs.onVaultChange('global\\b.md');
      mock.timers.tick(1000);
      assert.deepEqual(emitted.find((e) => e.name === 'change').data.paths, ['global/a.md', 'global/b.md']);
      mock.timers.tick(25_000);
      jobs.onVaultChange('global\\c.md'); // 又有變更：重新計時
      mock.timers.tick(29_000);
      assert.equal(eg.calls.filter((c) => c.name === 'sync').length, 0);
      mock.timers.tick(1000);
      assert.deepEqual(eg.calls.filter((c) => c.name === 'sync').map((c) => c.args[0]), [{ network: false }]);
    } finally {
      mock.timers.reset();
    }
  });
});

describe('相容性探測的暫停對照', () => {
  test('C2 暫停綁定與 junction；C3 只停用 junction（R-52）；C4 只通知；C5 暫停補回欄位', () => {
    assert.deepEqual(PAUSE_ON_FAIL, { C2: ['bind', 'junction'], C3: ['junction'], C4: [], C5: ['normalize'] });
    assert.ok(Object.isFrozen(PAUSE_ON_FAIL));
    const probe = (ids) => ({ checks: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'].map((id) => ({ id, ok: !ids.includes(id) })) });
    assert.deepEqual(pausedFrom(probe(['C4', 'C1', 'C6', 'C7'])), []);
    assert.deepEqual(pausedFrom(probe(['C3'])), ['junction']);
    assert.deepEqual(pausedFrom(probe(['C2', 'C5'])), ['bind', 'junction', 'normalize']);
    assert.deepEqual(pausedFrom(null), []);
  });
});

describe('背景綁定（引擎標為 pending 的綁定）', () => {
  function writePending(eg, encoded, extra = {}) {
    const dir = path.join(eg.paths.vault, 'machines', eg.machine.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bindings.json'), JSON.stringify({
      [encoded]: { pid: 'p1', path: 'C:\\proj', method: 'junction', state: 'pending', ...extra },
      'other-enc': { pid: 'p2', path: 'C:\\done', method: 'junction', state: 'active' },
    }));
  }
  function transcript(eg, encoded, ageMs) {
    const dir = path.join(eg.paths.claudeHome, 'projects', encoded);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 's1.jsonl');
    fs.writeFileSync(f, '{"cwd":"C:\\\\proj","sessionId":"s1"}\n');
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(f, t, t);
  }

  test('對話進行中（30 分鐘內）不切換；結束後呼叫 bind(path, { pid }, { mode: "safe" })', async () => {
    const eg = createFakeEngine({ home: path.join(root, 'pb', '.engram') });
    writePending(eg, 'C--proj');
    assert.deepEqual((await pendingBindings(eg)).map((b) => b.encoded), ['C--proj']);
    transcript(eg, 'C--proj', 5 * 60_000);
    const binder = createPendingBinder({ eg });
    let r = await binder.run();
    assert.equal(r.waiting[0].reason, 'active-session');
    assert.equal(eg.calls.filter((c) => c.name === 'identity.bind').length, 0);
    transcript(eg, 'C--proj', 31 * 60_000);
    r = await binder.run();
    assert.equal(r.done.length, 1);
    assert.deepEqual(eg.calls.find((c) => c.name === 'identity.bind').args, ['C:\\proj', { pid: 'p1' }, { mode: 'safe' }]);
  });

  test('引擎仍回報 pending 或失敗 → 退避，不會每分鐘重複呼叫', async () => {
    const eg = createFakeEngine({ home: path.join(root, 'pb2', '.engram') });
    writePending(eg, 'C--proj2');
    eg.identity.bind = async (...args) => {
      eg.calls.push({ name: 'identity.bind', args });
      return { ok: true, pid: 'p1', state: 'pending', deferredReason: 'busy' };
    };
    const binder = createPendingBinder({ eg });
    const t = Date.now();
    await binder.run({ now: t });
    const second = await binder.run({ now: t + 30_000 });
    assert.equal(second.waiting[0].reason, 'backoff');
    await binder.run({ now: t + 61_000 });
    assert.equal(eg.calls.filter((c) => c.name === 'identity.bind').length, 2);
  });

  test('SW-2：匯入計畫產生後來源又有變更（changed-since-plan）→ 不自動接上，留給使用者重新規劃', async () => {
    const eg = createFakeEngine({ home: path.join(root, 'pb4', '.engram') });
    writePending(eg, 'C--proj4', { reason: 'changed-since-plan' });
    transcript(eg, 'C--proj4', 2 * 3600_000);
    const r = await createPendingBinder({ eg }).run();
    assert.deepEqual(r.waiting.map((w) => w.reason), ['changed-since-plan']);
    assert.equal(eg.calls.filter((c) => c.name === 'identity.bind').length, 0);
  });

  test('設定檔備援的鍵（編碼@雜湊）取出正確的編碼資料夾', async () => {
    const eg = createFakeEngine({ home: path.join(root, 'pb3', '.engram') });
    writePending(eg, 'C--x@ab12cd34', { method: 'settings' });
    assert.deepEqual((await pendingBindings(eg)).map((b) => [b.key, b.encoded]), [['C--x@ab12cd34', 'C--x']]);
  });
});

describe('撞名資料夾改名（SW-4）', () => {
  const engineWith = (mode, renamed) => {
    const eg = createFakeEngine({ home: paths.home });
    const calls = [];
    eg.settings = { get: async () => ({ bindAuto: 'confident', collisionRename: mode }), set: async () => ({}) };
    eg.collisions = { apply: async (o) => { calls.push(o); return { ok: true, id: 'rn-1', renamed, skipped: [{ path: 'C:/x/丙丁', reason: 'contains-projects' }], retired: [] }; } };
    return { eg, calls };
  };

  test('設定為自動：改名、發通知與 change 事件；每小時一次', async () => {
    const { eg, calls } = engineWith('auto', [{ from: 'C:/Users/x/Desktop/甲方報告', to: 'C:/Users/x/Desktop/甲方報告-k3fz' }]);
    const { jobs, notified, emitted } = setup({ eg });
    const r = await jobs.run('rename', 'manual');
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.match(r.note, /改名 1、暫不改名 1/);
    assert.ok(notified.some((n) => /甲方報告 → 甲方報告-k3fz/.test(n.body) && n.page === 'devices'));
    assert.ok(emitted.some((x) => x.name === 'change' && x.data.kind === 'rename'));
    const info = jobs.list().find((j) => j.id === 'rename');
    assert.equal(Date.parse(info.nextRunAt) - Date.parse(info.lastRunAt), 3_600_000);
  });

  test('設定為詢問或關閉：不改名', async () => {
    for (const mode of ['ask', 'off']) {
      const { eg, calls } = engineWith(mode, []);
      const { jobs, notified } = setup({ eg });
      const r = await jobs.run('rename', 'manual');
      assert.equal(calls.length, 0, mode);
      assert.equal(notified.length, 0);
      assert.match(r.note, mode === 'ask' ? /收件匣/ : /關閉/);
    }
  });
});
