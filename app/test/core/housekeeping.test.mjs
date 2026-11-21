// S3：心跳（machine.json 的最後上線、最後同步時間）不再單獨成為 commit；記憶庫的 gc.auto 關掉，改由背景工作定期打包。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { ENGINE_VERSION } from '../../src/core/vault.mjs';
import { age, ageTree, git, machinePaths, makeBareRemote, memoryText, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

const H = 3600_000;
let root; let remote; let A; let mA;

const vaultFile = (ref) => path.join(A.paths.vault, ...ref.split('/'));
const machineRef = () => `machines/${A.machine.id}/machine.json`;
const readMachine = () => JSON.parse(fs.readFileSync(vaultFile(machineRef()), 'utf8'));
const commitCount = () => Number(git(A.paths.vault, 'rev-list', '--count', 'HEAD').trim());
const lastFiles = () => git(A.paths.vault, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
const settle = async () => { ageTree(A.paths.vault); const r = await A.sync(); assert.equal(r.ok, true, JSON.stringify(r.error)); return r; };

/** 把心跳寫成 agoMs 之前並提交（模擬「上次寫入是很久以前」） */
function backdate(agoMs, extra = {}) {
  const m = readMachine();
  const t = new Date(Date.now() - agoMs).toISOString();
  fs.writeFileSync(vaultFile(machineRef()), `${JSON.stringify({ ...m, lastSeenAt: t, lastSyncAt: t, ...extra }, null, 2)}\n`);
  git(A.paths.vault, 'add', '-A');
  git(A.paths.vault, 'commit', '-q', '-m', 'test: backdate heartbeat');
  return t;
}

before(async () => {
  root = mkTmp();
  const cli = writeDriverCli(root);
  remote = makeBareRemote(path.join(root, 'remote.git'));
  mA = machinePaths(root, 'office');
  await init({ ...mA, machineLabel: '測試電腦', remote, cli });
  A = await open(mA);
  await settle();
  await settle();
});
after(() => rmTmp(root));

describe('S3 心跳不單獨成為 commit', () => {
  test('上次寫入 7 小時前、沒有其他變更：連續多次同步都不產生 commit，心跳也不改', async () => {
    const stamp = backdate(7 * H);
    await settle();
    const before = commitCount();
    for (let i = 0; i < 4; i++) await settle();
    assert.equal(commitCount(), before, '沒有其他變更就不會有只含心跳的 commit');
    assert.equal(readMachine().lastSeenAt, stamp);
    assert.equal(readMachine().lastSyncAt, stamp);
  });

  test('這次本來就有其他變更要提交：順帶更新心跳，同一個 commit；lastSyncAt 是上一次成功同步的時間，不是現在', async () => {
    backdate(7 * H);
    const prevSuccess = JSON.parse(fs.readFileSync(path.join(A.paths.local, 'state.json'), 'utf8')).sync.lastSuccessAt;
    const before = commitCount();
    fs.writeFileSync(vaultFile('global/piggyback.md'), memoryText({ name: 'piggyback', description: '順帶更新心跳', type: 'reference' }));
    age(vaultFile('global/piggyback.md'));
    await settle();
    assert.equal(commitCount(), before + 1, '只多一個 commit');
    const files = lastFiles();
    assert.ok(files.includes('global/piggyback.md') && files.includes(machineRef()), files.join(','));
    const m = readMachine();
    assert.ok(Date.now() - Date.parse(m.lastSeenAt) < 5 * 60_000, 'lastSeenAt 更新成現在');
    assert.equal(m.lastSyncAt, prevSuccess, 'lastSyncAt 用上一次成功同步的時間：這次的 push 還沒成功就不能蓋「現在」');
    await settle();
    assert.equal(commitCount(), before + 1);
  });

  test('距離上次寫入不到 6 小時：即使有其他變更也不碰心跳', async () => {
    const stamp = backdate(2 * H);
    fs.writeFileSync(vaultFile('global/no-touch.md'), memoryText({ name: 'no-touch', description: '不碰心跳', type: 'reference' }));
    age(vaultFile('global/no-touch.md'));
    await settle();
    assert.equal(readMachine().lastSeenAt, stamp);
    assert.ok(!lastFiles().includes(machineRef()));
  });

  test('超過 24 小時沒寫過：單獨提交一次，之後不再重複', async () => {
    backdate(25 * H);
    const prevSuccess = JSON.parse(fs.readFileSync(path.join(A.paths.local, 'state.json'), 'utf8')).sync.lastSuccessAt;
    const before = commitCount();
    await settle();
    assert.equal(commitCount(), before + 1, '剛好一個 commit');
    assert.deepEqual(lastFiles(), [machineRef()], '只含心跳');
    assert.ok(Date.now() - Date.parse(readMachine().lastSeenAt) < 5 * 60_000);
    assert.equal(readMachine().lastSyncAt, prevSuccess);
    await settle();
    await settle();
    assert.equal(commitCount(), before + 1);
  });

  test('引擎版本改變要馬上寫（不等 6 小時）', async () => {
    backdate(10 * 60_000, { engramVersion: '1.0.0' });
    const before = commitCount();
    await settle();
    assert.equal(readMachine().engramVersion, ENGINE_VERSION);
    assert.equal(commitCount(), before + 1);
  });
});

describe('S3 記憶庫的 gc.auto', () => {
  test('init 之後 gc.auto 是 0；既有的記憶庫（沒設過）在 ensureConfig 時補設', async () => {
    const cfg = () => git(A.paths.vault, 'config', '--local', '--get', 'gc.auto').trim();
    assert.equal(cfg(), '0');
    git(A.paths.vault, 'config', '--local', '--unset', 'gc.auto');
    assert.throws(() => cfg());
    assert.equal(await A.gc.ensureConfig(), true);
    assert.equal(cfg(), '0');
    assert.equal(await A.gc.ensureConfig(), false, '已經是 0 就不動');
  });
});

describe('S3 gc.pid 與打包', () => {
  const pidFile = () => path.join(A.paths.vault, '.git', 'gc.pid');
  const looseCount = () => Number(/^count: (\d+)/m.exec(git(A.paths.vault, 'count-objects', '-v'))[1]);

  test('過期（超過 12 小時、程序不存在）的 gc.pid 被清掉；還新的、或程序還活著的不動', async () => {
    const write = (pid, ageMs) => {
      fs.writeFileSync(pidFile(), `${pid} ${os.hostname()}\n`);
      const t = new Date(Date.now() - ageMs);
      fs.utimesSync(pidFile(), t, t);
    };
    const deadPid = 2_000_000_000;
    write(deadPid, 13 * H);
    assert.deepEqual(await A.gc.status().then((s) => s.stalePid), true);
    write(deadPid, 11 * H);
    assert.equal((await A.gc.status()).stalePid, false, '不到 12 小時不算過期');
    write(process.pid, 13 * H);
    assert.equal((await A.gc.status()).stalePid, false, '程序還活著就不動');
    fs.rmSync(pidFile());
  });

  test('gc.run：清掉過期的 gc.pid、完成打包（零散物件變少），結果有前後數量', async () => {
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(vaultFile(`global/loose-${i}.md`), memoryText({ name: `loose-${i}`, description: `零散物件 ${i}`, type: 'reference', body: `第 ${i} 筆。` }));
      age(vaultFile(`global/loose-${i}.md`));
      await settle();
    }
    const loose = looseCount();
    assert.ok(loose > 6, `前置：有零散物件（${loose}）`);
    fs.writeFileSync(pidFile(), `2000000000 ${os.hostname()}\n`);
    const t = new Date(Date.now() - 13 * H);
    fs.utimesSync(pidFile(), t, t);
    const r = await A.gc.run();
    assert.equal(r.ok, true);
    assert.equal(r.clearedPid, true);
    assert.equal(r.before.loose, loose);
    assert.ok(r.after.loose < loose && looseCount() === r.after.loose);
    assert.equal(fs.existsSync(pidFile()), false);
    assert.equal((await A.status()).vault.head.length > 0, true, '打包後記憶庫正常');
  });

  test('gc.run 可以被中止（常駐程式停止時）：回報逾時／中止的錯誤，gc.pid 不留下', async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(A.gc.run({ signal: ac.signal }), (e) => e.code === 'E_GIT_TIMEOUT');
    assert.equal(fs.existsSync(pidFile()), false);
  });
});

