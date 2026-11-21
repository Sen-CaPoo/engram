// S6：版本號單一來源（app/package.json）。其他位置靠 tools/set-version.mjs 一次改完，這裡確認它們一致。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVersions, setVersion } from '../../tools/set-version.mjs';
import { ENGINE_VERSION } from '../../src/core/vault.mjs';
import { appVersion } from '../../src/cli/paths.mjs';
import { mkTmp, rmTmp } from './helpers.mjs';

const REPO = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, 'app', 'package.json'), 'utf8')).version;
const EXACT = ['app/package.json', 'app/plugin/.claude-plugin/plugin.json', 'app/.claude-plugin/marketplace.json', '.github/ISSUE_TEMPLATE/bug_report.yml'];
const BADGES = ['README.md', 'README.en.md']; // 版本徽章：替代文字與徽章網址各一處，兩處都要一致
const FILES = [...EXACT, ...BADGES, 'SECURITY.md'];

describe('S6 版本號單一來源', () => {
  test('ENGINE_VERSION 與 appVersion() 都來自 app/package.json', () => {
    assert.match(PKG, /^\d+\.\d+\.\d+$/);
    assert.equal(ENGINE_VERSION, PKG);
    assert.equal(appVersion(), PKG);
  });

  test('外掛設定、市集設定、問題回報範本與安全政策的版本都和 package.json 一致', () => {
    const found = readVersions(REPO);
    const minor = PKG.split('.').slice(0, 2).join('.');
    for (const f of FILES) assert.ok(found[f]?.length, `${f} 找不到版本號`);
    for (const f of EXACT) assert.deepEqual(found[f], [PKG], f);
    for (const f of BADGES) assert.deepEqual(found[f], [PKG, PKG], `${f} 的版本徽章（替代文字與網址）`);
    assert.deepEqual(found['SECURITY.md'], [minor, minor], 'SECURITY.md 中英兩張表的支援版本');
  });

  describe('set-version', () => {
    function copyRepo(t) {
      const dir = mkTmp('engram-setver-');
      t.after(() => rmTmp(dir));
      for (const f of FILES) {
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
      }
      return dir;
    }
    const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');

    test('一次改完所有位置；只換版本，其他位元組（縮排、內嵌物件、其他表格列）原樣保留', (t) => {
      const dir = copyRepo(t);
      const changed = setVersion(dir, '9.8.7');
      assert.deepEqual(changed.sort(), [...FILES].sort());
      const found = readVersions(dir);
      for (const f of EXACT) assert.deepEqual(found[f], ['9.8.7'], f);
      for (const f of BADGES) assert.deepEqual(found[f], ['9.8.7', '9.8.7'], f);
      assert.match(read(dir, 'README.md'), /alt="版本 9\.8\.7" src="https:\/\/img\.shields\.io\/badge\/version-9\.8\.7-0072CE"/);
      assert.match(read(dir, 'README.en.md'), /alt="Version 9\.8\.7" src="https:\/\/img\.shields\.io\/badge\/version-9\.8\.7-0072CE"/);
      assert.deepEqual(found['SECURITY.md'], ['9.8', '9.8']);
      assert.match(read(dir, 'SECURITY.md'), /\| < 9\.8 \| 不支援/);
      assert.match(read(dir, 'SECURITY.md'), /\| < 9\.8 \| Not supported/);
      // 換回去之後和原檔一字不差：證明沒有碰其他內容（尤其是 plugin.json 的內嵌物件與陣列）
      setVersion(dir, PKG);
      for (const f of FILES) assert.equal(read(dir, f), fs.readFileSync(path.join(REPO, f), 'utf8'), f);
    });

    test('重複執行是冪等的；版本相同時不改任何檔案', (t) => {
      const dir = copyRepo(t);
      assert.deepEqual(setVersion(dir, PKG), []);
      setVersion(dir, '3.1.4');
      assert.deepEqual(setVersion(dir, '3.1.4'), []);
    });

    test('版本格式不對就拒絕、不寫任何檔案', (t) => {
      const dir = copyRepo(t);
      for (const bad of ['', '2', '2.0', 'v2.0.0', '2.0.0-beta', '2.0.0.1', undefined]) {
        assert.throws(() => setVersion(dir, bad), /X\.Y\.Z/, String(bad));
      }
      for (const f of FILES) assert.equal(read(dir, f), fs.readFileSync(path.join(REPO, f), 'utf8'));
    });

    test('某個位置對不上預期（例如範本被改了格式）：整批不寫入並指出是哪個檔案', (t) => {
      const dir = copyRepo(t);
      const f = path.join(dir, '.github/ISSUE_TEMPLATE/bug_report.yml');
      fs.writeFileSync(f, read(dir, '.github/ISSUE_TEMPLATE/bug_report.yml').replace(/engram \d+\.\d+\.\d+/, 'engram X'));
      assert.throws(() => setVersion(dir, '9.9.9'), /bug_report\.yml/);
      assert.deepEqual(readVersions(dir)['app/package.json'], [PKG], '前面的檔案也不能被改');
    });
  });
});
