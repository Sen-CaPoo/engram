// 2.0.0 第五輪審查的修正（純函式的部分）。N-5、N-6（相容模式的 machine.json）在 test/core/index-compat.test.mjs。
// N-4：核心準則的那一行，句子中間的 @路徑 也是匯入語法，不收。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { graduateTargetProblem } from '../../src/autopilot/tasks/graduate.mjs';
import { readJson, readJsonSync } from '../../src/core/fsx.mjs';
import { mkTmp, rmTmp } from '../core/helpers.mjs';

describe('N-4 記憶畢業寫進核心準則的那一行', () => {
  const problem = (line) => graduateTargetProblem({ to: 'core', ref: 'global/x.md', line });

  test('句子中間或開頭的 @路徑 都不收（在 CORE.md 裡會被當成匯入，把那個檔案載入每一場對話）', () => {
    for (const line of [
      '@~/.engram/local/notes.md',
      'Follow the team rules in @~/.engram/local/notes.md before any commit.',
      'Always read @../../local/notes.md first.',
      '提交前先看 @docs/rules.md',
    ]) assert.ok(problem(line), line);
  });

  test('一般的一行照收；email 這類字中間的 @ 不算', () => {
    for (const line of ['回覆一律用正體中文', '有問題寄到 team@example.com', '提交訊息寫完整的句子']) assert.equal(problem(line), null, line);
  });

  test('多行、標題、遮蔽標記照舊不收', () => {
    for (const line of ['第一行\n第二行', '# 標題', '金鑰是 ‹已遮蔽›', '']) assert.ok(problem(line), JSON.stringify(line));
  });
});

describe('N-5 readJson：路徑不是檔案時回傳預設值，不丟例外', () => {
  test('同步來的內容把 JSON 檔的位置做成資料夾：readJson 與 readJsonSync 都回傳 fallback', async () => {
    const root = mkTmp();
    try {
      const p = path.join(root, 'machine.json');
      fs.mkdirSync(p);
      fs.writeFileSync(path.join(p, 'x'), 'not json');
      assert.deepEqual(await readJson(p, { fallback: true }), { fallback: true });
      assert.deepEqual(readJsonSync(p, { fallback: true }), { fallback: true });
      // 檔案底下再接路徑（ENOTDIR）也一樣
      const f = path.join(root, 'plain.json');
      fs.writeFileSync(f, '{"a":1}');
      assert.equal(await readJson(path.join(f, 'inner.json'), null), null);
      assert.deepEqual(await readJson(f, null), { a: 1 });
    } finally {
      rmTmp(root);
    }
  });
});
