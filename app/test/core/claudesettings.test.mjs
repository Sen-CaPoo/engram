// ~/.claude/settings.json 的最小修改（R-24）：只增刪 Engram 自己的項目，修改前備份。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  allowJunctionRead, isJunctionReadAllowed, readInstallManifest, revokeAll, revokeJunctionRead, setSettingIfMissing, withInstallManifest, writeInstallManifest,
} from '../../src/core/claudesettings.mjs';
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

test('2.0.0：setSettingIfMissing 只在沒有這個鍵時設、記進安裝清單；revokeAll 逐位元還原，使用者改過的值不動', async () => {
  // 標準排版（JSON.stringify 能原樣還原）：4 空格縮排、沒有結尾換行；其他部分逐位元不變（不會被重排成 2 空格）
  const original = JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(ls)'] } }, null, 4);
  const a = setup(original);
  try {
    assert.equal(await setSettingIfMissing(a.homes, 'cleanupPeriodDays', 60), true);
    assert.equal(a.read().cleanupPeriodDays, 60);
    assert.equal(await setSettingIfMissing(a.homes, 'cleanupPeriodDays', 90), false, '已經有就不動');
    assert.equal(a.read().cleanupPeriodDays, 60);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a.homes.local, 'install-manifest.json'), 'utf8')).settingKeys, [{ key: 'cleanupPeriodDays', value: 60 }]);
    await revokeAll(a.homes);
    assert.equal(fs.readFileSync(path.join(a.homes.claudeHome, 'settings.json'), 'utf8'), original, 'R-12：撤銷後逐位元一致');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a.homes.local, 'install-manifest.json'), 'utf8')).settingKeys, []);
  } finally { rmTmp(a.root); }
  const b = setup({ theme: 'dark' });
  try {
    await setSettingIfMissing(b.homes, 'cleanupPeriodDays', 60);
    fs.writeFileSync(path.join(b.homes.claudeHome, 'settings.json'), JSON.stringify({ theme: 'dark', cleanupPeriodDays: 14 }));
    await revokeAll(b.homes);
    assert.equal(b.read().cleanupPeriodDays, 14, '使用者後來改過的值保留');
  } finally { rmTmp(b.root); }
});

test('2.0.0（M6）：setSettingIfMissing 遇到排版不是標準格式（手排的緊湊陣列）就拒絕，不重排整個檔', async () => {
  const hand = '{\n  "permissions": { "allow": ["Bash(ls)", "Bash(pwd)"] }\n}\n';
  const a = setup(hand);
  try {
    await assert.rejects(setSettingIfMissing(a.homes, 'cleanupPeriodDays', 60), (e) => e.code === 'E_INVALID' && /排版/.test(e.message) && Boolean(e.en.message));
    assert.equal(fs.readFileSync(path.join(a.homes.claudeHome, 'settings.json'), 'utf8'), hand);
    assert.ok(!fs.existsSync(path.join(a.homes.local, 'install-manifest.json')), '什麼都沒記');
  } finally { rmTmp(a.root); }
});

test('2.0.0（M6）：settings.json 是符號連結（dotfiles repo）時，寫入寫到連結的目標，連結本身保留', async (t) => {
  const a = setup({ theme: 'dark' });
  try {
    const link = path.join(a.homes.claudeHome, 'settings.json');
    const real = path.join(a.root, 'dotfiles-settings.json');
    fs.renameSync(link, real);
    try { fs.symlinkSync(real, link, 'file'); } catch (err) { t.skip(`不能建立檔案符號連結：${err.code}`); return; }
    assert.equal(await setSettingIfMissing(a.homes, 'cleanupPeriodDays', 60), true);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, '連結還在');
    assert.equal(JSON.parse(fs.readFileSync(real, 'utf8')).cleanupPeriodDays, 60, '寫進連結的目標');
    assert.equal(await allowJunctionRead(a.homes, path.join(a.homes.claudeHome, 'projects', 'C--l', 'memory')), true);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(JSON.parse(fs.readFileSync(real, 'utf8')).permissions.additionalDirectories.length, 1);
    await revokeAll(a.homes);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, '解除安裝後連結仍在');
    assert.deepEqual(JSON.parse(fs.readFileSync(real, 'utf8')), { theme: 'dark' });
  } finally { rmTmp(a.root); }
});

test('2.0.0（U4）：安裝清單的更新一律在鎖底下進行：同時很多個 allowJunctionRead，每一筆都記得到', async () => {
  const a = setup({ theme: 'dark' });
  try {
    const paths = Array.from({ length: 12 }, (_, i) => path.join(a.homes.claudeHome, 'projects', `C--p${i}`, 'memory'));
    await Promise.all(paths.map((p) => allowJunctionRead(a.homes, p)));
    const man = JSON.parse(fs.readFileSync(path.join(a.homes.local, 'install-manifest.json'), 'utf8'));
    assert.equal(man.additionalDirectories.length, 12, '沒有任何一筆在讀改寫之間被蓋掉');
    assert.equal(a.read().permissions.additionalDirectories.length, 12);
    await Promise.all(paths.map((p) => revokeJunctionRead(a.homes, p)));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a.homes.local, 'install-manifest.json'), 'utf8')).additionalDirectories, []);
  } finally { rmTmp(a.root); }
});

test('2.0.0（U4）：寫安裝清單時比對讀取時的雜湊：被鎖以外的程式改過就放棄（E_LOCKED），不蓋掉', async () => {
  const a = setup({ theme: 'dark' });
  try {
    await allowJunctionRead(a.homes, path.join(a.homes.claudeHome, 'projects', 'C--q', 'memory'));
    const file = path.join(a.homes.local, 'install-manifest.json');
    const man = await readInstallManifest(a.homes);
    man.note = 'mine';
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), other: 'theirs' }));
    await assert.rejects(writeInstallManifest(a.homes, man), (e) => e.code === 'E_LOCKED');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).other, 'theirs');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).note, undefined);
    // 經過 withInstallManifest 就是讀到最新的再改
    await withInstallManifest(a.homes, async (m, save) => { m.note = 'mine'; await save(); });
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual([after.other, after.note], ['theirs', 'mine'], '另一邊的欄位保留');
  } finally { rmTmp(a.root); }
});
