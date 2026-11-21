// S1 的實機驗證：真引擎＋真的 fs.watch。Windows 的 fs.watch 連「最後存取時間」更新也會回報 change，
// 而同步會讀遍 vault 裡的每個檔案；舊做法每次同步後都會多排一次空的本機存檔。
// 在不更新存取時間的檔案系統上，這個測試只驗證「真的改了檔案就會排存檔」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createJobs } from '../../src/agent/jobs.mjs';
import { createLogger } from '../../src/cli/log.mjs';
import { localPaths } from '../../src/cli/paths.mjs';
import { init, open } from '../../src/core/index.mjs';
import { machinePaths } from '../core/helpers.mjs';
import { mkTmp, rmTmp } from './helpers.mjs';

let root; let eg; let paths; let jobs;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const walk = (dir, fn) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, fn); else fn(p);
  }
};

before(async () => {
  root = mkTmp('engram-watch-');
  const m = machinePaths(root, 'office');
  process.env.ENGRAM_HOME = m.home;
  process.env.CLAUDE_HOME = m.claudeHome;
  delete process.env.ENGRAM_HEADLESS;
  paths = localPaths();
  await init({ ...m, machineLabel: '測試電腦', userName: 'Tester' });
  eg = await open(m);
  await eg.memories.create({ scope: { kind: 'global' }, name: 'note-one', type: 'reference', description: '第一筆', body: '內容。' });
  await eg.sync({ network: false });
  // 所有排程工作都標成剛跑過，背景綁定關閉：tick 只負責啟動監看（打包也要標，否則第一次 tick 會真的 git gc）
  const ran = new Date().toISOString();
  fs.writeFileSync(paths.jobsFile, JSON.stringify({
    jobs: { ...Object.fromEntries(['sync', 'health', 'probe', 'rename', 'gc', 'env'].map((id) => [id, { lastRunAt: ran }])), bind: { enabled: false } },
    versionCheckedAt: ran, claudeVersion: '2.1.0', probe: { claudeVersion: '2.1.0', ok: true, checks: [] },
  }));
  jobs = createJobs({
    eg, paths, events: { emit() {} }, log: createLogger(paths.logs, 'agent'), notifier: { notify: async () => true },
    runProbe: async () => null, detectVersion: async () => '2.1.0',
  });
  await jobs.tick(); // 開始監看 vault 並記下每個檔案的簽章
  await tick(300);
});

after(async () => {
  await jobs?.stop();
  rmTmp(root);
});

const watchDue = () => jobs.list().find((j) => j.id === 'watch').nextRunAt;

/** 等到條件成立（最多 5 秒）：事件送達的時間受電腦忙碌程度影響，肯定句不能只等固定時間 */
const until = async (cond) => { for (let i = 0; i < 50 && !cond(); i++) await tick(100); };

test('S1 實機：最後存取時間過期後由同步讀檔造成的事件不排存檔；真的改了記憶檔才排', async () => {
  // 讓 vault 內每個檔案的最後存取時間過期（修改時間不動），再讓同步把它們全部讀一遍
  walk(eg.paths.vault, (p) => fs.utimesSync(p, (Date.now() - 5 * 3600_000) / 1000, Math.round(fs.statSync(p).mtimeMs) / 1000));
  await tick(300);
  assert.equal(watchDue(), null, '改存取時間本身不算變更');
  const r = await eg.sync({ network: false });
  assert.equal(r.ok, true);
  await tick(700);
  assert.equal(watchDue(), null, '同步讀檔造成的事件不該排出存檔');

  const note = path.join(eg.paths.vault, 'global', 'note-one.md');
  fs.writeFileSync(note, `${fs.readFileSync(note, 'utf8')}\n新增一行。\n`);
  await until(() => watchDue() !== null);
  assert.notEqual(watchDue(), null, '真的改了記憶檔 → 排存檔');
});
