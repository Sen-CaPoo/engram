// 情境召回的帶出紀錄檔名（2.0.0 WP4a）：mod 每個程序各寫 <UTC 日期>.<程序代號>.jsonl，指令型後備寫 <UTC 日期>.jsonl。
// 讀紀錄的每個地方（讀取統計的 recalled、每週摘要的帶出次數、召回頁的並行觀察）都要把同一天的檔一起算。
// 全部用合成資料，不會碰到真正的 ~/.engram 或 ~/.claude。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseWeek, weekOf } from '../../src/autopilot/digest.mjs';
import { init, open } from '../../src/core/index.mjs';
import { machinePaths, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

let root;
let eg;
let ref;
const NOW = Date.now();
const R = parseWeek(weekOf(NOW));
const at = Math.min(NOW - 60_000, R.start + 3_600_000);
const day = new Date(at).toISOString().slice(0, 10);

before(async () => {
  root = mkTmp();
  const m = machinePaths(root, 'pc');
  await init({ ...m, machineLabel: '工作室桌機', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
  ref = (await eg.memories.create({ scope: { kind: 'global' }, name: 'oven-thermometer', type: 'reference', description: '烤箱溫度計用沸水校正', body: '校正前先預熱。' })).ref;
  const dir = path.join(eg.paths.local, 'usage', 'recall');
  fs.mkdirSync(dir, { recursive: true });
  const row = (session) => `${JSON.stringify({ at: new Date(at).toISOString(), session, ref, score: 4 })}\n`;
  fs.writeFileSync(path.join(dir, `${day}.jsonl`), row('s-fallback')); // 指令型後備
  fs.writeFileSync(path.join(dir, `${day}.a1b2c3d4.jsonl`), row('s-mod-1')); // mod，一個程序
  fs.writeFileSync(path.join(dir, `${day}.e5f6a7b8.jsonl`), row('s-mod-2')); // mod，另一個程序
});
after(() => rmTmp(root));

test('讀取統計：同一天的各個紀錄檔都算進 recalled', async () => {
  await eg.usage.refresh({ force: true });
  assert.equal((await eg.usage.get(ref)).recalled, 3);
});

test('每週摘要：同一天的各個紀錄檔都算進帶出次數', async () => {
  const d = await eg.digest.get(weekOf(NOW), { now: NOW });
  assert.equal(d.recall.surfaced, 3);
});

test('召回頁的並行觀察：同一天的各個紀錄檔都算', async () => {
  const s = await eg.recall.status({ now: NOW });
  assert.equal(s.observe.recalled, 3);
});
