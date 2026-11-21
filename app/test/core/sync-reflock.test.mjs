// U3：打包（git gc）不持引擎的寫入鎖，會短暫鎖住 ref；同時進行的同步 commit 會因為 cannot lock ref 失敗。
// 這種失敗要當成可重試（E_LOCKED），不計入連續失敗，也不能讓診斷與通知誤判。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { classifyGitError } from '../../src/core/git.mjs';
import { age, ageTree, machinePaths, makeBareRemote, memoryText, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

describe('classifyGitError：ref 鎖定是可重試的 E_LOCKED', () => {
  const samples = [
    ["fatal: cannot lock ref 'HEAD': Unable to create '/x/.git/refs/heads/main.lock': File exists.\n\nAnother git process seems to be running in this repository", ['commit']],
    ["error: cannot lock ref 'refs/remotes/origin/main': Unable to create '/x/.git/refs/remotes/origin/main.lock': File exists.", ['fetch', '--prune', 'origin']],
    ["fatal: Unable to create '/x/.git/packed-refs.lock': File exists.", ['fetch', 'origin']],
    ["error: could not lock config file /x/.git/config: File exists", ['config', '--local', 'gc.auto', '0']],
  ];
  test('commit、fetch、push 遇到 ref 鎖都是 E_LOCKED，訊息講清楚、英文版沒有中文', () => {
    for (const [stderr, args] of samples) {
      const e = classifyGitError({ code: 128, stdout: '', stderr }, args);
      assert.equal(e.code, 'E_LOCKED', stderr);
      assert.match(e.message, /ref|鎖/);
      assert.ok(e.en?.message && !/[一-鿿]/.test(e.en.message + (e.en.hint ?? '')));
    }
    assert.equal(classifyGitError({ code: 128, stdout: '', stderr: "error: failed to push some refs: cannot lock ref 'refs/heads/main'" }, ['push', 'origin']).code, 'E_LOCKED');
  });

  test('一般的錯誤與網路錯誤不受影響', () => {
    assert.equal(classifyGitError({ code: 128, stdout: '', stderr: 'fatal: Could not resolve host: github.com' }, ['fetch']).code, 'E_OFFLINE');
    assert.equal(classifyGitError({ code: 1, stdout: '', stderr: 'something else' }, ['commit']).code, 'E_GIT');
  });
});

describe('同步遇到 ref 鎖：不計入連續失敗', () => {
  let root; let A;
  before(async () => {
    root = mkTmp();
    const cli = writeDriverCli(root);
    const remote = makeBareRemote(path.join(root, 'remote.git'));
    const m = machinePaths(root, 'office');
    await init({ ...m, machineLabel: 'A', remote, cli });
    A = await open(m);
    ageTree(A.paths.vault);
    assert.equal((await A.sync()).ok, true);
  });
  after(() => rmTmp(root));

  test('有人鎖著 refs/heads/main 時 commit 失敗：回報 busy／E_LOCKED，連續失敗不累計、不診斷；鎖放開後下一輪就成功', async () => {
    const lock = path.join(A.paths.vault, '.git', 'refs', 'heads', 'main.lock');
    const file = path.join(A.paths.vault, 'global', 'during-gc.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, memoryText({ name: 'during-gc', description: '打包時寫的', type: 'reference' }));
    age(file);
    fs.writeFileSync(lock, '');
    try {
      for (let i = 0; i < 4; i++) {
        const r = await A.sync();
        assert.equal(r.ok, false);
        assert.equal(r.state, 'busy');
        assert.equal(r.error.code, 'E_LOCKED');
        assert.equal(r.diagnosis, undefined);
        const st = JSON.parse(fs.readFileSync(path.join(A.paths.local, 'state.json'), 'utf8'));
        assert.ok(!st.syncIssue, `第 ${i + 1} 次：不累計連續失敗`);
      }
    } finally {
      fs.rmSync(lock, { force: true });
    }
    ageTree(A.paths.vault);
    const ok = await A.sync();
    assert.equal(ok.ok, true, JSON.stringify(ok.error));
    assert.equal(ok.committed, 1, '寫的記憶沒有丟');
  });
});
