// 本機紀錄的清理（2.0.0 WP4a）：每週打包（eg.gc.run）時順便刪掉 local/usage/{recall,search,guardrails}/ 超過 90 天的每日紀錄檔、
// local/cache/session/ 超過 7 天的 .mod 標記檔；開場快取 state.json 與其他檔案不動。清理不影響統計（統計最多只看近 90 天）。
// 全部用合成資料，不會碰到真正的 ~/.engram 或 ~/.claude。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { machinePaths, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

const DAY = 86_400_000;
let root;
let eg;
const now = Date.now();
const day = (ago) => new Date(now - ago * DAY).toISOString().slice(0, 10);
const put = (rel, text, mtimeAgoDays = null) => {
  const p = path.join(eg.paths.local, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  if (mtimeAgoDays !== null) {
    const t = new Date(now - mtimeAgoDays * DAY);
    fs.utimesSync(p, t, t);
  }
  return p;
};
const row = (ago, extra) => `${JSON.stringify({ at: new Date(now - ago * DAY).toISOString(), session: 's', ...extra })}\n`;

before(async () => {
  root = mkTmp();
  const m = machinePaths(root, 'pc');
  await init({ ...m, machineLabel: '工作室桌機', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
});
after(() => rmTmp(root));

test('每週打包時刪掉超過 90 天的紀錄檔與超過 7 天的標記檔，結果寫在回傳值；統計不受影響', async () => {
  const keep = [
    put(`usage/recall/${day(1)}.jsonl`, row(1, { ref: 'global/a.md', score: 4 })),
    put(`usage/recall/${day(2)}.a1b2c3d4.jsonl`, row(2, { ref: 'global/b.md', score: 4 })),
    put(`usage/recall/${day(89)}.jsonl`, row(89, { ref: 'global/c.md', score: 4 })),
    put(`usage/search/${day(10)}.jsonl`, row(10, { ref: 'global/a.md' })),
    put(`usage/guardrails/${day(3)}.jsonl`, row(3, { rule: 'rm-shell-variable', kind: 'hint' })),
    put('usage/recall/notes.txt', '不是紀錄檔'),
    put('cache/session/recent.mod', 'guard\n', 2),
    put('cache/session/state.json', '{}', 30), // 開場快取：不管多舊都不動（它由常駐程式重寫）
  ];
  const drop = [
    put(`usage/recall/${day(120)}.jsonl`, row(120, { ref: 'global/a.md', score: 4 })),
    put(`usage/recall/${day(200)}.e5f6a7b8.jsonl`, row(200, { ref: 'global/a.md', score: 4 })),
    put(`usage/search/${day(95)}.jsonl`, row(95, { ref: 'global/a.md' })),
    put(`usage/guardrails/${day(365)}.jsonl`, row(365, { rule: 'rm-shell-variable', kind: 'hint' })),
    put('cache/session/old-1.mod', 'guard\n', 8),
    put('cache/session/old-2.mod', 'recall\n', 40),
  ];
  const before30 = (await eg.recall.usage({ days: 30, now })).length;
  const before90 = (await eg.recall.usage({ days: 90, now })).length;
  const guard30 = await eg.guardrails.usage({ days: 30, now });

  const r = await eg.gc.run({ now });
  assert.equal(r.ok, true);
  assert.deepEqual([r.prunedLogs, r.prunedMarkers], [4, 2]);
  for (const f of keep) assert.ok(fs.existsSync(f), `應該留下：${path.basename(f)}`);
  for (const f of drop) assert.ok(!fs.existsSync(f), `應該刪掉：${path.basename(f)}`);

  assert.equal((await eg.recall.usage({ days: 30, now })).length, before30, '近 30 天的帶出紀錄一筆不少');
  assert.equal((await eg.recall.usage({ days: 90, now })).length, before90, '近 90 天的也一樣');
  assert.deepEqual(await eg.guardrails.usage({ days: 30, now }), guard30);

  const again = await eg.gc.run({ now });
  assert.deepEqual([again.prunedLogs, again.prunedMarkers], [0, 0]);
});

test('紀錄資料夾不存在時照常打包', async () => {
  fs.rmSync(path.join(eg.paths.local, 'usage'), { recursive: true, force: true });
  fs.rmSync(path.join(eg.paths.local, 'cache', 'session'), { recursive: true, force: true });
  const r = await eg.gc.run({ now });
  assert.deepEqual([r.ok, r.prunedLogs, r.prunedMarkers], [true, 0, 0]);
});
