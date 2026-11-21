// SessionStart hook 的快速路徑（2.0.0 S5）：有可用的快取就不載入引擎，輸出和完整路徑一字不差；
// 補記 MEMORY.md、常駐程式的處理照常；快取不能用時才載入引擎。用真的引擎（暫存資料夾裡的假 Engram）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createLogger } from '../../src/cli/log.mjs';
import { localPaths } from '../../src/cli/paths.mjs';
import { init, open } from '../../src/core/index.mjs';
import { sessionCacheFile } from '../../src/core/sessioncache.mjs';
import { runHook } from '../../src/hooks/index.mjs';
import { machinePaths, makeRepo, mkTmp, rmTmp, writeDriverCli } from '../core/helpers.mjs';

const NOW = Date.now();
let root;
let m;
let eg;
let repo;
let pid;
let saved;

before(async () => {
  saved = { ENGRAM_HOME: process.env.ENGRAM_HOME, CLAUDE_HOME: process.env.CLAUDE_HOME, ENGRAM_HEADLESS: process.env.ENGRAM_HEADLESS };
  root = mkTmp();
  m = machinePaths(root, 'home');
  await init({ ...m, machineLabel: '工作室桌機', userName: 'Tester', cli: writeDriverCli(root) });
  // 和常駐程式、hook 一樣用 ENGRAM_HOME、CLAUDE_HOME 開引擎（家目錄是這台電腦的家目錄）
  process.env.ENGRAM_HOME = m.home;
  process.env.CLAUDE_HOME = m.claudeHome;
  delete process.env.ENGRAM_HEADLESS;
  eg = await open({ home: m.home, claudeHome: m.claudeHome });
  repo = makeRepo(path.join(root, 'work', 'bakery'));
  pid = (await eg.identity.bind(repo, { create: { name: '烘焙坊' } })).pid;
});
after(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmTmp(root);
});

function deps() {
  const paths = localPaths(m.home);
  const calls = { loads: 0, spawned: 0, requests: 0 };
  return {
    calls,
    overrides: {
      paths,
      now: () => NOW,
      log: createLogger(paths.logs, 'hooks'),
      loadEngine: async () => {
        calls.loads++;
        return eg;
      },
      readHeartbeat: () => ({ pid: 1, port: 9, token: 't', beatAt: new Date(NOW - 1000).toISOString(), lastSyncAt: new Date(NOW - 60_000).toISOString() }),
      spawnNode: () => { calls.spawned++; },
      requestAgent: async () => { calls.requests++; return { status: 200 }; },
    },
  };
}

const input = (sid) => ({ session_id: sid, transcript_path: path.join(root, 'x', `${sid}.jsonl`), cwd: repo, hook_event_name: 'SessionStart', source: 'startup' });

describe('SessionStart 的快速路徑', () => {
  test('有可用的快取：不載入引擎，輸出和完整路徑一字不差', async () => {
    await eg.sessionCache.write({ now: NOW - 60_000 });
    const fast = deps();
    const fastOut = await runHook('session-start', input('s-fast'), fast.overrides);
    assert.equal(fast.calls.loads, 0, '沒有載入引擎');
    assert.match(JSON.parse(fastOut).hookSpecificOutput.additionalContext, /^\[Engram\] 工作室桌機（.+）· 專案：烘焙坊/);

    fs.rmSync(sessionCacheFile(eg.paths.local));
    const full = deps();
    const fullOut = await runHook('session-start', input('s-fast'), full.overrides);
    assert.equal(full.calls.loads, 1, '沒有快取時載入引擎');
    assert.equal(fastOut, fullOut);
  });

  test('快速路徑照樣補記 MEMORY.md（含 pid），常駐程式的處理也照常', async () => {
    const mem = path.join(eg.paths.vault, 'projects', pid, 'memory', 'MEMORY.md');
    fs.mkdirSync(path.dirname(mem), { recursive: true });
    fs.writeFileSync(mem, '- [a](a.md) — 說明\n');
    await eg.sessionCache.write({ now: NOW - 60_000 });
    const d = deps();
    await runHook('session-start', input('s-mem'), d.overrides);
    assert.equal(d.calls.loads, 0);
    const rec = JSON.parse(fs.readFileSync(path.join(eg.paths.local, 'loaded', 's-mem.json'), 'utf8'));
    const entry = rec.files.find((f) => f.kind === 'memory-index');
    assert.ok(entry, '補記了 MEMORY.md');
    assert.equal(rec.pid, pid, 'pid 取自快取裡的綁定');
    assert.equal(d.calls.spawned + d.calls.requests, 0, '常駐程式在跑、剛同步過：不啟動、不送請求');
  });

  test('連續失敗的提醒照樣附上（快速路徑也一樣）', async () => {
    await eg.sessionCache.write({ now: NOW - 60_000 });
    fs.writeFileSync(path.join(eg.paths.local, 'hooks-failures.json'), JSON.stringify({ count: 3, last: { message: '測試用的失敗' } }));
    const d = deps();
    const out = JSON.parse(await runHook('session-start', input('s-fail'), d.overrides)).hookSpecificOutput.additionalContext;
    assert.equal(d.calls.loads, 0);
    assert.match(out, /連續失敗 3 次（測試用的失敗）/);
    assert.ok(!fs.existsSync(path.join(eg.paths.local, 'hooks-failures.json')), '成功後歸零');
  });

  test('快取過期就載入引擎走完整路徑', async () => {
    await eg.sessionCache.write({ now: NOW - 16 * 60_000 });
    const d = deps();
    await runHook('session-start', input('s-old'), d.overrides);
    assert.equal(d.calls.loads, 1);
  });
});
