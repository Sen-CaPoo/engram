// R-43：正式安裝部署版本化的程式複本，current 以 junction 指向使用中的版本；update 與 rollback 只切換 junction。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deploy, rollback, activeVersion, appRoot, listVersions, removeApp, currentDir } from '../../install/deploy.mjs';
import { mkTmp, rmTmp } from '../core/helpers.mjs';

function fakeSource(root, version, marker) {
  const src = path.join(root, `src-${version}-${marker}`);
  for (const d of ['bin', 'src/hooks', 'plugin/hooks', 'install', '.claude-plugin', 'test', 'tools/ui-build/node_modules/x']) fs.mkdirSync(path.join(src, d), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'engram', version }));
  fs.writeFileSync(path.join(src, 'bin', 'engram.mjs'), `// ${marker}\n`);
  fs.writeFileSync(path.join(src, 'src', 'hooks', 'index.mjs'), 'export const main = () => {};\n');
  fs.writeFileSync(path.join(src, 'test', 'x.test.mjs'), '// 不該被部署\n');
  return src;
}

test('部署、更新、回滾、移除', async (t) => {
  const root = mkTmp('engram-deploy-');
  t.after(() => rmTmp(root));
  const home = path.join(root, '.engram');

  const a = await deploy(home, fakeSource(root, '0.1.0', 'A'));
  assert.equal(a.appDir, currentDir(home));
  assert.equal(fs.readFileSync(path.join(a.appDir, 'bin', 'engram.mjs'), 'utf8'), '// A\n', 'current 要指向剛部署的版本');
  assert.ok(!fs.existsSync(path.join(a.versionDir, 'test')), '測試不應部署');
  assert.ok(!fs.existsSync(path.join(a.versionDir, 'tools')), '開發工具不應部署');
  assert.ok(fs.lstatSync(currentDir(home)).isSymbolicLink(), 'current 必須是 junction');

  // 模擬時間差，確保版本排序穩定
  await new Promise((r) => setTimeout(r, 30));
  const b = await deploy(home, fakeSource(root, '0.2.0', 'B'));
  assert.equal(b.previous, a.version);
  assert.equal(fs.readFileSync(path.join(currentDir(home), 'bin', 'engram.mjs'), 'utf8'), '// B\n');
  assert.equal(listVersions(home).length, 2);

  const r = await rollback(home);
  assert.equal(r.version, a.version);
  assert.equal(activeVersion(home), a.version);
  assert.equal(fs.readFileSync(path.join(currentDir(home), 'bin', 'engram.mjs'), 'utf8'), '// A\n');

  await removeApp(home);
  assert.ok(!fs.existsSync(path.join(home, 'app')));
});

test('中斷的部署留下的 .tmp- 資料夾不算版本：列出、退回、清理都略過；下一次部署清掉持有它的程序已經不在的', async (t) => {
  const root = mkTmp('engram-deploy-tmp-');
  t.after(() => rmTmp(root));
  const home = path.join(root, '.engram');
  const pause = () => new Promise((r) => setTimeout(r, 40));
  const a = await deploy(home, fakeSource(root, '0.1.0', 'A'));
  await pause();
  const b = await deploy(home, fakeSource(root, '0.2.0', 'B'));
  // 下一次部署在複製途中斷電：只留下沒複製完的暫存資料夾（修改時間最新），一個是已經不在的程序、一個是還活著的程序（另一個部署正在進行）
  await pause();
  const dead = path.join(appRoot(home), '0.3.0-abcdef0.tmp-2000000000');
  const alive = path.join(appRoot(home), `0.3.0-abcdef0.tmp-${process.ppid}`);
  fs.mkdirSync(dead, { recursive: true });
  fs.mkdirSync(alive, { recursive: true });
  assert.deepEqual(listVersions(home).map((v) => v.name).sort(), [a.version, b.version].sort(), '暫存資料夾不是版本');
  // 手動退回（沒指定目標）不會切到半成品
  const r = await rollback(home);
  assert.equal(r.version, a.version);
  assert.ok(fs.existsSync(path.join(currentDir(home), 'bin', 'engram.mjs')), 'current 底下有程式');
  // 下一次部署：持有者已經不在的暫存資料夾清掉；還活著的程序的不動（但一樣不算版本，也不佔保留名額）
  await pause();
  const c = await deploy(home, fakeSource(root, '0.4.0', 'C'));
  assert.ok(!fs.existsSync(dead), '已經不在的程序留下的暫存資料夾被清掉');
  assert.ok(fs.existsSync(alive), '還活著的程序的暫存資料夾不能動');
  assert.deepEqual(listVersions(home).map((v) => v.name).sort(), [a.version, b.version, c.version].sort(), '保留名額沒被暫存資料夾佔掉');
});

test('rollback 可以指定目標；剛被取代的版本（previous）不會被 prune 刪掉，就算它的修改時間最舊', async (t) => {
  const root = mkTmp('engram-deploy-prev-');
  t.after(() => rmTmp(root));
  const home = path.join(root, '.engram');
  const pause = () => new Promise((r) => setTimeout(r, 40));
  const a = await deploy(home, fakeSource(root, '0.1.0', 'A'));
  await pause();
  const b = await deploy(home, fakeSource(root, '0.2.0', 'B'));
  await pause();
  const c = await deploy(home, fakeSource(root, '0.3.0', 'C'));
  // 指定退回到最舊的 A（預設會選修改時間最新的另一個版本，也就是 B）
  assert.equal((await rollback(home, a.version)).version, a.version);
  assert.equal(activeVersion(home), a.version);
  await assert.rejects(rollback(home, 'no-such-version'), (e) => e.code === 'E_NOT_FOUND');
  // 部署 D：previous 是 A（修改時間最舊），仍要保留；其餘版本依修改時間，總共留 3 個
  await pause();
  const d = await deploy(home, fakeSource(root, '0.4.0', 'D'));
  assert.equal(d.previous, a.version);
  assert.deepEqual(listVersions(home).map((v) => v.name).sort(), [a.version, c.version, d.version].sort());
  assert.ok(!listVersions(home).some((v) => v.name === b.version), '最舊的其他版本（B）才被刪');
  assert.equal((await rollback(home, a.version)).version, a.version, '退得回 previous');
});
