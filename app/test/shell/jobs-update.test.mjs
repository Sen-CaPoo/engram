// R2 自動更新的排程工作 update：每天一次、延後與重試的間隔、不在同步或自動駕駛進行中時跑、結果與通知的轉達。
// 更新本身（git、部署、doctor）見 test/install/autoupdate.test.mjs；這裡注入假的 autoUpdate 與 restartAgent。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { createJobs, JOB_DEFS, TICK_MS } from '../../src/agent/jobs.mjs';
import { createLogger, readLogs } from '../../src/cli/log.mjs';
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
const created = [];
afterEach(async () => {
  for (const j of created.splice(0)) await j.stop();
});

const T0 = new Date(2026, 11, 1, 11, 30, 0).getTime(); // 本地時間 2026-12-01 11:30（已過當天 11:00 的排程）
const MIN = 60_000;

/** results：每次呼叫 autoUpdate 依序回傳的結果；呼叫的參數記在 calls */
function setup({ results = [], eg = createFakeEngine({ home: paths.home }), isIdle = async () => true, paused = false, runAutopilot, autoUpdateImpl } = {}) {
  let now = T0;
  const calls = [];
  const notified = [];
  const restarts = [];
  const ran = new Date(T0).toISOString();
  fs.mkdirSync(paths.local, { recursive: true });
  fs.writeFileSync(paths.jobsFile, JSON.stringify({
    jobs: Object.fromEntries(['sync', 'health', 'probe', 'curate', 'gc', 'env', 'rename'].map((id) => [id, { lastRunAt: ran }])),
    versionCheckedAt: ran,
    claudeVersion: '2.1.306',
  }));
  const queue = [...results];
  const jobs = createJobs({
    eg,
    paths,
    events: { emit() {} },
    log: createLogger(paths.logs, 'agent'),
    notifier: { notify: async (n) => notified.push(n) },
    runProbe: async () => ({ at: new Date(now).toISOString(), claudeVersion: '2.1.306', ok: true, checks: [] }),
    detectVersion: async () => '2.1.306',
    settings: { syncEveryMs: () => 10 * MIN, healthAt: () => ({ hour: 9, minute: 30 }), paused: () => paused, writePaused: async () => {} },
    now: () => now,
    isIdle,
    ...(runAutopilot ? { runAutopilot } : {}),
    autoUpdate: async (o) => { calls.push(o); if (autoUpdateImpl) return autoUpdateImpl(o); return queue.shift() ?? { status: 'current', code: 'current', reason: '已經是最新版', en: { reason: 'Already up to date' } }; },
    restartAgent: () => restarts.push(now),
  });
  created.push(jobs);
  return { jobs, eg, calls, notified, restarts, advance: (ms) => { now += ms; }, at: () => now };
}
const info = (jobs) => jobs.list().find((j) => j.id === 'update');

describe('工作定義', () => {
  test('update：預設啟用、有中英文名稱與排程說明', () => {
    assert.equal(JOB_DEFS.update.enabled, true);
    assert.match(JOB_DEFS.update.label, /自動更新/);
    assert.equal(JOB_DEFS.update.en.label, 'Automatic update');
    assert.match(JOB_DEFS.update.en.schedule, /every day/i);
    assert.deepEqual(Object.keys(JOB_DEFS).at(-1), 'update');
  });
});

