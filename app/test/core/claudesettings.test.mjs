// ~/.claude/settings.json 的最小修改（R-24）：只增刪 Engram 自己的項目，修改前備份。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { allowJunctionRead, isJunctionReadAllowed, revokeAll, revokeJunctionRead } from '../../src/core/claudesettings.mjs';
import { resolveHomes } from '../../src/core/paths.mjs';
import { mkTmp, rmTmp } from './helpers.mjs';

function setup(initial) {
  const root = mkTmp();
  const homes = resolveHomes({ home: path.join(root, '.engram'), claudeHome: path.join(root, '.claude'), userHome: root });
  fs.mkdirSync(homes.claudeHome, { recursive: true });
  if (initial !== undefined) fs.writeFileSync(path.join(homes.claudeHome, 'settings.json'), typeof initial === 'string' ? initial : JSON.stringify(initial, null, 2));
  return { root, homes, read: () => JSON.parse(fs.readFileSync(path.join(homes.claudeHome, 'settings.json'), 'utf8')) };
}

test('加入與移除 junction 路徑，其他設定原封不動', async () => {
  const { root, homes, read } = setup({ theme: 'dark', permissions: { defaultMode: 'auto', additionalDirectories: ['D:\\mine'] }, hooks: { Stop: [] } });
  try {
    const j = path.join(homes.claudeHome, 'projects', 'C--x', 'memory');
    assert.equal(await allowJunctionRead(homes, j), true);
    assert.equal(await allowJunctionRead(homes, j), false, '重複加入不會再寫');
    let s = read();
    assert.equal(s.theme, 'dark');
    assert.deepEqual(s.hooks, { Stop: [] });
    assert.equal(s.permissions.defaultMode, 'auto');
    assert.equal(s.permissions.additionalDirectories.length, 2);
    assert.ok(await isJunctionReadAllowed(homes, j));
    await revokeJunctionRead(homes, j);
    s = read();
    assert.deepEqual(s.permissions.additionalDirectories, ['D:\\mine'], '使用者自己的項目保留');
    const backups = fs.readdirSync(path.join(homes.local, 'backups', 'claude-settings'));
    assert.equal(backups.length, 1, '修改前備份一次');
  } finally { rmTmp(root); }
});

test('使用者原本就有的路徑不被接管，解除安裝也不移除', async () => {
  const { root, homes, read } = setup({});
  try {
    const j = path.join(homes.claudeHome, 'projects', 'C--y', 'memory');
    fs.writeFileSync(path.join(homes.claudeHome, 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: [j] } }));
    assert.equal(await allowJunctionRead(homes, j), false);
    await revokeAll(homes);
    assert.deepEqual(read().permissions.additionalDirectories, [j]);
  } finally { rmTmp(root); }
});

test('R-12：撤銷後寫回原始位元組（沒有結尾換行、不同縮排、不同鍵順序）', async () => {
  const original = '{\n    "theme": "dark",\n    "env": {"A": "1"},\n    "permissions": {"allow": ["Bash(ls)"]}\n}';
  const { root, homes } = setup(original);
  try {
    await allowJunctionRead(homes, path.join(homes.claudeHome, 'projects', 'C--q', 'memory'));
    await allowJunctionRead(homes, path.join(homes.claudeHome, 'projects', 'C--r', 'memory'));
    await revokeAll(homes);
    assert.equal(fs.readFileSync(path.join(homes.claudeHome, 'settings.json'), 'utf8'), original);
  } finally { rmTmp(root); }
});

test('settings.json 不存在時建立；撤銷後刪除；損毀時拒絕修改', async () => {
  const a = setup(undefined);
  try {
    await allowJunctionRead(a.homes, path.join(a.homes.claudeHome, 'projects', 'C--z', 'memory'));
    assert.equal(a.read().permissions.additionalDirectories.length, 1);
    await revokeAll(a.homes);
    assert.equal(fs.existsSync(path.join(a.homes.claudeHome, 'settings.json')), false, '原本不存在 → 撤銷後刪除');
  } finally { rmTmp(a.root); }
  const b = setup('{ not json');
  try {
    await assert.rejects(allowJunctionRead(b.homes, 'C:\\x'), /不是有效的 JSON/);
    assert.equal(fs.readFileSync(path.join(b.homes.claudeHome, 'settings.json'), 'utf8'), '{ not json');
  } finally { rmTmp(b.root); }
});
