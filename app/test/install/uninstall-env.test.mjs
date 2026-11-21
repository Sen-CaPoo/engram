// 解除安裝時，環境設定同步（2.0.0 WP8）沒還原的項目、出錯、重寫前的備份位置都要印出來，不能悄悄吞掉。
// 用假引擎（releaseMachine 回傳固定的結果）和暫存資料夾；不碰真實的 ~/.engram 與 ~/.claude。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runUninstall } from '../../install/uninstall.mjs';
import { mkTmp, rmTmp } from '../core/helpers.mjs';

function setup(release, { purge = false } = {}) {
  const root = mkTmp('engram-uninstall-env-');
  const home = path.join(root, '.engram');
  const claudeHome = path.join(root, '.claude');
  fs.mkdirSync(path.join(home, 'local'), { recursive: true });
  fs.mkdirSync(path.join(home, 'vault', '.git'), { recursive: true });
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.writeFileSync(path.join(home, 'local', 'install-steps.json'), JSON.stringify({ steps: [] }));
  const printed = [];
  const asked = [];
  const engine = { open: async () => ({ releaseMachine: async () => ({ ok: true, released: [], revokedPaths: 0, ...release }) }) };
  const io = { print: (s) => printed.push(s), confirm: async (q) => { asked.push(q); return true; } };
  const run = () => runUninstall({ home, claudeHome, engine, yes: !purge, purge }, io);
  return { root, home, printed, asked, run, done: () => rmTmp(root) };
}

test('沒還原的項目與原因、出錯、備份位置都印出來；回傳 envWarnings', async () => {
  const s = setup({
    envRestored: 2,
    envBackup: 'C:\\fake\\.claude\\settings.json.engram-backup-2026',
    envKept: [{ key: 'env:A_MODE', reason: 'invalid' }, { key: 'setting:theme', reason: 'changed' }, { key: 'skill:alpha/SKILL.md', reason: 'link' }],
    envError: { code: 'E_LOCKED', message: 'Engram 正在進行另一項操作' },
  });
  try {
    const r = await s.run();
    assert.equal(r.ok, true);
    const text = s.printed.join('\n');
    assert.match(text, /已還原 2 項環境設定同步套用過的設定與技能/);
    assert.match(text, /settings\.json 的排版不是標準格式，已整個備份成 C:\\fake\\\.claude\\settings\.json\.engram-backup-2026/);
    assert.match(text, /這些環境設定沒有還原，請手動移除或確認：/);
    assert.match(text, /- env:A_MODE（settings\.json 不是有效的 JSON）/);
    assert.match(text, /- setting:theme（套用之後被你改過，沒有動）/);
    assert.match(text, /- skill:alpha\/SKILL\.md（路徑是連結，不穿越）/);
    assert.match(text, /- 還原環境設定時出錯：Engram 正在進行另一項操作（E_LOCKED）/);
    assert.equal(r.envWarnings.length, 4);
  } finally { s.done(); }
});

test('全部還原：不印警告；--purge 時有沒還原的項目，確認問題會提醒紀錄與備份會一起刪掉', async () => {
  const clean = setup({ envRestored: 1 });
  try {
    const r = await clean.run();
    assert.equal(r.envWarnings, undefined);
    assert.ok(!clean.printed.join('\n').includes('沒有還原'));
  } finally { clean.done(); }
  const purge = setup({ envKept: [{ key: 'env:A_MODE', reason: 'format' }] }, { purge: true });
  try {
    await purge.run();
    assert.ok(purge.asked.some((q) => /1 項環境設定沒有還原.*刪除後就沒有了/s.test(q)));
    assert.ok(!fs.existsSync(purge.home), '確認之後照常刪除');
  } finally { purge.done(); }
});