describe('S2 追加：自我修復備份（local/backup）的清理', () => {
  const backupRoot = () => path.join(A.paths.local, 'backup');
  const stampDaysAgo = (days) => new Date(Date.now() - days * 24 * H).toISOString().replace(/[-:.]/g, '');
  /** 建一個備份資料夾；marker 是自我修復建立備份時寫的標記檔 */
  function mkBackup(name, { marker = true } = {}) {
    const dir = path.join(backupRoot(), name);
    fs.mkdirSync(path.join(dir, 'global'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'global', 'note.md'), '備份的本機版本\n');
    if (marker) fs.writeFileSync(path.join(dir, 'heal-backup.json'), JSON.stringify({ v: 1, kind: 'heal-backup', files: ['global/note.md'] }));
    return dir;
  }

  test('每週的 gc 只刪超過 30 天、名稱是時間戳記而且有標記檔的資料夾；其他一律不動', async () => {
    fs.rmSync(backupRoot(), { recursive: true, force: true });
    const old = mkBackup(stampDaysAgo(31));
    const recent = mkBackup(stampDaysAgo(29));
    const oldNoMarker = mkBackup(stampDaysAgo(40), { marker: false });
    const manual = mkBackup('我自己放的備份');
    const longAgo = new Date(Date.now() - 90 * 24 * H);
    fs.utimesSync(manual, longAgo, longAgo);
    // 還有一個未完成的修復（標記檔）指向這個備份：就算很舊也不能刪
    const pending = mkBackup(stampDaysAgo(60));
    fs.writeFileSync(path.join(A.paths.local, 'heal-pending.json'), JSON.stringify({ v: 1, files: [{ ref: 'global/note.md', original: vaultFile('global/note.md'), aside: path.join(A.paths.local, 'tmp', 'x'), backup: path.join(pending, 'global', 'note.md') }] }));
    try {
      const r = await A.gc.run();
      assert.equal(r.prunedBackups, 1);
      assert.equal(fs.existsSync(old), false, '超過 30 天、有標記：刪');
      assert.equal(fs.existsSync(recent), true, '29 天：留');
      assert.equal(fs.existsSync(oldNoMarker), true, '名稱像、但沒有標記檔：留');
      assert.equal(fs.existsSync(manual), true, '不是自我修復建立的（名稱不是時間戳記）：留');
      assert.equal(fs.existsSync(pending), true, '未完成的修復還在用：留');
    } finally {
      fs.rmSync(path.join(A.paths.local, 'heal-pending.json'), { force: true });
      fs.rmSync(backupRoot(), { recursive: true, force: true });
    }
  });

  test('沒有 local/backup 時 gc 照常完成', async () => {
    fs.rmSync(backupRoot(), { recursive: true, force: true });
    const r = await A.gc.run();
    assert.equal(r.ok, true);
    assert.equal(r.prunedBackups, 0);
  });
});