describe('排程：每天一次', () => {
  test('到了就跑一次（帶著設定、家目錄與可注入的相依）；當天不再跑；隔天 11:00 之後再跑', async () => {
    const eg = createFakeEngine({ home: paths.home });
    eg.settings.get = async () => ({ autoUpdate: 'off' });
    const { jobs, calls, advance } = setup({ eg });
    await jobs.tick();
    await jobs.flush();
    assert.equal(calls.length, 1, '從沒跑過：第一次 tick 就跑');
    assert.equal(calls[0].home, paths.home);
    assert.equal(calls[0].autoUpdate, 'off', '設定交給 runAutoUpdate 判斷');
    assert.equal(typeof calls[0].busy, 'function');
    assert.equal(typeof calls[0].notify, 'function');
    assert.equal(typeof calls[0].restartAgent, 'function');
    assert.ok(Date.parse(info(jobs).lastRunAt) > 0);
    // 時間跳太多會被當成剛從睡眠恢復而啟動一次同步；同步結束後再多一個 tick 才輪到 update
    const settle = async () => { await jobs.tick(); await new Promise((r) => setTimeout(r, 30)); await jobs.flush(); advance(TICK_MS); await jobs.tick(); await jobs.flush(); };
    advance(TICK_MS);
    await settle();
    advance(5 * 3600_000);
    await settle();
    assert.equal(calls.length, 1, '當天不再跑');
    assert.equal(new Date(Date.parse(info(jobs).nextRunAt)).getHours(), 11, '下一次是隔天 11:00');
    advance(24 * 3600_000);
    await settle();
    assert.equal(calls.length, 2);
  });

  test('設定沒有 autoUpdate 時預設 on；使用者暫停 Engram 時不跑', async () => {
    const a = setup();
    await a.jobs.tick();
    assert.equal(a.calls[0].autoUpdate, 'on');
    await a.jobs.stop(); // 還在背景寫 agent-jobs.json 的排程器要先停掉，不然會蓋掉下一個排程器的初始狀態
    const p = setup({ paused: true });
    await p.jobs.tick();
    await p.jobs.flush();
    assert.equal(p.calls.length, 0);
    assert.match(info(p.jobs).lastResult.note, /已暫停/);
  });

  test('同步進行中先不跑（發佈資訊要同步下來才看得到）；同步結束後的下一個 tick 才跑', async () => {
    const eg = createFakeEngine({ home: paths.home });
    let release;
    const gate = new Promise((r) => { release = r; });
    eg.sync = async () => { await gate; return { ok: true, state: 'ok', committed: 0, pulled: 0, pushed: false, conflicts: [], held: [], skipped: { recent: [], secrets: [] } }; };
    const { jobs, calls, advance } = setup({ eg });
    const syncing = jobs.run('sync', 'manual');
    await jobs.tick();
    assert.equal(calls.length, 0);
    release();
    await syncing;
    advance(TICK_MS);
    await jobs.tick();
    await jobs.flush();
    assert.equal(calls.length, 1);
  });

  test('關掉這個工作（toggle）就不排程', async () => {
    const { jobs, calls } = setup();
    jobs.toggle('update', false);
    await jobs.tick();
    assert.equal(calls.length, 0);
    assert.equal(info(jobs).nextRunAt, null);
  });
});

