// 程序內排程器：牆上時鐘跳躍偵測、到期判斷、檔案監看的安靜期、同步失敗與健康檢查的通知、探測暫停、背景綁定。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import { createJobs, detectClockJump, lastDailySlot, nextDailySlot, TICK_MS } from '../../src/agent/jobs.mjs';
import { createPendingBinder, pendingBindings } from '../../src/agent/pending.mjs';
import { CliError } from '../../src/cli/errors.mjs';
import { createLogger, readLogs } from '../../src/cli/log.mjs';
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
// 每個測試結束前停掉排程器（關掉 tick 啟動的真實檔案監看）並等它寫完 agent-jobs.json，避免寫到下一個測試的檔案
const created = [];
afterEach(async () => {
  for (const j of created.splice(0)) await j.stop();
});

const T0 = new Date(2026, 9, 22, 11, 0, 0).getTime(); // 本地時間 2026-10-22 11:00（已過當天 09:30）

/** 建立排程器；預設把所有工作都標成剛跑過，避免測試互相干擾 */
function setup({ fresh = true, eg = createFakeEngine({ home: paths.home }), probe = null, isIdle, sleep, lastRun = {} } = {}) {
  let now = T0;
  const emitted = [];
  const notified = [];
  if (fresh) {
    const ran = new Date(T0).toISOString();
    fs.mkdirSync(paths.local, { recursive: true });
    fs.writeFileSync(paths.jobsFile, JSON.stringify({
      // lastRun：指定某些工作上次是多久（毫秒）以前執行的，其餘都標成剛跑過
      jobs: Object.fromEntries(['sync', 'health', 'probe', 'curate', 'gc'].map((id) => [id, { lastRunAt: lastRun[id] === undefined ? ran : new Date(T0 - lastRun[id]).toISOString() }])),
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
    ...(isIdle ? { isIdle } : {}),
    ...(sleep ? { sleep } : {}),
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

  // S1：Windows 的 fs.watch 連「最後存取時間」變了也會回報 change，而同步本身就會讀遍整個 vault，
  // 於是同步結束後 30 秒必定多一次空的本機存檔。事件發生時比對修改時間與大小，沒變就不排存檔。
  test('S1：只有存取時間之類的變動（修改時間與大小沒變）不排存檔；檔案真的變了才排一次', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { jobs, eg, emitted } = setup();
      const file = path.join(eg.paths.vault, 'global', 'a.md');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '# a\n');
      jobs.baselineVault();
      const watchNext = () => jobs.list().find((j) => j.id === 'watch').nextRunAt;
      const syncCalls = () => eg.calls.filter((c) => c.name === 'sync').length;
      const settled = async () => { while (jobs.list().find((j) => j.id === 'watch').running) await new Promise((r) => setImmediate(r)); };

      jobs.onVaultChange('global\\a.md'); // 只是被讀過
      jobs.onVaultChange('global');
      assert.equal(watchNext(), null, '沒有變更就不排存檔');
      mock.timers.tick(31_000);
      assert.equal(syncCalls(), 0);
      assert.equal(emitted.filter((e) => e.name === 'change').length, 0, '介面也不會收到 change 事件');

      fs.writeFileSync(file, '# a，內容改過\n'); // 大小與修改時間都變
      jobs.onVaultChange('global\\a.md');
      assert.notEqual(watchNext(), null);
      mock.timers.tick(30_000);
      await settled();
      assert.equal(syncCalls(), 1, '真的改了記憶檔 → 觸發一次');

      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(file, later, later); // 內容一樣、只有修改時間變
      jobs.onVaultChange('global\\a.md');
      assert.notEqual(watchNext(), null, '修改時間變了也算');
      mock.timers.tick(30_000);
      await settled();
      assert.equal(syncCalls(), 2);

      jobs.onVaultChange('global\\a.md'); // 這個狀態已經記下來了，再來一次存取事件就不算
      assert.equal(watchNext(), null);

      fs.rmSync(file);
      jobs.onVaultChange('global\\a.md'); // 刪除一定要存
      assert.notEqual(watchNext(), null);
    } finally {
      mock.timers.reset();
    }
  });

  test('S1：新建立的檔案、vault 以外沒看過的路徑都算變更；.git 內的事件一律忽略', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { jobs, eg } = setup();
      fs.mkdirSync(path.join(eg.paths.vault, 'global'), { recursive: true });
      jobs.baselineVault();
      const watchNext = () => jobs.list().find((j) => j.id === 'watch').nextRunAt;
      fs.writeFileSync(path.join(eg.paths.vault, 'global', 'new.md'), '# new\n');
      jobs.onVaultChange('global\\new.md');
      assert.notEqual(watchNext(), null);
      jobs.toggle('watch', false);
      jobs.toggle('watch', true);
      assert.equal(watchNext(), null);
      jobs.onVaultChange('.git\\objects\\ab\\cdef');
      jobs.onVaultChange('.git');
      assert.equal(watchNext(), null);
    } finally {
      mock.timers.reset();
    }
  });

  // Windows 在一大批檔案操作之後（例如 git gc）會回報沒有檔案名稱的事件，可能是監看的緩衝區滿了、事件被丟掉：
  // 沒辦法忽略（會漏掉同一批裡真的寫入），也不能一律算變更（每次打包後都多一次空的存檔）→ 重新掃描對照簽章
  test('S1：沒有檔案名稱的事件 → 重新掃描 vault，有差異才排存檔（含事件被丟掉的那一個）', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { jobs, eg, emitted } = setup();
      const dir = path.join(eg.paths.vault, 'global');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.md'), '# a\n');
      fs.writeFileSync(path.join(dir, 'b.md'), '# b\n');
      jobs.baselineVault();
      const watchNext = () => jobs.list().find((j) => j.id === 'watch').nextRunAt;
      const reset = () => { jobs.toggle('watch', false); jobs.toggle('watch', true); };

      jobs.onVaultChange(null);
      jobs.onVaultChange('');
      assert.equal(watchNext(), null, '什麼都沒變 → 不排存檔');

      fs.writeFileSync(path.join(dir, 'a.md'), '# a，改過但這個檔案的事件被丟掉了\n');
      jobs.onVaultChange(null);
      assert.notEqual(watchNext(), null, '掃描發現 a.md 變了');
      mock.timers.tick(1000);
      assert.deepEqual(emitted.find((e) => e.name === 'change').data.paths, ['global/a.md']);
      reset();
      jobs.onVaultChange(null);
      assert.equal(watchNext(), null, '簽章已更新，再來一次沒有差異');

      fs.rmSync(path.join(dir, 'b.md'));
      jobs.onVaultChange(null);
      assert.notEqual(watchNext(), null, '刪除也看得出來');
      reset();
      fs.writeFileSync(path.join(dir, 'c.md'), '# c\n');
      jobs.onVaultChange(null);
      assert.notEqual(watchNext(), null, '新增也看得出來');
    } finally {
      mock.timers.reset();
    }
  });

  test('S1：還沒有基準（沒開始監看）時，沒有檔案名稱的事件算變更', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { jobs } = setup();
      jobs.onVaultChange(null);
      assert.notEqual(jobs.list().find((j) => j.id === 'watch').nextRunAt, null);
    } finally {
      mock.timers.reset();
    }
  });

  test('S1：本機存檔沒有東西可 commit 時只寫 debug，有 commit 才寫 info', async () => {
    const { jobs, eg } = setup();
    const empty = { ok: true, state: 'ok', committed: 0, pulled: 0, pushed: false, conflicts: [], held: [], skipped: { recent: [], secrets: [] } };
    eg.sync = async () => empty;
    const r0 = await jobs.run('watch', 'quiet');
    assert.equal(r0.ok, true);
    eg.sync = async () => ({ ...empty, committed: 2 });
    await jobs.run('watch', 'quiet');
    const levels = (await readLogs(paths.logs, 'agent')).filter((e) => e.src === 'watch').map((e) => [e.level, /commit 2 次/.test(e.msg)]);
    assert.deepEqual(levels, [['debug', false], ['info', true]]);
    // 結果仍然記在工作狀態裡（排程與介面照常顯示）
    assert.equal(jobs.list().find((j) => j.id === 'watch').lastResult.ok, true);
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

describe('同步通知門檻與啟動時的重試（S2）', () => {
  const settled = async (jobs, id = 'sync') => { while (jobs.list().find((j) => j.id === id).running) await new Promise((r) => setImmediate(r)); };
  const offline = () => ({ ok: false, state: 'offline', error: { code: 'E_OFFLINE', message: '連不到 GitHub' } });
  const stuck = () => ({ ok: false, state: 'error', error: { code: 'E_CONFLICT', message: '本機有尚未提交的變更，這一輪暫不合併' } });
  const warnLogs = async (src) => (await readLogs(paths.logs, 'agent')).filter((e) => e.src === src && e.level === 'warn');

  test('非離線的錯誤連續失敗滿 1 小時就通知（原因寫進內文）；離線仍是 24 小時', async () => {
    const { jobs, eg, notified, advance } = setup();
    eg.sync = async () => stuck();
    await jobs.run('sync');
    advance(59 * 60_000);
    await jobs.run('sync');
    assert.equal(notified.length, 0, '59 分鐘還不通知');
    advance(2 * 60_000);
    await jobs.run('sync');
    assert.deepEqual(notified.map((n) => [n.key, n.page]), [['sync-error', 'devices']]);
    assert.match(notified[0].body, /1 小時/);
    assert.match(notified[0].body, /本機有尚未提交的變更/);
  });

  test('離線一陣子之後變成別種錯誤：1 小時從第一次非離線的失敗算起', async () => {
    const { jobs, eg, notified, advance } = setup();
    eg.sync = async () => offline();
    await jobs.run('sync');
    advance(2 * 3_600_000);
    await jobs.run('sync');
    assert.equal(notified.length, 0, '離線 2 小時：不通知');
    eg.sync = async () => stuck();
    await jobs.run('sync');
    advance(30 * 60_000);
    await jobs.run('sync');
    assert.equal(notified.length, 0);
    advance(31 * 60_000);
    await jobs.run('sync');
    assert.deepEqual(notified.map((n) => n.key), ['sync-error']);
  });

  test('U3：同步遇到 ref 鎖（打包正在更新 ref；state busy、E_LOCKED）不計入失敗、不通知，1 分鐘後重試', async () => {
    const { jobs, eg, notified, advance } = setup();
    eg.sync = async () => ({ ok: false, state: 'busy', error: { code: 'E_LOCKED', message: 'vault 的 git 正被其他程序使用（ref 鎖定，例如正在打包）' } });
    for (let i = 0; i < 4; i++) {
      const r = await jobs.run('sync');
      assert.equal(r.ok, true, '不算失敗');
      advance(30 * 60_000);
    }
    assert.equal(notified.length, 0);
    assert.equal((await warnLogs('sync')).length, 0);
    await jobs.flush();
    const saved = JSON.parse(fs.readFileSync(paths.jobsFile, 'utf8'));
    assert.equal(saved.syncFailingSince ?? null, null);
    assert.equal(saved.syncErrorSince ?? null, null);
  });

  test('成功之後非離線錯誤的計時歸零', async () => {
    const { jobs, eg, notified, advance } = setup();
    eg.sync = async () => stuck();
    await jobs.run('sync');
    advance(50 * 60_000);
    eg.sync = async () => ({ ok: true, state: 'ok', committed: 0, pulled: 0, pushed: false, conflicts: [], held: [], skipped: { recent: [], secrets: [] } });
    await jobs.run('sync');
    eg.sync = async () => stuck();
    advance(30 * 60_000);
    await jobs.run('sync');
    advance(30 * 60_000);
    await jobs.run('sync');
    assert.equal(notified.length, 0, '重新計時，還不到 1 小時');
    await jobs.flush();
    assert.equal(JSON.parse(fs.readFileSync(paths.jobsFile, 'utf8')).syncErrorSince !== null, true);
  });

  test('診斷與自動修復的結果寫進日誌（warn／info），內容沒變就不重複寫', async () => {
    const { jobs, eg } = setup();
    const diagnosis = { blockers: [{ ref: 'global/a.md', reason: 'secret', kinds: ['anthropic'] }], uncommitted: [{ ref: 'global/a.md', reason: 'secret', kinds: ['anthropic'] }], healed: [] };
    eg.sync = async () => ({ ...stuck(), diagnosis });
    await jobs.run('sync');
    await jobs.run('sync');
    const warned = (await warnLogs('sync')).filter((e) => /診斷/.test(e.msg));
    assert.equal(warned.length, 1);
    assert.match(warned[0].msg, /global\/a\.md/);
    assert.match(warned[0].msg, /疑似含有金鑰/);
    eg.sync = async () => ({ ok: true, state: 'ok', committed: 0, pulled: 1, pushed: false, conflicts: [], held: [], skipped: { recent: [], secrets: [] }, diagnosis: { ...diagnosis, healed: [{ ref: 'global/a.md', backup: 'backup/20261120T000000000Z/global/a.md', theirs: { kind: 'conflict', id: 'cf_20261120T0000_ab12' } }] } });
    await jobs.run('sync');
    const info = (await readLogs(paths.logs, 'agent')).filter((e) => e.src === 'sync' && e.level === 'info' && /放回原位/.test(e.msg));
    assert.equal(info.length, 1);
    assert.match(info[0].msg, /backup\/20261120T000000000Z\/global\/a\.md/);
    assert.match(info[0].msg, /對方的版本已存成衝突紀錄 cf_20261120T0000_ab12/);
  });

  test('自我修復把對方的版本另存到 local/backup 時（衝突紀錄建不起來），日誌寫明位置與原因', async () => {
    const { jobs, eg } = setup();
    const healed = [{ ref: 'global/a.md', backup: 'backup/20261120T000000000Z/global/a.md', theirs: { kind: 'backup', path: 'backup/20261120T000000000Z/theirs/global/a.md', error: '衝突隔離區不能用' } }];
    eg.sync = async () => ({ ok: true, state: 'ok', committed: 0, pulled: 1, pushed: false, conflicts: [], held: [], skipped: { recent: [], secrets: [] }, diagnosis: { blockers: [], uncommitted: [], healed } });
    await jobs.run('sync');
    const info = (await readLogs(paths.logs, 'agent')).filter((e) => e.src === 'sync' && e.level === 'info' && /放回原位/.test(e.msg));
    assert.match(info[0].msg, /local\/backup\/20261120T000000000Z\/theirs\/global\/a\.md/);
    assert.match(info[0].msg, /衝突隔離區不能用/);
  });

  /** 取代 eg.sync 並記下每次呼叫（換掉假引擎的 sync 之後，eg.calls 就不會記錄了） */
  const counting = (eg, make) => { const calls = []; eg.sync = async (o) => { calls.push(o); return make(); }; return calls; };

  test('啟動後第一次同步連不上：30、60、120 秒各重試一次，這幾次都不計入失敗、不寫 warn；之後排程的同步才算失敗', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { jobs, eg, notified, advance } = setup();
      const calls = counting(eg, offline);
      jobs.start();
      await settled(jobs);
      const attempts = () => calls.length;
      const state = async () => { await jobs.flush(); return JSON.parse(fs.readFileSync(paths.jobsFile, 'utf8')); };
      assert.equal(attempts(), 1);
      assert.equal((await state()).syncFailingSince ?? null, null, '第 1 次：不計入失敗');
      assert.equal(jobs.list().find((j) => j.id === 'sync').lastResult.ok, true, '工作狀態不顯示失敗');
      mock.timers.tick(29_000);
      assert.equal(attempts(), 1, '30 秒前不重試');
      mock.timers.tick(1_000);
      await settled(jobs);
      assert.equal(attempts(), 2);
      mock.timers.tick(59_000);
      assert.equal(attempts(), 2);
      mock.timers.tick(1_000);
      await settled(jobs);
      assert.equal(attempts(), 3);
      mock.timers.tick(120_000);
      await settled(jobs);
      assert.equal(attempts(), 4);
      assert.equal((await warnLogs('sync')).length, 0, '前面三次重試都不寫 warn');
      assert.equal((await state()).syncFailingSince ?? null, null, '重試用完之前都不計入失敗');
      // 重試用完了，這一次才是真正的失敗
      advance(10 * 60_000);
      await jobs.run('sync', 'schedule');
      assert.ok((await state()).syncFailingSince, '之後的失敗照常計入');
      assert.equal((await warnLogs('sync')).length, 1);
      assert.equal(notified.length, 0);
      mock.timers.tick(10 * 60_000);
      assert.equal(attempts(), 5, '不會再有重試的計時器');
    } finally {
      mock.timers.reset();
    }
  });

  test('重試途中連上了：不再重試，之後的失敗照常計入', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { jobs, eg } = setup();
      let up = false;
      const calls = counting(eg, () => (up ? { ok: true, state: 'ok', committed: 0, pulled: 0, pushed: false, conflicts: [], held: [], skipped: { recent: [], secrets: [] } } : offline()));
      jobs.start();
      await settled(jobs);
      up = true;
      mock.timers.tick(30_000);
      await settled(jobs);
      const attempts = () => calls.length;
      assert.equal(attempts(), 2);
      up = false;
      mock.timers.tick(10 * 60_000);
      assert.equal(attempts(), 2, '已經連上過，不再重試');
    } finally {
      mock.timers.reset();
    }
  });

  test('睡眠恢復（時鐘跳躍）後的第一次同步連不上，一樣先重試', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { jobs, eg, advance } = setup();
      const calls = counting(eg, offline);
      await jobs.tick();
      advance(3_600_000);
      await jobs.tick();
      await settled(jobs);
      const attempts = () => calls.length;
      assert.equal(attempts(), 1);
      assert.equal(jobs.list().find((j) => j.id === 'sync').lastResult.ok, true);
      mock.timers.tick(30_000);
      await settled(jobs);
      assert.equal(attempts(), 2);
    } finally {
      mock.timers.reset();
    }
  });

  test('手動或排程的同步（不是剛啟動／剛喚醒）連不上：照常計入失敗，不重試', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { jobs, eg } = setup();
      const calls = counting(eg, offline);
      const r = await jobs.run('sync', 'manual');
      assert.equal(r.ok, false);
      mock.timers.tick(10 * 60_000);
      assert.equal(calls.length, 1);
    } finally {
      mock.timers.reset();
    }
  });

  const locked = () => new CliError('E_LOCKED', 'Engram 正在進行另一項操作');
  test('啟動時的使用統計、綁定檢查遇到 E_LOCKED：等鎖再做，不記失敗', async () => {
    const eg = createFakeEngine({ home: paths.home });
    let refreshes = 0;
    let reconciles = 0;
    eg.usage = { refresh: async () => { if (++refreshes <= 3) throw locked(); return {}; } };
    eg.identity.reconcile = async () => { if (++reconciles <= 2) throw locked(); return { changed: [], deferred: [] }; };
    const waits = [];
    const { jobs } = setup({ eg, sleep: async (ms) => { waits.push(ms); } });
    const health = await jobs.run('health', 'catch-up');
    const bind = await jobs.run('bind', 'startup');
    assert.equal(health.ok, true);
    assert.equal(bind.ok, true, bind.note);
    assert.equal(refreshes, 4);
    assert.equal(reconciles, 3);
    assert.equal(waits.length, 5);
    assert.ok(waits.every((w) => w === 2_000));
    assert.equal((await warnLogs('usage')).length, 0);
  });

  test('一直被鎖住：最多等 60 秒，之後照常記失敗', async () => {
    const eg = createFakeEngine({ home: paths.home });
    let tries = 0;
    eg.usage = { refresh: async () => { tries++; throw locked(); } };
    let slept = 0;
    const { jobs } = setup({ eg, sleep: async (ms) => { slept += ms; } });
    await jobs.run('health', 'catch-up');
    assert.equal(slept, 60_000);
    assert.equal(tries, 31);
    assert.equal((await warnLogs('usage')).length, 1);
    // 其他錯誤不等
    let other = 0;
    await assert.rejects(jobs.retryLocked(async () => { other++; throw new CliError('E_INVALID', 'x'); }), (e) => e.code === 'E_INVALID');
    assert.equal(other, 1);
  });
});