describe('S6 machine.json 記目前安裝的 commit', () => {
  const installFile = () => path.join(A.paths.local, 'install.json');
  after(() => fs.rmSync(installFile(), { force: true }));

  test('沒有安裝紀錄（沙盒、開發模式）：不寫 engramCommit，連續同步也不產生只有心跳的 commit', async () => {
    fs.rmSync(installFile(), { force: true });
    await settle();
    const before = commitCount();
    for (let i = 0; i < 3; i++) await settle();
    assert.equal(commitCount(), before);
    assert.equal(readMachine().engramCommit, undefined);
  });

  test('install.json 的 version 是「版本-commit」：換版本之後馬上寫進 machine.json（單獨一個 commit），之後不再重複', async () => {
    fs.writeFileSync(installFile(), JSON.stringify({ version: `${ENGINE_VERSION}-abc1234`, appDir: 'x' }));
    const before = commitCount();
    await settle();
    assert.equal(readMachine().engramCommit, 'abc1234');
    assert.equal(commitCount(), before + 1);
    assert.deepEqual(lastFiles(), [machineRef()]);
    await settle();
    await settle();
    assert.equal(commitCount(), before + 1, '沒變就不再寫');
    // 部署了新的 commit（含 -dirty 的部署）
    fs.writeFileSync(installFile(), JSON.stringify({ version: `${ENGINE_VERSION}-def5678-dirty` }));
    await settle();
    assert.equal(readMachine().engramCommit, 'def5678-dirty');
    assert.equal(commitCount(), before + 2);
  });

  test('有 commit 欄位時以它為準；安裝紀錄消失（改回開發模式）時移除欄位', async () => {
    fs.writeFileSync(installFile(), JSON.stringify({ version: `${ENGINE_VERSION}-1111111`, commit: '2222222' }));
    await settle();
    assert.equal(readMachine().engramCommit, '2222222');
    fs.writeFileSync(installFile(), JSON.stringify({ version: ENGINE_VERSION, dev: true }));
    await settle();
    assert.equal(readMachine().engramCommit, undefined);
  });
});
