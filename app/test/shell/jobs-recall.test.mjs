// 常駐程式與情境召回、開場快取（2.0.0 WP4a）：本機存檔與網路同步之後重建 recall.json、更新開場用的快取；失敗不影響存檔與同步。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { createJobs } from '../../src/agent/jobs.mjs';
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

const T0 = new Date(2026, 10, 21, 11, 0, 0).getTime();
const OK = { ok: true, state: 'ok', committed: 1, pulled: 0, pushed: false, conflicts: [], held: [], skipped: { recent: [], secrets: [] } };

function setup(eg) {
  const ran = new Date(T0).toISOString();
  fs.mkdirSync(paths.local, { recursive: true });
  fs.writeFileSync(paths.jobsFile, JSON.stringify({ jobs: Object.fromEntries(['sync', 'health', 'probe', 'curate', 'gc', 'env'].map((id) => [id, { lastRunAt: ran }])), versionCheckedAt: ran, claudeVersion: '2.1.329' }));
  const jobs = createJobs({
    eg,
    paths,
    events: { emit: () => {} },
    log: createLogger(paths.logs, 'agent'),
    notifier: { notify: async () => {} },
    runProbe: async () => ({ ok: true, checks: [] }),
    detectVersion: async () => '2.1.329',
    now: () => T0,
  });
  created.push(jobs);
  return jobs;
}

describe('情境召回的索引', () => {
  test('本機存檔與網路同步之後都重建索引（記憶沒變時引擎自己會略過），並更新開場的快取', async () => {
    const eg = createFakeEngine({ home: paths.home });
    const calls = [];
    eg.sync = async () => { calls.push('sync'); return OK; };
    eg.recall = { rebuild: async () => { calls.push('rebuild'); return { rebuilt: true }; } };
    eg.sessionCache = { write: async () => { calls.push('cache'); return { roots: 1 }; } };
    const jobs = setup(eg);
    await jobs.run('watch', 'quiet');
    assert.deepEqual(calls, ['sync', 'rebuild', 'cache']);
    await jobs.run('sync', 'manual');
    assert.deepEqual(calls, ['sync', 'rebuild', 'cache', 'sync', 'rebuild', 'cache']);
  });

  test('網路同步之後：有舊版電腦回來、共用的索引分層被自動改回時，通知一次（說明是哪一台、升級後可以再切回去）', async () => {
    const eg = createFakeEngine({ home: paths.home });
    const calls = [];
    eg.sync = async () => OK;
    let reverted = [{ mid: 'back-pc-0004', label: '門市舊桌機', version: '1.5.0' }];
    eg.recall = {
      guardLayers: async () => { calls.push('guard'); const r = { reverted }; reverted = []; return r; },
      rebuild: async () => { calls.push('rebuild'); return { rebuilt: true }; },
    };
    const notified = [];
    const ran = new Date(T0).toISOString();
    fs.mkdirSync(paths.local, { recursive: true });
    fs.writeFileSync(paths.jobsFile, JSON.stringify({ jobs: Object.fromEntries(['sync', 'health', 'probe', 'curate', 'gc', 'env'].map((id) => [id, { lastRunAt: ran }])), versionCheckedAt: ran, claudeVersion: '2.1.329' }));
    const jobs = createJobs({ eg, paths, events: { emit: () => {} }, log: createLogger(paths.logs, 'agent'), notifier: { notify: async (n) => notified.push(n) }, runProbe: async () => ({ ok: true, checks: [] }), detectVersion: async () => '2.1.329', now: () => T0 });
    created.push(jobs);
    await jobs.run('sync', 'manual');
    assert.deepEqual(calls, ['guard', 'rebuild'], '先檢查再重建召回的索引');
    assert.equal(notified.length, 1);
    assert.match(notified[0].body, /門市舊桌機（1\.5\.0）/);
    assert.match(notified[0].body, /更新/);
    // 文字要符合實際行為：索引分層改回 observe，同時共用的索引暫時照舊版的方式產生（相容模式）、更新之後自動切換；不能說成「已避免」之類的保證
    assert.match(notified[0].body, /相容模式/);
    assert.match(notified[0].body, /更新之後索引會自動切換/);
    assert.doesNotMatch(notified[0].body, /為了避免兩台互相改寫索引/);
    assert.match(notified[0].en.body, /門市舊桌機 \(1\.5\.0\)/);
    assert.match(notified[0].en.body, /compatibility mode/);
    assert.match(notified[0].en.body, /switch back automatically/);
    await jobs.run('sync', 'manual');
    assert.equal(notified.length, 1, '已經改回 observe，不再通知');
    // 本機存檔不檢查（其他電腦的版本只會在網路同步之後改變）
    await jobs.run('watch', 'quiet');
    assert.equal(calls.filter((c) => c === 'guard').length, 2);
  });

  test('每週打包順便清掉的紀錄檔與標記檔寫進工作的備註（中英）；沒有清掉時不提', async () => {
    const eg = createFakeEngine({ home: paths.home });
    let pruned = { prunedLogs: 4, prunedMarkers: 2 };
    eg.gc = { run: async () => ({ ok: true, ms: 1200, clearedPid: false, prunedBackups: 0, ...pruned, before: { loose: 10, packs: 1 }, after: { loose: 0, packs: 1 } }) };
    const jobs = setup(eg);
    await jobs.run('gc', 'manual');
    const r = jobs.list().find((j) => j.id === 'gc').lastResult;
    assert.match(r.note, /已清除 4 個超過 90 天的紀錄檔、2 個超過 7 天的開場標記檔/);
    assert.match(r.en.note, /Removed 4 log files older than 90 days and 2 session markers older than 7 days/);
    pruned = { prunedLogs: 0, prunedMarkers: 0 };
    await jobs.run('gc', 'manual');
    assert.doesNotMatch(jobs.list().find((j) => j.id === 'gc').lastResult.note, /紀錄檔/);
  });

  test('開場的快取寫不了只寫 warn，存檔照常成功', async () => {
    const eg = createFakeEngine({ home: paths.home });
    eg.sync = async () => OK;
    eg.sessionCache = { write: async () => { throw new Error('locked'); } };
    const jobs = setup(eg);
    assert.equal((await jobs.run('watch', 'quiet')).ok, true);
    const warns = (await readLogs(paths.logs, 'agent')).filter((e) => e.src === 'session-cache' && e.level === 'warn');
    assert.equal(warns.length, 1);
  });

  test('重建失敗只寫 warn，存檔的結果照常是成功', async () => {
    const eg = createFakeEngine({ home: paths.home });
    eg.sync = async () => OK;
    eg.recall = { rebuild: async () => { throw new Error('disk full'); } };
    const jobs = setup(eg);
    const r = await jobs.run('watch', 'quiet');
    assert.equal(r.ok, true);
    const warns = (await readLogs(paths.logs, 'agent')).filter((e) => e.src === 'recall' && e.level === 'warn');
    assert.equal(warns.length, 1);
  });

  test('舊版引擎沒有 recall 時照常存檔、不報錯', async () => {
    const eg = createFakeEngine({ home: paths.home });
    eg.sync = async () => OK;
    delete eg.recall;
    const jobs = setup(eg);
    assert.equal((await jobs.run('watch', 'quiet')).ok, true);
  });
});
