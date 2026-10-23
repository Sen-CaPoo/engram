// engram tidy（/engram:tidy 與 /engram:tidy-apply 技能用）：用真引擎在暫存資料夾測試建立、列出、顯示、執行與記回結果。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { revOf } from '../../src/cli/commands/safe.mjs';
import { main } from '../../src/cli/main.mjs';
import { init, open } from '../../src/core/index.mjs';
import { markReady, setDecisions } from '../../src/tidy/store.mjs';
import { machinePaths, mkTmp, rmTmp, writeDriverCli } from '../core/helpers.mjs';
import { capture } from './helpers.mjs';

const SECRET = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
let root; let m; let eg; let prevHome; let spawned;

before(async () => {
  root = mkTmp('engram-tidy-cli-');
  m = machinePaths(root, 'office');
  prevHome = process.env.ENGRAM_HOME;
  process.env.ENGRAM_HOME = m.home; // 草稿資料夾與常駐程式心跳檔都在暫存資料夾
  await init({ ...m, machineLabel: '公司電腦', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
});
after(() => {
  if (prevHome === undefined) delete process.env.ENGRAM_HOME; else process.env.ENGRAM_HOME = prevHome;
  rmTmp(root);
});

async function engram(argv) {
  const out = capture();
  const err = capture();
  spawned = 0;
  // 不啟動真的常駐程式：spawnNode 只記次數，等待時間縮短
  const code = await main(argv, { loadEngine: async () => eg, stdout: out.stream, stderr: err.stream, stdin: { isTTY: true }, cwd: root, env: {}, spawnNode: () => { spawned++; }, agentWaitMs: 50 });
  return { code, out: out.text, err: err.text, all: out.text + err.text };
}
const json = async (argv) => { const r = await engram([...argv, '--json']); return { ...r, data: JSON.parse(r.out) }; };
const memFile = (name, description, body) => `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: feedback\n---\n\n${body}\n`;

async function draftPlan(name, plan, files) {
  const dir = path.join(m.home, 'local', 'drafts', name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), t);
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan));
  return path.join(dir, 'plan.json');
}

describe('engram tidy', () => {
  let id;
  let a; let b;
  before(async () => {
    a = (await eg.memories.create({ scope: { kind: 'global' }, name: 'cli-a', type: 'feedback', description: '甲', body: '甲的內容。' })).ref;
    b = (await eg.memories.create({ scope: { kind: 'global' }, name: 'cli-b', type: 'feedback', description: '乙', body: '乙的內容。' })).ref;
  });

  test('用法錯誤：缺少 --file、缺少 id、看不懂的子指令', async () => {
    assert.equal((await engram(['tidy', 'create'])).code, 2);
    assert.match((await engram(['tidy', 'create'])).err, /--file/);
    assert.match((await engram(['tidy', 'show'])).err, /請提供整理記錄的 id/);
    assert.match((await engram(['tidy', 'fly'])).err, /看不懂的子指令：fly/);
    assert.match((await engram(['tidy', 'show', 'x/../y'])).err, /不是整理記錄的 id/);
  });

  test('create：建立記錄、印出網址與之後的指令；常駐程式沒在跑時嘗試啟動，失敗也不擋', async () => {
    const file = await draftPlan('t1', {
      scope: 'global',
      summary: '兩筆裡一筆要改寫。',
      items: [
        { ref: a, action: 'update', title: '補充說明', reason: '說明太短', ops: [{ op: 'write', ref: a, base: revOf(fs.readFileSync(path.join(eg.paths.vault, 'global', 'cli-a.md'), 'utf8')), file: 'a.md' }] },
        { ref: b, action: 'keep', title: '保留', reason: '仍然有效', ops: [] },
      ],
    }, { 'a.md': memFile('cli-a', '甲（補充）', '甲的內容，補充細節。') });
    const r = await engram(['tidy', 'create', '--file', file]);
    assert.equal(r.code, 0, r.all);
    id = /已建立整理記錄 (\d{8}-\d{6}-[a-z0-9]{4})/.exec(r.out)[1];
    assert.match(r.out, /全域，2 項：建議變更 1、建議保留 1/);
    assert.match(r.out, new RegExp(`http://127\\.0\\.0\\.1:4777/#/tidy\\?id=${id}`));
    assert.match(r.out, /常駐程式沒有啟動成功/);
    assert.match(r.out, new RegExp(`/engram:tidy-apply ${id}`));
    assert.equal(spawned, 1);
    assert.ok(!fs.existsSync(file), '草稿用完即刪');
  });

  test('list 與 show', async () => {
    const list = await engram(['tidy', 'list']);
    assert.match(list.out, new RegExp(`${id}\\s+全域\\s+待使用者決定`));
    const shown = await engram(['tidy', 'show', id]);
    assert.match(shown.out, /摘要：兩筆裡一筆要改寫。/);
    assert.match(shown.out, /\[i1\] global\/cli-a\.md ｜ 改寫：補充說明/);
    const js = await json(['tidy', 'show', id]);
    assert.equal(js.data.items.length, 2);
    assert.equal(js.data.status, 'pending');
  });

  test('apply：照決定執行，列出依備註調整的項目（備註遮蔽金鑰）與建議的內容；done 記回結果', async () => {
    await setDecisions(eg.paths.local, id, { i1: { decision: 'custom', note: `改短一點，順便別寫 ${SECRET}` }, i2: { decision: 'archive' } });
    await markReady(eg.paths.local, id);
    const r = await engram(['tidy', 'apply', id]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /完成 1 項、維持原狀 0 項、失敗 0 項；1 項依備註調整，交給你處理/);
    assert.match(r.out, /動手前的備份：/);
    assert.match(r.out, /\[i2\] global\/cli-b\.md .*結果：完成（engram undo [0-9a-f]{10}）/);
    assert.match(r.out, /使用者備註：改短一點，順便別寫 ‹已遮蔽：github-token›/);
    assert.match(r.out, /建議的內容：\n\s+│ ---/);
    assert.ok(!r.all.includes(SECRET), '輸出不可以帶出金鑰');
    assert.ok(!fs.existsSync(path.join(eg.paths.vault, 'global', 'cli-b.md')));
    const js = await json(['tidy', 'show', id]);
    assert.ok(!JSON.stringify(js.data).includes(SECRET));
    const w = await eg.memories.write(a, { text: memFile('cli-a', '甲', '短。') });
    const done = await engram(['tidy', 'done', id, 'i1', '--undo', w.undo.sha.slice(0, 10), '--message', '依備註改短']);
    assert.equal(done.code, 0, done.all);
    assert.match(done.out, /已記錄 i1：完成；這份整理記錄全部完成/);
    assert.match((await engram(['tidy', 'apply', id])).err, /已經執行完畢/);
  });

  test('help 列出 tidy', async () => {
    const r = await engram(['help']);
    assert.match(r.out, /tidy create --file <計畫\.json>/);
  });
});