describe('記憶庫打包（S3）', () => {
  const DAY = 24 * 3_600_000;
  const gcEngine = ({ loose = 10, over = false } = {}) => {
    const eg = createFakeEngine({ home: paths.home });
    eg.gc = {
      runs: [],
      ensured: 0,
      status: async () => ({ loose, packs: 1, stalePid: false, over }),
      run: async (o) => { eg.gc.runs.push(o); return { ok: true, ms: 2400, clearedPid: true, prunedBackups: 2, before: { loose: 7000, packs: 1 }, after: { loose: 0, packs: 2 } }; },
      ensureConfig: async () => { eg.gc.ensured++; return true; },
    };
    return eg;
  };
  const idleJobs = async (jobs) => { while (jobs.list().some((j) => j.running)) await new Promise((r) => setImmediate(r)); };

  test('每週一次：有中英說明、執行後 7 天才會再到期，結果寫明清除的 gc.pid 與零散物件前後數量', async () => {
    const eg = gcEngine();
    const { jobs } = setup({ eg });
    const def = jobs.list().find((j) => j.id === 'gc');
    assert.equal(def.enabled, true);
    assert.ok(def.label && def.schedule && def.en.label && def.en.schedule);
    const r = await jobs.run('gc', 'manual');
    assert.equal(r.ok, true);
    assert.match(r.note, /過期的 gc\.pid/);
    assert.match(r.note, /清除 2 個超過 30 天的自我修復備份/);
    assert.match(r.en.note, /Removed 2 self-heal backups older than 30 days/);
    assert.match(r.note, /7000 → 0/);
    assert.match(r.en.note, /7000 → 0/);
    const info = jobs.list().find((j) => j.id === 'gc');
    assert.equal(Date.parse(info.nextRunAt) - Date.parse(info.lastRunAt), 7 * DAY);
    assert.equal(eg.gc.runs.length, 1);
    assert.ok(eg.gc.runs[0].signal instanceof AbortSignal);
  });

  test('引擎沒有 gc（舊版引擎）時不報錯、也不寫 info', async () => {
    const { jobs } = setup();
    const r = await jobs.run('gc', 'manual');
    assert.equal(r.ok, true);
    assert.deepEqual((await readLogs(paths.logs, 'agent')).filter((e) => e.src === 'gc' && e.level !== 'debug'), []);
  });

  test('排程：從未執行過就到期；執行過就等 7 天，tick 到期時才執行', async () => {
    const eg = gcEngine();
    const a = setup({ eg, fresh: false });
    assert.equal(a.jobs.list().find((j) => j.id === 'gc').nextRunAt, new Date(T0).toISOString());
    const b = setup({ eg });
    await b.jobs.tick();
    await idleJobs(b.jobs);
    assert.equal(eg.gc.runs.length, 0, '剛跑過，還沒到期');
    b.advance(7 * DAY);
    await b.jobs.tick(); // 隔了 7 天：時鐘跳躍，這一輪先同步（打包不和同步重疊）
    await idleJobs(b.jobs);
    b.advance(60_000);
    await b.jobs.tick();
    await idleJobs(b.jobs);
    assert.equal(eg.gc.runs.length, 1);
  });

  test('零散物件超過 2,000 個：不等一週，下一次閒置就做；使用中先等、不會每分鐘重新問', async () => {
    const eg = gcEngine({ loose: 7000, over: true });
    let idle = false;
    const { jobs, advance } = setup({ eg, isIdle: async () => idle });
    await jobs.tick();
    await idleJobs(jobs);
    assert.equal(eg.gc.runs.length, 0, '電腦使用中');
    advance(60_000);
    await jobs.tick();
    await idleJobs(jobs);
    assert.equal(eg.gc.runs.length, 0, '5 分鐘內不重複檢查');
    idle = true;
    advance(5 * 60_000);
    await jobs.tick(); // 隔了 5 分鐘：時鐘跳躍，先同步
    await idleJobs(jobs);
    advance(60_000);
    await jobs.tick();
    await idleJobs(jobs);
    assert.equal(eg.gc.runs.length, 1, '閒置了就打包');
    advance(60_000);
    await jobs.tick();
    await idleJobs(jobs);
    assert.equal(eg.gc.runs.length, 1);
  });

  // U3：打包不持引擎的寫入鎖、會短暫鎖住 ref。只在沒有同步或存檔正在執行、而且沒有對話進行中時啟動
  const okSync = { ok: true, state: 'ok', committed: 0, pulled: 0, pushed: false, conflicts: [], held: [], skipped: { recent: [], secrets: [] } };
  /** eg.sync 先卡在 gate 上（模擬同步執行中），release() 之後恢復正常 */
  const gatedSync = (eg) => {
    let release = () => {};
    let gate = new Promise((r) => { release = () => { gate = null; r(okSync); }; });
    eg.sync = async () => (gate ?? okSync);
    return () => release();
  };

  test('U3：同步正在執行時，每週到期的打包不啟動；同步結束後的下一個 tick 才開始', async () => {
    const eg = gcEngine();
    const release = gatedSync(eg);
    const { jobs, advance } = setup({ eg, isIdle: async () => true });
    advance(7 * DAY);
    const syncing = jobs.run('sync', 'manual');
    await jobs.tick();
    assert.equal(eg.gc.runs.length, 0, '同步還在跑：不打包');
    release();
    await syncing;
    await jobs.tick();
    await idleJobs(jobs);
    assert.equal(eg.gc.runs.length, 1);
  });

  test('U3：存檔正在執行或已經排定時也不打包', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const eg = gcEngine();
      const { jobs } = setup({ eg, isIdle: async () => true, lastRun: { gc: 8 * DAY } }); // 打包已經到期，同步還沒
      fs.mkdirSync(path.join(eg.paths.vault, 'global'), { recursive: true });
      fs.writeFileSync(path.join(eg.paths.vault, 'global', 'pending-save.md'), '# x\n');
      jobs.onVaultChange('global\\pending-save.md'); // 30 秒後會存檔
      await jobs.tick();
      assert.equal(eg.gc.runs.length, 0, '存檔已經排定：先不打包');
      mock.timers.tick(30_000);
      await idleJobs(jobs);
      await jobs.tick();
      await idleJobs(jobs);
      assert.equal(eg.gc.runs.length, 1, '存檔做完之後才打包');
    } finally {
      mock.timers.reset();
    }
  });

  test('U3：常駐程式升級後的第一次 tick（從沒打包過、立即到期）遇到啟動同步時，等同步結束再打包', async () => {
    const eg = gcEngine();
    const release = gatedSync(eg);
    const { jobs } = setup({ eg, fresh: false, isIdle: async () => true });
    jobs.start(); // 啟動同步（卡住）
    await new Promise((r) => setTimeout(r, 20));
    await jobs.tick();
    assert.equal(eg.gc.runs.length, 0);
    release();
    await new Promise((r) => setTimeout(r, 20));
    await idleJobs(jobs);
    await jobs.tick();
    await idleJobs(jobs);
    assert.equal(eg.gc.runs.length, 1);
  });

  test('U3：有對話進行中（電腦沒有閒置）時每週的打包先等；拖了兩天還等不到才照做，但同步在跑時仍然不做', async () => {
    const eg = gcEngine();
    const release = gatedSync(eg);
    release(); // 先放開，後面需要時再另外卡住
    const { jobs, advance } = setup({ eg, isIdle: async () => false });
    advance(7 * DAY);
    await jobs.tick();
    await idleJobs(jobs);
    assert.equal(eg.gc.runs.length, 0, '電腦使用中：等');
    advance(6 * 60_000);
    await jobs.tick();
    await idleJobs(jobs);
    assert.equal(eg.gc.runs.length, 0);
    advance(DAY + 23 * 3_600_000);
    await jobs.tick();
    await idleJobs(jobs);
    assert.equal(eg.gc.runs.length, 0, '還沒滿兩天');
    advance(2 * 3_600_000);
    const releaseSync = gatedSync(eg); // 同步卡住
    const syncing = jobs.run('sync', 'manual');
    await jobs.tick();
    assert.equal(eg.gc.runs.length, 0, '拖了兩天也不能和同步重疊');
    releaseSync();
    await syncing;
    await jobs.tick();
    await idleJobs(jobs);
    assert.equal(eg.gc.runs.length, 1, '同步結束後，拖滿兩天的打包不再等閒置');
  });

  test('U3：零散物件太多的提早打包也一樣不和同步重疊', async () => {
    const eg = gcEngine({ loose: 7000, over: true });
    const release = gatedSync(eg);
    const { jobs } = setup({ eg, isIdle: async () => true });
    const syncing = jobs.run('sync', 'manual');
    await jobs.tick();
    assert.equal(eg.gc.runs.length, 0);
    release();
    await syncing;
    await jobs.tick();
    await idleJobs(jobs);
    assert.equal(eg.gc.runs.length, 1);
  });

  test('零散物件沒超過就不提早打包', async () => {
    const eg = gcEngine({ loose: 300, over: false });
    const { jobs, advance } = setup({ eg, isIdle: async () => true });
    for (let i = 0; i < 3; i++) { advance(61_000); await jobs.tick(); await idleJobs(jobs); }
    assert.equal(eg.gc.runs.length, 0);
  });

  test('啟動時補設既有記憶庫的 gc.auto；停止常駐程式時中止進行中的打包，不會等 10 分鐘', async () => {
    const eg = gcEngine();
    eg.gc.run = (o) => new Promise((_, reject) => { eg.gc.runs.push(o); o.signal.addEventListener('abort', () => reject(new Error('aborted'))); });
    const { jobs } = setup({ eg });
    jobs.start();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(eg.gc.ensured, 1);
    const running = jobs.run('gc', 'manual');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(eg.gc.runs.length, 1);
    await Promise.race([jobs.stop(), new Promise((_, rej) => setTimeout(() => rej(new Error('stop 卡住了')), 3000))]);
    assert.equal(eg.gc.runs[0].signal.aborted, true);
    assert.equal((await running).ok, false);
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

  test('S1：沒有事可做（詢問、關閉、改名 0）時不寫紀錄；有改名才寫 info，工作狀態照常記錄', async () => {
    const renameLogs = async () => (await readLogs(paths.logs, 'agent')).filter((e) => e.src === 'rename');
    for (const [mode, renamed] of [['ask', []], ['off', []], ['auto', []]]) {
      const { eg } = engineWith(mode, renamed);
      const { jobs } = setup({ eg });
      const r = await jobs.run('rename', 'manual');
      assert.equal(r.ok, true);
      assert.equal(jobs.list().find((j) => j.id === 'rename').lastResult.ok, true, mode);
    }
    assert.deepEqual(await renameLogs(), [], '沒有事可做就完全不寫紀錄（連 debug 也沒有）');
    const { eg } = engineWith('auto', [{ from: 'C:/Users/x/Desktop/甲方報告', to: 'C:/Users/x/Desktop/甲方報告-k3fz' }]);
    const { jobs } = setup({ eg });
    await jobs.run('rename', 'manual');
    assert.ok((await renameLogs()).some((e) => e.level === 'info' && /改名 1/.test(e.msg)));
  });
});

