// loadedMemoryIndex：Claude Code 這次對話實際載入的 MEMORY.md 在哪裡（SessionStart 補記用）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadedMemoryIndex } from '../../src/core/identity.mjs';

let root;
let homes;
const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-memidx-'));
  homes = { userHome: path.join(root, 'home'), claudeHome: path.join(root, 'home', '.claude') };
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('loadedMemoryIndex', () => {
  test('從根目錄啟動、settings.local.json 有 autoMemoryDirectory（~ 開頭）時用那裡', () => {
    const proj = path.join(root, 'p1');
    write(path.join(proj, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: '~/.engram/vault/projects/p1/memory' }));
    const index = path.join(homes.userHome, '.engram', 'vault', 'projects', 'p1', 'memory', 'MEMORY.md');
    write(index, '- [a](a.md)\n');
    assert.equal(loadedMemoryIndex(homes, { root: proj, encoded: 'C--p1', fromSub: false }), index);
  });

  test('從子資料夾啟動時 Claude Code 不讀 settings.local.json，改用編碼資料夾', () => {
    const proj = path.join(root, 'p1');
    const index = path.join(homes.claudeHome, 'projects', 'C--p1', 'memory', 'MEMORY.md');
    write(index, '- [b](b.md)\n');
    assert.equal(loadedMemoryIndex(homes, { root: proj, encoded: 'C--p1', fromSub: true }), index);
  });

  test('沒有設定檔綁定（junction 或未綁定）時用編碼資料夾；相對路徑以專案根目錄解析', () => {
    const proj = path.join(root, 'p2');
    const index = path.join(homes.claudeHome, 'projects', 'C--p2', 'memory', 'MEMORY.md');
    write(index, '- [c](c.md)\n');
    assert.equal(loadedMemoryIndex(homes, { root: proj, encoded: 'C--p2', fromSub: false }), index);

    const proj3 = path.join(root, 'p3');
    write(path.join(proj3, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: 'notes/memory' }));
    write(path.join(proj3, 'notes', 'memory', 'MEMORY.md'), '- [d](d.md)\n');
    assert.equal(loadedMemoryIndex(homes, { root: proj3, encoded: 'C--p3', fromSub: false }), path.join(proj3, 'notes', 'memory', 'MEMORY.md'));
  });

  test('MEMORY.md 不存在或沒有編碼時回傳 null', () => {
    assert.equal(loadedMemoryIndex(homes, { root: path.join(root, 'none'), encoded: 'C--none', fromSub: false }), null);
    assert.equal(loadedMemoryIndex(homes, { root: path.join(root, 'none'), encoded: null, fromSub: true }), null);
  });
});
