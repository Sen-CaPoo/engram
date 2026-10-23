// GET /api/claude-plugin 的後端：依 Claude Code 使用者設定判斷外掛狀態，列出外掛裡的 /engram 技能。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { claudePluginStatus, listSkills, PLUGIN_ID } from '../../src/agent/plugin.mjs';
import { mkTmp, rmTmp } from './helpers.mjs';

let root;
before(() => { root = mkTmp(); });
after(() => rmTmp(root));

function claudeHomeWith(name, settings, installed) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), `\uFEFF${JSON.stringify(settings)}`); // 有 BOM 也要讀得懂
  if (installed) fs.writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify(installed));
  return dir;
}

test('技能清單：讀外掛的 SKILL.md，附指令與參數提示', async () => {
  const skills = await listSkills();
  const inbox = skills.find((s) => s.name === 'inbox');
  assert.ok(inbox);
  assert.equal(inbox.command, '/engram:inbox');
  assert.match(inbox.description, /收件匣/);
  assert.ok(inbox.argumentHint);
  for (const n of ['tidy', 'save', 'recall']) assert.ok(skills.some((s) => s.name === n), `缺少 ${n}`);
});

test('已啟用 → ready，不需要任何指令', async () => {
  const r = await claudePluginStatus({ claudeHome: claudeHomeWith('ready', { enabledPlugins: { [PLUGIN_ID]: true } }), installFile: path.join(root, 'none.json') });
  assert.equal(r.state, 'ready');
  assert.deepEqual(r.commands, []);
  assert.ok(r.skills.length >= 5);
});

test('停用 → disabled，給 enable 指令', async () => {
  const r = await claudePluginStatus({ claudeHome: claudeHomeWith('off', { enabledPlugins: { [PLUGIN_ID]: false } }), installFile: path.join(root, 'none.json') });
  assert.equal(r.state, 'disabled');
  assert.deepEqual(r.commands, [`claude plugin enable ${PLUGIN_ID}`]);
});

test('沒有安裝 → missing，外掛來源指向安裝清單的 appDir（~/.engram/app/current）', async () => {
  const installFile = path.join(root, 'install.json');
  fs.writeFileSync(installFile, JSON.stringify({ appDir: 'C:\\Users\\x\\.engram\\app\\current' }));
  const r = await claudePluginStatus({ claudeHome: claudeHomeWith('none', null), installFile });
  assert.equal(r.state, 'missing');
  assert.deepEqual(r.commands, ['claude plugin marketplace add "C:\\Users\\x\\.engram\\app\\current"', `claude plugin install ${PLUGIN_ID} --scope user`]);
});

test('只有 installed_plugins.json 有紀錄、設定沒有 → disabled', async () => {
  const r = await claudePluginStatus({ claudeHome: claudeHomeWith('legacy', {}, { plugins: { [PLUGIN_ID]: [{ scope: 'user' }] } }), installFile: path.join(root, 'none.json') });
  assert.equal(r.state, 'disabled');
});