describe('環境健檢（2.0.0 R1、R5）', () => {
  const ENV_SLOT = { hour: 10, minute: 0 };
  const envEngine = (run) => {
    const eg = createFakeEngine({ home: paths.home });
    eg.env = { run: async (o) => { eg.calls.push({ name: 'env.run', args: [o] }); return run(o); } };
    return eg;
  };

  test('JOB_DEFS 有 env，附中英說明；每天 10:00 一次，從沒執行過就到期', () => {
    const { jobs } = setup({ fresh: false });
    const env = jobs.list().find((j) => j.id === 'env');
    assert.equal(env.enabled, true);
    assert.ok(env.label && env.schedule && env.en.label && env.en.schedule);
    assert.equal(env.nextRunAt, new Date(T0).toISOString(), '從沒執行過 → 立刻到期');
  });

  test('執行：呼叫引擎的 env.run（帶 Claude Code 版本）、結果寫進 lastResult；下一次是明天 10:00', async () => {
    const eg = envEngine(() => ({ ok: true, written: true, findings: 2, fixed: ['H26'] }));
    const { jobs } = setup({ eg });
    const r = await jobs.run('env', 'manual');
    assert.equal(r.ok, true);
    assert.match(r.note, /2 項發現、環境指紋已更新、自動修正 H26/);
    assert.match(r.en.note, /2 findings, environment fingerprint updated, fixed H26 automatically/);
    const call = eg.calls.find((c) => c.name === 'env.run');
    assert.equal(call.args[0].claudeVersion, '2.1.306');
    assert.equal(typeof call.args[0].isIdle, 'function');
    assert.equal(jobs.list().find((j) => j.id === 'env').nextRunAt, new Date(nextDailySlot(T0, ENV_SLOT)).toISOString());
  });

  test('tick 在到期時執行；剛跑過就不重複', async () => {
    const eg = envEngine(() => ({ ok: true, written: false, findings: 0, fixed: [] }));
    const { jobs } = setup({ eg });
    await jobs.tick();
    await jobs.flush();
    assert.equal(eg.calls.filter((c) => c.name === 'env.run').length, 1);
    await jobs.tick();
    await jobs.flush();
    assert.equal(eg.calls.filter((c) => c.name === 'env.run').length, 1);
  });

  test('設定關閉、暫停、引擎沒有 env：不出錯', async () => {
    const off = envEngine(() => ({ ok: true, skipped: 'off' }));
    assert.match((await setup({ eg: off }).jobs.run('env', 'manual')).note, /已關閉/);
    const old = createFakeEngine({ home: paths.home });
    delete old.env;
    assert.match((await setup({ eg: old }).jobs.run('env', 'manual')).note, /引擎不支援/);
    const paused = envEngine(() => ({ ok: true, written: false, findings: 0, fixed: [] }));
    const { createSettings } = await import('../../src/agent/settings.mjs');
    const settings = createSettings(paths);
    await settings.set({ paused: true });
    const jobs = createJobs({
      eg: paused, paths, events: { emit() {} }, log: createLogger(paths.logs, 'agent'), notifier: { notify: async () => {} },
      runProbe: async () => ({ checks: [] }), detectVersion: async () => '2.1.306', settings,
    });
    created.push(jobs);
    assert.match((await jobs.run('env', 'manual')).note, /已暫停/);
    assert.equal(paused.calls.filter((c) => c.name === 'env.run').length, 0);
  });

  test('自動修正失敗與指紋被擋下都會寫進結果', async () => {
    const eg = envEngine(() => ({ ok: true, written: false, blocked: ['jwt'], findings: 1, fixed: [], failed: [{ code: 'H26', message: '設定檔剛好被修改' }] }));
    const r = await setup({ eg }).jobs.run('env', 'manual');
    assert.equal(r.ok, false);
    assert.match(r.note, /環境指紋含疑似金鑰，沒有寫進記憶庫/);
    assert.match(r.note, /自動修正失敗：H26 設定檔剛好被修改/);
    assert.match(r.en.note, /the fingerprint contained a possible secret/);
  });
});