describe('延後與重試', () => {
  test('有對話進行中（busy）：30 分鐘後再看，不算執行過；之後正常跑', async () => {
    const busy = { status: 'deferred', code: 'busy', reason: '有對話進行中或自動駕駛正在執行，稍後再試：有對話進行中', en: { reason: 'A conversation is in progress or autopilot is running; trying again later: x' } };
    const { jobs, calls, advance, at } = setup({ results: [busy] });
    await jobs.tick();
    await jobs.flush();
    assert.equal(calls.length, 1);
    assert.equal(info(jobs).lastRunAt, null, '延後不算執行過');
    assert.equal(Date.parse(info(jobs).nextRunAt), at() + 30 * MIN);
    assert.equal(info(jobs).lastResult.ok, true);
    assert.match(info(jobs).lastResult.note, /有對話進行中/);
    advance(29 * MIN);
    await jobs.tick();
    assert.equal(calls.length, 1, '29 分鐘還沒到');
    advance(2 * MIN);
    await jobs.tick();
    await jobs.flush();
    assert.equal(calls.length, 2);
    assert.ok(info(jobs).lastRunAt, '這次沒延後，算執行過');
  });

  test('連不上遠端：2 小時後再試', async () => {
    const off = { status: 'deferred', code: 'offline', reason: '連不上遠端，稍後再試', en: { reason: 'Could not reach the remote; trying again later' } };
    const { jobs, calls, advance, at } = setup({ results: [off] });
    await jobs.tick();
    await jobs.flush();
    assert.equal(Date.parse(info(jobs).nextRunAt), at() + 2 * 3600_000);
    advance(119 * MIN);
    await jobs.tick();
    assert.equal(calls.length, 1);
    advance(2 * MIN);
    await jobs.tick();
    await jobs.flush();
    assert.equal(calls.length, 2);
  });

  test('busy 的判斷：電腦使用中、自動駕駛正在跑都回傳原因；都沒有時回傳 null', async () => {
    let idle = true;
    let finish;
    const hang = new Promise((r) => { finish = r; });
    const eg = createFakeEngine({ home: paths.home });
    eg.settings.get = async () => ({ autopilot: 'on' });
    const { jobs, calls } = setup({ eg, isIdle: async () => idle, runAutopilot: async () => { await hang; return { ok: true, run: { id: 'r1', summary: {} } }; } });
    await jobs.tick();
    await jobs.flush();
    const busy = calls[0].busy;
    assert.equal(await busy(), null);
    idle = false;
    // 原因帶英文版（後來補充：GET /api/update 的 last.en.reason）
    assert.deepEqual(await busy(), { zh: '有對話進行中', en: 'a conversation is in progress' });
    idle = true;
    const curating = jobs.run('curate', 'manual');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(await busy(), { zh: '自動駕駛正在執行', en: 'autopilot is running' });
    finish();
    await curating;
    assert.equal(await busy(), null);
  });
});

describe('延後的上限（第二輪審查 #4）', () => {
  test('同一個原因連續延後 5 次（giveUpToday）：這次算執行過、不再短間隔重試，下一次是明天 11:00', async () => {
    const giveUp = { status: 'deferred', code: 'busy', streak: 5, giveUpToday: true, reason: '有對話進行中或自動駕駛正在執行，稍後再試：有對話進行中', en: { reason: 'x' } };
    const { jobs, calls, advance } = setup({ results: [giveUp] });
    await jobs.tick();
    await jobs.flush();
    assert.equal(calls.length, 1);
    assert.ok(info(jobs).lastRunAt, '算執行過');
    assert.equal(new Date(Date.parse(info(jobs).nextRunAt)).getHours(), 11, '下一次是明天的排程，不是 30 分鐘後');
    advance(40 * MIN);
    await jobs.tick();
    await jobs.flush();
    assert.equal(calls.length, 1, '40 分鐘後不會再試');
  });
});

describe('更新與自動駕駛不同時進行（第二輪審查 #5）', () => {
  /** curate 要開著（設定 autopilot: on）；runAutopilot 記下有沒有被呼叫 */
  function withAutopilot(o = {}) {
    const eg = createFakeEngine({ home: paths.home });
    eg.settings.get = async () => ({ autopilot: 'on' });
    let started = 0;
    const s = setup({ eg, ...o, runAutopilot: async () => { started++; return { ok: true, run: { id: 'r1', summary: {} } }; } });
    return { ...s, started: () => started };
  }
  const curate = (jobs) => jobs.list().find((j) => j.id === 'curate');

  test('更新正在執行時，自動駕駛（排程或手動）不開始新的一輪、延後；更新結束之後照常', async () => {
    let finish;
    const hang = new Promise((r) => { finish = r; });
    const { jobs, calls, started } = withAutopilot({ autoUpdateImpl: async () => { await hang; return { status: 'current', code: 'current', reason: '已經是最新版', en: { reason: 'Already up to date' } }; } });
    const updating = jobs.run('update', 'manual');
    try {
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(calls.length, 1);
      await jobs.run('curate', 'manual');
      assert.equal(started(), 0, '更新進行中不開始自動駕駛');
      assert.match(curate(jobs).lastResult.note, /自動更新進行中/);
    } finally {
      finish(); // 斷言失敗時也要放行，不然 afterEach 的 stop() 會一直等這個更新
    }
    await updating;
    await jobs.run('curate', 'manual');
    assert.equal(started(), 1, '更新結束之後照常');
  });

  test('更新成功、常駐程式即將重啟的空檔也不開始新的一輪', async () => {
    const updated = { status: 'updated', code: 'updated', reason: '已自動更新', en: { reason: 'Updated automatically' } };
    const { jobs, started } = withAutopilot({ results: [updated] });
    await jobs.run('update', 'manual');
    await jobs.run('curate', 'manual');
    assert.equal(started(), 0);
    assert.match(curate(jobs).lastResult.note, /自動更新進行中/);
  });
});

