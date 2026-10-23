// R-43：正式安裝部署版本化的程式複本，current 以 junction 指向使用中的版本；update 與 rollback 只切換 junction。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deploy, rollback, activeVersion, listVersions, removeApp, currentDir } from '../../install/deploy.mjs';
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
