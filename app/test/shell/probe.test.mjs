// 相容性探測：不真的呼叫 claude，改用注入的假執行器；確認回傳格式、環境變數清理與暫存資料的清除。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CONTRACTS } from '../../src/cli/probe/contracts.mjs';
import { childEnv, encodePath, runProbe } from '../../src/cli/probe/index.mjs';
import { mkTmp, rmTmp, useHomes } from './helpers.mjs';

let root;
before(() => {
  root = mkTmp();
  useHomes(root);
});
after(() => rmTmp(root));

describe('相容性探測', () => {
  test('C1–C7 七個契約', () => {
    assert.deepEqual(CONTRACTS.map((c) => c.id), ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']);
    for (const c of CONTRACTS) assert.match(c.label, /[一-鿿]/);
  });

  test('每個契約都有英文名稱（管理介面切到英文時顯示）', () => {
    for (const c of CONTRACTS) {
      assert.ok(c.en?.label, c.id);
      assert.doesNotMatch(c.en.label, /[一-鿿]/, c.id);
    }
  });

  test('清掉父 session 的環境變數，並讓探測用的 session 跳過 Engram hooks', () => {
    const env = childEnv({
      PATH: 'x', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: '1',
      CLAUDE_CODE_MESSAGING_SOCKET: 'a', MESSAGING_TOKEN: 'b', CLAUDE_EFFORT: 'high', ANTHROPIC_API_KEY: 'keep',
    });
    assert.deepEqual(env, { PATH: 'x', ANTHROPIC_API_KEY: 'keep', ENGRAM_HEADLESS: '1' });
  });

  test('回傳 { at, claudeVersion, ok, checks[] }；暫存資料夾與編碼資料夾都清掉', async () => {
    const claudeHome = path.join(root, '.claude');
    const prompts = [];
    const runner = async (cwd, prompt, opts) => {
      prompts.push({ cwd, tools: !!opts?.tools });
      return 'NONE';
    };
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('engram-probe-')));
    const r = await runProbe({ runner, claudeHome, version: async () => '2.1.306' });
    assert.deepEqual(Object.keys(r), ['at', 'claudeVersion', 'ok', 'checks']);
    assert.equal(r.claudeVersion, '2.1.306');
    assert.equal(r.ok, false);
    for (const c of r.checks) {
      assert.deepEqual(Object.keys(c), ['id', 'label', 'ok', 'detail', 'en']);
      assert.deepEqual(Object.keys(c.en), ['label', 'detail']);
      assert.equal(c.en.label, CONTRACTS.find((x) => x.id === c.id).en.label);
      assert.doesNotMatch(c.en.detail, /[一-鿿]/, `${c.id} 的英文說明不能有中文`);
    }
    // 固定的中文說明有對應的英文；原始輸出原樣保留
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    assert.match(byId.C5.detail, /仍在頂層/);
    assert.equal(byId.C5.en.detail, 'Still at the top level (behavior changed, for reference only)');
    assert.match(byId.C2.en.detail, /^Expected .* · Actual NONE$/);
    assert.equal(byId.C1.en.detail, 'NONE');
    const ok = Object.fromEntries(r.checks.map((c) => [c.id, c.ok]));
    // 假執行器什麼都不做：只有不依賴 claude 回覆的 C5（欄位仍在頂層）與 C7（Node 判定 junction）通過
    assert.deepEqual(ok, { C1: false, C2: false, C3: false, C4: false, C5: true, C6: false, C7: true });
    assert.equal(prompts.length, 6);
    assert.ok(prompts.every((p) => p.cwd.startsWith(os.tmpdir()) || p.cwd.toLowerCase().startsWith(fs.realpathSync.native(os.tmpdir()).toLowerCase())));
    const leftover = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('engram-probe-') && !before.has(n));
    assert.deepEqual(leftover, []);
    const projects = path.join(claudeHome, 'projects');
    assert.deepEqual(fs.existsSync(projects) ? fs.readdirSync(projects) : [], [], 'C3 建立的 junction 與編碼資料夾要清掉');
  });

  test('only 只跑指定的契約', async () => {
    const r = await runProbe({ runner: async () => '', claudeHome: path.join(root, '.claude2'), only: ['C7'], version: async () => null });
    assert.deepEqual(r.checks.map((c) => c.id), ['C7']);
    assert.equal(r.ok, true);
  });

  test('路徑編碼與 Claude Code 相同', () => {
    assert.equal(encodePath('C:\\Users\\Sen\\Desktop\\Claude_專案記憶'), 'C--Users-Sen-Desktop-Claude-----');
  });
});