describe('環境設定同步（2.0.0 WP8）併進每日的 env 工作', () => {
  const syncEngine = (sync, run = () => ({ ok: true, written: false, findings: 0, fixed: [] })) => {
    const eg = createFakeEngine({ home: paths.home });
    eg.env = {
      run: async (o) => { eg.calls.push({ name: 'env.run', args: [o] }); return run(o); },
      syncRun: async (o) => { eg.calls.push({ name: 'env.syncRun', args: [o] }); return sync(o); },
    };
    return eg;
  };

  test('report：把「有 N 項可套用」寫進備註（中英）、帶 isIdle；沒有變更就不提', async () => {
    const eg = syncEngine(() => ({ ok: true, mode: 'report', changes: 2, applied: false }));
    const r = await setup({ eg }).jobs.run('env', 'manual');
    assert.equal(r.ok, true);
    assert.match(r.note, /0 項發現.*環境設定有 2 項可套用（只報告，不自動套用）/);
    assert.match(r.en.note, /0 findings.*2 environment changes can be applied \(report only/);
    assert.equal(typeof eg.calls.find((c) => c.name === 'env.syncRun').args[0].isIdle, 'function');
    const quiet = syncEngine(() => ({ ok: true, mode: 'report', changes: 0, applied: false }));
    const q = await setup({ eg: quiet }).jobs.run('env', 'manual');
    assert.doesNotMatch(q.note, /環境設定/);
    const off = syncEngine(() => ({ ok: true, skipped: 'off', mode: 'off' }));
    assert.doesNotMatch((await setup({ eg: off }).jobs.run('env', 'manual')).note, /環境設定/);
  });

  test('等待這台核可的項目（pending）：備註提醒 engram env approve（中英）；沒有可套用的變更時也提；auto 套用時一併說明', async () => {
    const waiting = syncEngine(() => ({ ok: true, mode: 'auto', changes: 0, pending: 2, applied: false }));
    const w = await setup({ eg: waiting }).jobs.run('env', 'manual');
    assert.match(w.note, /2 項等待這台核可（engram env approve）/);
    assert.match(w.en.note, /2 items are waiting for approval on this computer \(engram env approve\)/);
    const mixed = syncEngine(() => ({ ok: true, mode: 'auto', changes: 1, pending: 1, applied: true, result: { applied: 1 } }));
    const m = await setup({ eg: mixed }).jobs.run('env', 'manual');
    assert.match(m.note, /環境設定已套用 1 項；1 項等待這台核可/);
    const report = syncEngine(() => ({ ok: true, mode: 'report', changes: 1, pending: 3, applied: false }));
    assert.match((await setup({ eg: report }).jobs.run('env', 'manual')).note, /1 項可套用（只報告，不自動套用）；3 項等待這台核可/);
  });

  test('環境健檢設定為關閉時，環境設定同步照自己的設定走', async () => {
    const eg = syncEngine(() => ({ ok: true, mode: 'report', changes: 1, applied: false }), () => ({ ok: true, skipped: 'off' }));
    const r = await setup({ eg }).jobs.run('env', 'manual');
    assert.match(r.note, /已關閉（設定）.*環境設定有 1 項可套用/);
    assert.ok(eg.calls.some((c) => c.name === 'env.syncRun'));
  });

  test('auto 套用了就寫「已套用 N 項」；套用失敗記為失敗；引擎丟錯也不讓整個工作失敗地消失', async () => {
    const done = syncEngine(() => ({ ok: true, mode: 'auto', changes: 3, applied: true, result: { applied: 3, id: 'x', backup: 'b' } }));
    const r = await setup({ eg: done }).jobs.run('env', 'manual');
    assert.match(r.note, /環境設定已套用 3 項/);
    assert.match(r.en.note, /Applied 3 environment changes/);
    const failed = syncEngine(() => ({ ok: false, mode: 'auto', changes: 1, applied: false, failed: { code: 'E_INVALID', message: '排版' } }));
    const f = await setup({ eg: failed }).jobs.run('env', 'manual');
    assert.equal(f.ok, false);
    assert.match(f.note, /環境設定同步失敗：E_INVALID：排版/);
    const thrown = syncEngine(() => { throw new Error('boom'); });
    const t = await setup({ eg: thrown }).jobs.run('env', 'manual');
    assert.equal(t.ok, false);
  });

  test('auto 遇到對話進行中：備註說稍後再試，30 分鐘後的 tick 重試，套用就不再重試', async () => {
    let n = 0;
    const eg = syncEngine(() => (++n === 1 ? { ok: true, mode: 'auto', changes: 1, applied: false, deferred: true } : { ok: true, mode: 'auto', changes: 1, applied: true, result: { applied: 1 } }));
    const { jobs, advance } = setup({ eg });
    const r = await jobs.run('env', 'manual');
    assert.match(r.note, /1 項待套用（對話進行中，稍後再試）/);
    advance(29 * 60_000);
    await jobs.tick();
    await jobs.flush();
    assert.equal(n, 1, '還沒到 30 分鐘');
    advance(2 * 60_000);
    await jobs.tick();
    for (let i = 0; i < 100 && n < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10)); // 重試是 tick 裡不等待的呼叫，輪詢到它發生
    assert.equal(n, 2, '30 分鐘後重試');
    advance(60 * 60_000);
    await jobs.tick();
    await new Promise((resolve) => setTimeout(resolve, 50)); // 確認沒有第三次：給它足夠的時間才能證明「不會發生」
    assert.equal(n, 2, '套用之後不再重試');
  });

  test('引擎沒有 syncRun（舊版）：只有環境健檢的備註', async () => {
    const eg = createFakeEngine({ home: paths.home });
    eg.env = { run: async () => ({ ok: true, written: false, findings: 1, fixed: [] }) };
    const r = await setup({ eg }).jobs.run('env', 'manual');
    assert.equal(r.note, '1 項發現');
  });
});
