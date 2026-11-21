// S2-4：本機 git 指令逾時（我們自己殺掉程序）不再被當成「連不上遠端」。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { classifyGitError, git } from '../../src/core/git.mjs';
import { E } from '../../src/core/errors.mjs';
import { makeBareRemote, makeRepo, mkTmp, rmTmp } from './helpers.mjs';
import { summarizeSync, summarizeSyncEn } from '../../src/cli/syncresult.mjs';

const killed = (extra = {}) => ({ code: -1, timedOut: true, stdout: '', stderr: '\n[engram] git 指令逾時', ...extra });

describe('classifyGitError：逾時要分本機與網路', () => {
  test('本機 git 指令逾時 → E_GIT_TIMEOUT，訊息講本機，英文版沒有中文', () => {
    for (const cmd of ['status', 'add', 'commit', 'merge', 'gc', 'rev-list', 'ls-files']) {
      const e = classifyGitError(killed(), [cmd, '-q']);
      assert.equal(e.code, E.GIT_TIMEOUT, cmd);
      assert.equal(e.code, 'E_GIT_TIMEOUT');
      assert.match(e.message, /本機/);
      assert.ok(e.hint);
      assert.ok(e.en?.message && e.en?.hint && !/[一-鿿]/.test(e.en.message + e.en.hint), cmd);
      assert.match(e.en.message, /local/i);
    }
  });

  test('只有 code 為 -1（被外力終止、沒有逾時旗標）的本機指令也一樣', () => {
    assert.equal(classifyGitError({ code: -1, stdout: '', stderr: '' }, ['status']).code, E.GIT_TIMEOUT);
  });

  test('網路指令（fetch、push、clone、pull、ls-remote）逾時 → 仍是 E_OFFLINE', () => {
    for (const cmd of ['fetch', 'push', 'clone', 'pull', 'ls-remote']) {
      const e = classifyGitError(killed(), [cmd, 'origin']);
      assert.equal(e.code, E.OFFLINE, cmd);
      assert.match(e.message, /連線逾時/);
    }
  });

  test('git 自己回報的網路逾時與連線失敗文字，不論哪個指令都還是 E_OFFLINE', () => {
    assert.equal(classifyGitError({ code: 128, stdout: '', stderr: 'fatal: unable to access: Operation timed out' }, ['fetch']).code, E.OFFLINE);
    assert.equal(classifyGitError({ code: 128, stdout: '', stderr: 'fatal: Could not resolve host: github.com' }, ['push']).code, E.OFFLINE);
  });

  test('真的跑：本機指令超過 timeoutMs 被終止 → E_GIT_TIMEOUT；網路指令 → E_OFFLINE', async () => {
    const root = mkTmp();
    try {
      const remote = makeBareRemote(path.join(root, 'remote.git'));
      const repo = makeRepo(path.join(root, 'repo'), { remote });
      await assert.rejects(git(['status', '--porcelain'], { cwd: repo, timeoutMs: 1 }), (e) => e.code === 'E_GIT_TIMEOUT');
      await assert.rejects(git(['fetch', 'origin'], { cwd: repo, timeoutMs: 1 }), (e) => e.code === 'E_OFFLINE');
      const r = await git(['status', '--porcelain'], { cwd: repo, timeoutMs: 1, allowFail: true });
      assert.equal(r.timedOut, true);
    } finally {
      rmTmp(root);
    }
  });
});

describe('本機存檔的結果訊息', () => {
  test('不再出現「（未連網）」：存檔本來就只做本機 commit，不是離線', () => {
    const res = { committed: 2, pulled: 0, pushed: false, conflicts: [], held: [], skipped: { recent: [], secrets: [] } };
    const zh = summarizeSync(res, { network: false }).join(' ');
    assert.match(zh, /已完成本機存檔：commit 2 次/);
    assert.doesNotMatch(zh, /未連網|離線/);
    const en = summarizeSyncEn(res, { network: false }).join(' ');
    assert.match(en, /Local save complete: 2 commits/);
    assert.doesNotMatch(en, /not online|offline/i);
  });
});
