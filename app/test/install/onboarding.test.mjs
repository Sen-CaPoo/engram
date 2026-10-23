// 讓新電腦更容易裝：需要 gh 時提前擋下、自動判斷第一台或第二台、一般終端機的 engram 指令（npm 全域連結）。
// gh 與 npm 一律用假的外部指令，不碰真正的 GitHub、npm 全域資料夾、~/.engram 與 ~/.claude。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findVaultRepo, npmCliPath, preflight, runInstall, runUpdate } from '../../install/install.mjs';
import { runUninstall } from '../../install/uninstall.mjs';
import { APP_DIR } from '../../src/cli/paths.mjs';
import { run } from '../../src/cli/proc.mjs';
import * as engine from '../../src/core/index.mjs';
import { mkTmp, rmTmp, machinePaths } from '../core/helpers.mjs';

const NOT_FOUND = "GraphQL: Could not resolve to a Repository with the name 'tester/engram-vault'. (repository)";

/** 假的 gh、npm 與 claude --version；其餘（git 與 claude 的其他指令）交給真正的 run。 */
function fakeExec({ login = 'tester', repoExists = false, viewErr = NOT_FOUND, prefix = null } = {}) {
  const calls = [];
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false });
  const fail = (stderr) => ({ code: 1, stdout: '', stderr, timedOut: false });
  const exec = async (cmd, args = [], opts) => {
    calls.push([cmd, ...args]);
    if (cmd === 'gh') {
      if (args[0] === 'auth') return login ? ok() : fail('You are not logged into any GitHub hosts.');
      if (args[0] === 'api') return ok(`${login}\n`);
      if (args[0] === 'repo' && args[1] === 'view') return repoExists ? ok('{"name":"engram-vault"}') : fail(viewErr);
      return fail(`fake gh：沒有預期 ${args.join(' ')}`);
    }
    if (cmd === process.execPath && args[1] === 'prefix') return prefix ? ok(`${prefix}\n`) : fail('no prefix');
    if (cmd === process.execPath) return ok(); // npm install／uninstall -g
    if (cmd === 'claude' && args[0] === '--version') return ok('2.1.0 (Claude Code)\n');
    return run(cmd, args, opts);
  };
  return { exec, calls, npm: (sub) => calls.filter((c) => c[0] === process.execPath && c[2] === sub) };
}

function setup(t) {
  const root = mkTmp('engram-onboard-');
  t.after(() => rmTmp(root));
  const m = machinePaths(root, 'pc');
  fs.mkdirSync(m.claudeHome, { recursive: true });
  fs.writeFileSync(path.join(m.claudeHome, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'auto' } }));
  return { root, m };
}

function printer() {
  const lines = [];
  return { lines, io: { print: (s) => lines.push(s), confirm: async () => true } };
}

test('需要 gh 卻沒有登入時，在寫入任何東西之前就擋下', async (t) => {
  const { m } = setup(t);
  const noGh = fakeExec({ login: '' });
  for (const o of [{ autoRemote: true }, { createRemote: true }]) {
    const f = await preflight({ home: m.home, claudeHome: m.claudeHome, ...o, run: noGh.exec });
    assert.ok(f.problems.some((p) => /gh auth login/.test(p)), JSON.stringify(o));
  }
  const withUrl = await preflight({ home: m.home, claudeHome: m.claudeHome, remote: 'https://example.com/v.git', autoRemote: false, run: noGh.exec });
  assert.ok(!withUrl.problems.some((p) => /gh/.test(p)), '指定 --remote 時不需要 gh');
  const local = await preflight({ home: m.home, claudeHome: m.claudeHome, run: noGh.exec });
  assert.deepEqual(local.problems, [], '--local 不需要 gh');

  const { lines, io } = printer();
  const r = await runInstall({ home: m.home, claudeHome: m.claudeHome, autoRemote: true, yes: true, run: noGh.exec, engine }, io);
  assert.equal(r.ok, false);
  assert.match(lines.join('\n'), /✗ 需要已登入的 GitHub CLI/);
  assert.equal(fs.existsSync(m.home), false, '擋下時什麼都不能寫');
});

