// 安裝前檢查：權限模式的提醒（junction 寫入記憶只有 auto 與 bypassPermissions 不會詢問）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { preflight, runInstall } from '../../install/install.mjs';
import { mkTmp, rmTmp } from '../core/helpers.mjs';

test('預設權限模式不是 auto／bypassPermissions 時提醒，但不阻擋安裝', async (t) => {
  const root = mkTmp('engram-preflight-');
  t.after(() => rmTmp(root));
  const claudeHome = path.join(root, '.claude');
  const home = path.join(root, '.engram');
  fs.mkdirSync(claudeHome, { recursive: true });
  const settings = (mode) => fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify(mode ? { permissions: { defaultMode: mode } } : {}));

  for (const mode of ['auto', 'bypassPermissions']) {
    settings(mode);
    const f = await preflight({ home, claudeHome });
    assert.equal(f.permissionMode, mode);
    assert.deepEqual(f.warnings, []);
  }
  for (const mode of ['acceptEdits', 'manual', null]) {
    settings(mode);
    const f = await preflight({ home, claudeHome });
    assert.equal(f.warnings.length, 1, String(mode));
    assert.match(f.warnings[0], /permissions\.defaultMode 設為 auto/);
    assert.ok(!f.problems.some((p) => /權限/.test(p)), '只提醒，不阻擋');
  }
});

test('找不到可直接執行的 claude（例如只有 npm 安裝的 claude.cmd）時，在任何寫入之前就擋下', async (t) => {
  const root = mkTmp('engram-preflight-');
  t.after(() => rmTmp(root));
  const claudeHome = path.join(root, '.claude');
  const home = path.join(root, '.engram');
  fs.mkdirSync(claudeHome, { recursive: true });
  // Windows 上不經 shell 啟動時，只有 claude.cmd 會得到 ENOENT（Node 只找 .exe／.com）
  const exec = (hasClaude) => async (cmd) => {
    if (cmd === 'claude' && !hasClaude) throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    return { code: 0, stdout: cmd === 'claude' ? '2.1.0 (Claude Code)' : 'git version 2.50.0', stderr: '' };
  };
  const missing = await preflight({ home, claudeHome, run: exec(false) });
  assert.equal(missing.claude, null);
  assert.ok(missing.problems.some((p) => /Claude Code/.test(p) && /官方安裝程式/.test(p)), missing.problems.join('\n'));

  const noPlugin = await preflight({ home, claudeHome, plugin: false, run: exec(false) });
  assert.ok(!noPlugin.problems.some((p) => /Claude Code/.test(p)), '不安裝外掛時不需要 claude');

  const ok = await preflight({ home, claudeHome, run: exec(true) });
  assert.ok(!ok.problems.some((p) => /Claude Code/.test(p)));
});

test('runInstall：claude 無法執行時在任何寫入之前停止（不建立 ~/.engram、不改 CLAUDE.md）', async (t) => {
  const root = mkTmp('engram-preflight-');
  t.after(() => rmTmp(root));
  const claudeHome = path.join(root, '.claude');
  const home = path.join(root, '.engram');
  fs.mkdirSync(claudeHome, { recursive: true });
  const claudeMd = path.join(claudeHome, 'CLAUDE.md');
  fs.writeFileSync(claudeMd, '# 我的準則\n');
  const exec = async (cmd) => {
    if (cmd === 'claude') throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    return { code: 0, stdout: 'git version 2.50.0', stderr: '' };
  };
  const lines = [];
  const io = { print: (s) => lines.push(s), confirm: async () => true };
  const r = await runInstall({ home, claudeHome, yes: true, schedule: false, run: exec }, io);
  assert.equal(r.ok, false);
  assert.match(lines.join('\n'), /✗ 無法執行 Claude Code/);
  assert.equal(fs.existsSync(home), false, '擋下時什麼都不能寫');
  assert.equal(fs.readFileSync(claudeMd, 'utf8'), '# 我的準則\n', 'CLAUDE.md 不能被改動');
});
