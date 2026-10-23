// R-23：目標檔被其他程式獨占開啟時，安全寫入回報 busy、不遺失資料、不留暫存檔。鎖的過期接手與重入。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { safeWriteResult, setTempDir } from '../../src/core/fsx.mjs';
import { withLock } from '../../src/core/lock.mjs';
import { mkTmp, rmTmp } from './helpers.mjs';

test('目標檔被獨占開啟 → busy；釋放後可寫入；不留 .tmp', { skip: process.platform !== 'win32' }, async () => {
  const root = mkTmp();
  try {
    const tmpDir = path.join(root, 'tmp');
    setTempDir(tmpDir);
    const target = path.join(root, 'vault', 'MEMORY.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'original\n');
    const ready = path.join(root, 'ready');
    // PowerShell 以 FileShare None 開啟目標檔 2 秒
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$f=[System.IO.File]::Open('${target}','Open','ReadWrite','None'); New-Item -ItemType File '${ready}' | Out-Null; Start-Sleep -Milliseconds 2500; $f.Close()`], { windowsHide: true });
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(ready), 'PowerShell 已開啟檔案');
    const r = await safeWriteResult(target, 'new\n');
    assert.deepEqual(r, { ok: false, reason: 'busy' });
    await new Promise((res) => ps.on('close', res));
    assert.equal(fs.readFileSync(target, 'utf8'), 'original\n', '資料不遺失');
    const r2 = await safeWriteResult(target, 'new\n');
    assert.equal(r2.ok, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new\n');
    const leftovers = [...fs.readdirSync(tmpDir), ...fs.readdirSync(path.dirname(target))].filter((n) => n.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], '不留暫存檔');
  } finally {
    setTempDir(null);
    rmTmp(root);
  }
});

test('expectHash 不符 → changed，不覆寫', async () => {
  const root = mkTmp();
  try {
    const p = path.join(root, 'a.md');
    fs.writeFileSync(p, 'x');
    const r = await safeWriteResult(p, 'y', { expectHash: 'deadbeef' });
    assert.deepEqual(r, { ok: false, reason: 'changed' });
    assert.equal(fs.readFileSync(p, 'utf8'), 'x');
  } finally { rmTmp(root); }
});

test('鎖：持有程序已不存在 → 接手；同一條呼叫鏈可重入；其他人持有 → E_LOCKED', async () => {
  const root = mkTmp();
  try {
    const lock = path.join(root, 'engram.lock');
    fs.writeFileSync(lock, JSON.stringify({ nonce: 'dead', pid: 2147483646, op: 'old', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
    await withLock(lock, 'a', async () => {
      await withLock(lock, 'b', async () => { assert.ok(fs.existsSync(lock)); }, { waitMs: 100 }); // 重入
      assert.ok(fs.existsSync(lock), '重入結束後外層仍持有');
    }, { waitMs: 500 });
    assert.equal(fs.existsSync(lock), false);
    // 另一個「活著」而且心跳正常的持有者（用目前的父程序模擬）
    fs.writeFileSync(lock, JSON.stringify({ nonce: 'alive', pid: process.ppid, op: 'other', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
    await assert.rejects(withLock(lock, 'c', async () => {}, { waitMs: 300 }), (e) => e.code === 'E_LOCKED');
    // 程序還活著但心跳停太久（卡死或 PID 被重用）→ 接手（m2）
    fs.writeFileSync(lock, JSON.stringify({ nonce: 'hung', pid: process.ppid, op: 'other', startedAt: '2000-01-01T00:00:00Z', heartbeatAt: '2000-01-01T00:00:00Z' }));
    await withLock(lock, 'd', async () => {}, { waitMs: 500 });
    assert.equal(fs.existsSync(lock), false);
  } finally { rmTmp(root); }
});

test('鎖：同一程序內並行的作業依序執行（M3），釋放時不刪別人的鎖（M2）', async () => {
  const root = mkTmp();
  try {
    const lock = path.join(root, 'engram.lock');
    let inside = 0; let maxInside = 0;
    const work = () => withLock(lock, 'w', async () => {
      inside++; maxInside = Math.max(maxInside, inside);
      await new Promise((r) => setTimeout(r, 30));
      inside--;
    }, { waitMs: 5_000 });
    await Promise.all([work(), work(), work(), work()]);
    assert.equal(maxInside, 1);
    // 跨程序：4 個子程序同時搶鎖，任何時刻只有一個在鎖內
    const lockMod = new URL('../../src/core/lock.mjs', import.meta.url).href;
    const counter = path.join(root, 'counter.log');
    const script = `import { withLock } from ${JSON.stringify(lockMod)}; import fs from 'node:fs';
await withLock(${JSON.stringify(lock)}, 'p', async () => { fs.appendFileSync(${JSON.stringify(counter)}, 'in\\n'); await new Promise(r => setTimeout(r, 120)); fs.appendFileSync(${JSON.stringify(counter)}, 'out\\n'); }, { waitMs: 15000 });`;
    const file = path.join(root, 'child.mjs');
    fs.writeFileSync(file, script);
    await Promise.all([1, 2, 3, 4].map(() => new Promise((res, rej) => {
      const c = spawn(process.execPath, [file], { windowsHide: true });
      c.on('close', (code) => (code === 0 ? res() : rej(new Error(`child exit ${code}`))));
    })));
    const seq = fs.readFileSync(counter, 'utf8').trim().split('\n');
    assert.equal(seq.length, 8);
    for (let i = 0; i < seq.length; i += 2) assert.deepEqual(seq.slice(i, i + 2), ['in', 'out'], '不可重疊');
  } finally { rmTmp(root); }
});