test('自動判斷記憶庫：GitHub 上已有就接上、沒有就建立、查詢失敗不猜', async (t) => {
  const { m } = setup(t);
  assert.deepEqual(await findVaultRepo(fakeExec({ repoExists: true }).exec), { login: 'tester', url: 'https://github.com/tester/engram-vault.git', exists: true });
  assert.equal((await findVaultRepo(fakeExec({ repoExists: false }).exec)).exists, false);
  assert.match((await findVaultRepo(fakeExec({ viewErr: 'error connecting to api.github.com' }).exec)).error, /error connecting/);

  const second = printer();
  const r2 = await runInstall({ home: m.home, claudeHome: m.claudeHome, autoRemote: true, dryRun: true, plugin: false, schedule: false, run: fakeExec({ repoExists: true }).exec }, second.io);
  assert.equal(r2.ok, true);
  assert.match(second.lines.join('\n'), /接上你 GitHub 上既有的記憶庫 https:\/\/github\.com\/tester\/engram-vault\.git/);

  const first = printer();
  await runInstall({ home: m.home, claudeHome: m.claudeHome, autoRemote: true, dryRun: true, plugin: false, schedule: false, run: fakeExec({ repoExists: false }).exec }, first.io);
  assert.match(first.lines.join('\n'), /用 gh 在你的 GitHub 建立私人 repo「engram-vault」/);

  const offline = printer();
  const r3 = await runInstall({ home: m.home, claudeHome: m.claudeHome, autoRemote: true, dryRun: true, run: fakeExec({ viewErr: 'error connecting to api.github.com' }).exec }, offline.io);
  assert.equal(r3.ok, false, '連不上 GitHub 時不能當成第一台而另建記憶庫');
  assert.equal(fs.existsSync(m.home), false);
});