describe('結果的轉達', () => {
  test('更新成功：記為完成並寫日誌；通知與重啟由 runAutoUpdate 呼叫注入的相依（工作本身不重複通知）', async () => {
    const updated = { status: 'updated', code: 'updated', reason: '已自動更新：1.6.0-abc1234 → 1.7.0-def5678', en: { reason: 'Updated automatically: 1.6.0-abc1234 → 1.7.0-def5678' } };
    const { jobs, notified } = setup({ results: [updated] });
    await jobs.tick();
    await jobs.flush();
    assert.equal(info(jobs).lastResult.ok, true);
    assert.equal(info(jobs).lastResult.note, updated.reason);
    assert.equal(info(jobs).lastResult.en.note, updated.en.reason);
    assert.equal(notified.length, 0, '通知在 runAutoUpdate 裡（每個發佈只通知一次），工作不另外通知');
    assert.ok((await readLogs(paths.logs, 'agent', {})).some((l) => /update/.test(JSON.stringify(l)) && /已自動更新/.test(JSON.stringify(l))));
  });

  test('更新失敗：記為失敗（工作狀態與日誌都有原因）', async () => {
    const failed = { status: 'failed', code: 'doctor-failed', reason: '更新後的檢查（doctor）沒有通過：引擎無法載入', en: { reason: 'The post-update check (doctor) did not pass: x' }, rolledBack: true };
    const { jobs } = setup({ results: [failed] });
    await jobs.tick();
    await jobs.flush();
    assert.equal(info(jobs).lastResult.ok, false);
    assert.match(info(jobs).lastResult.note, /doctor/);
  });

  test('條件不符（refused）：不更新，原因留在工作狀態與日誌；沒有新版／沒有發佈資訊／關閉時日誌不寫', async () => {
    const refused = { status: 'refused', code: 'dirty', reason: '來源資料夾有未提交的變更，不自動更新：2 個項目', en: { reason: 'The source folder has uncommitted changes, so no automatic update: 2 items' } };
    const a = setup({ results: [refused] });
    await a.jobs.tick();
    await a.jobs.flush();
    assert.equal(info(a.jobs).lastResult.ok, true);
    assert.match(info(a.jobs).lastResult.note, /未提交/);
    const logs = JSON.stringify(await readLogs(paths.logs, 'agent', {}));
    assert.match(logs, /來源資料夾有未提交的變更/);
    // 沒有新版：日誌完全不寫（每天一次的空轉不要洗版），工作狀態仍記錄
    const updateLines = async () => (await readLogs(paths.logs, 'agent', {})).filter((e) => JSON.stringify(e).includes('"update"')).length;
    const before = await updateLines();
    assert.ok(before >= 1, '前置：條件不符的那次有寫');
    // 第一個排程器先停掉：它還在背景寫 agent-jobs.json，會蓋掉下一個排程器剛寫好的初始狀態
    await a.jobs.stop();
    const b = setup();
    await b.jobs.tick();
    await b.jobs.flush();
    assert.equal(info(b.jobs).lastResult.note, '已經是最新版');
    assert.equal(await updateLines(), before);
  });
});