test('終端機的 engram 指令：安裝時連結、update 後重新連結、移除時只刪自己的', { skip: !npmCliPath() }, async (t) => {
  const { root, m } = setup(t);
  const prefix = path.join(root, 'npm-global');
  fs.mkdirSync(path.join(prefix, 'node_modules'), { recursive: true });
  const fx = fakeExec({ prefix });
  const env = { ENGRAM_HOME: process.env.ENGRAM_HOME, CLAUDE_HOME: process.env.CLAUDE_HOME };
  process.env.ENGRAM_HOME = m.home; process.env.CLAUDE_HOME = m.claudeHome;
  t.after(() => { for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

  const { lines, io } = printer();
  const inst = await runInstall({ home: m.home, claudeHome: m.claudeHome, yes: true, schedule: false, plugin: false, cliLink: true, label: '測試電腦', run: fx.exec, engine }, io);
  assert.equal(inst.ok, true, lines.join('\n'));
  assert.match(lines.join('\n'), /讓一般終端機.*也能直接輸入 engram/);
  const linked = fx.npm('install');
  assert.equal(linked.length, 1);
  assert.deepEqual(linked[0].slice(3), ['-g', '--no-audit', '--no-fund', path.join(m.home, 'app', 'current')]);
  const steps = JSON.parse(fs.readFileSync(path.join(m.home, 'local', 'install-steps.json'), 'utf8')).steps;
  assert.ok(steps.some((s) => s.kind === 'cli-link'), '要記進安裝紀錄，移除時才會還原');

  await runUpdate({ home: m.home, restartAgent: false, run: fx.exec }, printer().io);
  assert.equal(fx.npm('install').length, 2, 'npm 連到實際的版本資料夾，換版後要重新連結');

  // 使用者後來把 engram 換成別的東西：移除 Engram 時不能動它
  const elsewhere = path.join(root, 'someone-else');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(prefix, 'node_modules', 'engram'), 'junction');
  const foreign = await preflight({ home: m.home, claudeHome: m.claudeHome, cliLink: true, run: fx.exec });
  assert.ok(foreign.warnings.some((w) => /另一個 engram/.test(w)), '已有別的 engram 時提醒、不覆蓋');
  await runUninstall({ home: m.home, claudeHome: m.claudeHome, yes: true, run: fx.exec, engine }, printer().io);
  assert.equal(fx.npm('uninstall').length, 0);
});

test('移除 Engram 時刪掉指向 Engram 程式的 engram 指令', { skip: !npmCliPath() }, async (t) => {
  const { root, m } = setup(t);
  const prefix = path.join(root, 'npm-global');
  fs.mkdirSync(path.join(prefix, 'node_modules'), { recursive: true });
  const fx = fakeExec({ prefix });
  const env = { ENGRAM_HOME: process.env.ENGRAM_HOME, CLAUDE_HOME: process.env.CLAUDE_HOME };
  process.env.ENGRAM_HOME = m.home; process.env.CLAUDE_HOME = m.claudeHome;
  t.after(() => { for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

  await runInstall({ home: m.home, claudeHome: m.claudeHome, yes: true, schedule: false, plugin: false, cliLink: true, label: '測試電腦', run: fx.exec, engine }, printer().io);
  // 模擬 npm 建立的連結：指向部署的版本資料夾
  fs.symlinkSync(fs.realpathSync(path.join(m.home, 'app', 'current')), path.join(prefix, 'node_modules', 'engram'), 'junction');
  const { lines, io } = printer();
  await runUninstall({ home: m.home, claudeHome: m.claudeHome, yes: true, run: fx.exec, engine }, io);
  assert.match(lines.join('\n'), /移除一般終端機的 engram 指令/);
  assert.deepEqual(fx.npm('uninstall').map((c) => c.slice(3)), [['-g', 'engram']]);
});

test('從部署的複本再執行 install（例如終端機的 engram install）：沿用部署、不改寫原始程式位置', async (t) => {
  const { m } = setup(t);
  const env = { ENGRAM_HOME: process.env.ENGRAM_HOME, CLAUDE_HOME: process.env.CLAUDE_HOME };
  process.env.ENGRAM_HOME = m.home; process.env.CLAUDE_HOME = m.claudeHome;
  t.after(() => { for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const infoFile = path.join(m.home, 'local', 'install.json');

  await runInstall({ home: m.home, claudeHome: m.claudeHome, yes: true, schedule: false, plugin: false, label: '測試電腦', engine }, printer().io);
  const before = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  assert.equal(before.sourceDir, APP_DIR);
  const versions = fs.readdirSync(path.join(m.home, 'app')).sort();

  const deployed = await import(pathToFileURL(path.join(m.home, 'app', 'current', 'install', 'install.mjs')).href);
  const { lines, io } = printer();
  const again = await deployed.runInstall({ home: m.home, claudeHome: m.claudeHome, yes: true, schedule: false, plugin: false, engine }, io);
  assert.equal(again.ok, true, lines.join('\n'));
  assert.match(lines.join('\n'), /沿用已部署的程式/);
  assert.deepEqual(fs.readdirSync(path.join(m.home, 'app')).sort(), versions, '複本不是 git 工作樹，不能再部署出 -local 版本');
  assert.equal(JSON.parse(fs.readFileSync(infoFile, 'utf8')).sourceDir, APP_DIR, 'engram update 的來源必須仍是原始程式資料夾');

  // 舊版留下的錯誤紀錄（來源指向複本）：update 要停下來說明，不能默默用舊程式「更新」
  fs.writeFileSync(infoFile, JSON.stringify({ ...before, sourceDir: path.join(m.home, 'app', 'current') }));
  const upd = printer();
  assert.equal((await runUpdate({ home: m.home, restartAgent: false }, upd.io)).ok, false);
  assert.match(upd.lines.join('\n'), /--from/);
});
