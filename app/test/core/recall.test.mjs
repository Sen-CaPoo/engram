// 情境召回（2.0.0 WP4a P3）的引擎端：建 local/cache/recall.json。
// 每筆記憶在哪些對話會被載入（全域與單機索引、專案的 MEMORY.md、開場訊息）、其他電腦的單機記憶不帶、疑似金鑰被遮蔽、大小上限、沒變就不重建。
// 全部用合成資料，不會碰到真正的 ~/.engram 或 ~/.claude。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_INDEX_BYTES, parseIndex, score } from '../../plugin/hooks/lens/recall.mjs';
import { init, open } from '../../src/core/index.mjs';
import { machinePaths, makeRepo, memoryText, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

let root;
let m;
let eg;
let repo;
let pid;

const file = () => path.join(eg.paths.local, 'cache', 'recall.json');
const load = () => parseIndex(fs.readFileSync(file(), 'utf8'));
const doc = (ix, ref) => ix.docs.find((d) => d.ref === ref);
const write = (rel, text) => {
  const p = path.join(eg.paths.vault, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
// 測試用的假金鑰在執行時拼接，原始碼裡不出現完整格式
const FAKE_TOKEN = ['gh', 'p_', 'Q7wErTy9UiOp1AsDfGh3JkLzXcVbNm0Pq2Ws'].join('');

before(async () => {
  root = mkTmp();
  m = machinePaths(root, 'home');
  await init({ ...m, machineLabel: '工作室桌機', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
  repo = makeRepo(path.join(root, 'work', 'bakery'));
  pid = (await eg.identity.bind(repo, { create: { name: '烘焙坊' } })).pid;

  await eg.memories.create({ scope: { kind: 'global' }, name: 'listed-rule', type: 'feedback', description: '回覆要先給結論', body: '先講結論。' });
  await eg.memories.create({ scope: { kind: 'project', pid }, name: 'cake-deposit', type: 'project', description: '客製蛋糕先收三成訂金，取貨前兩天內不能退', body: '訂金在下單時付清。' });
  // 沒有列在索引裡的記憶（直接寫檔，沒有重建索引）
  write('global/oven-thermometer.md', memoryText({ name: 'oven-thermometer', type: 'reference', description: '烤箱溫度計用沸水校正', body: `校正前先預熱。權杖放在 ${FAKE_TOKEN} 這裡是錯的。` }));
  write(`projects/${pid}/memory/courier-webhook.md`, memoryText({ name: 'courier-webhook', description: '外送平台的 webhook 要驗簽章並用訂單編號去重', body: '外送平台會重送。' }));
  write(`machines/${eg.machine.id}/dev-port.md`, memoryText({ name: 'dev-port', type: 'reference', description: '這台的開發伺服器用 7311 port', body: '預設的連接埠被別的工具占用。', extra: `  engram:\n    project: ${pid}\n` }));
  write('machines/m-other0000/other-only.md', memoryText({ name: 'other-only', type: 'reference', description: '另一台電腦才有的事', body: '只在那台成立。' }));
});
after(() => rmTmp(root));

describe('建索引', () => {
  test('全域、專案與這台電腦的記憶都在；其他電腦的單機記憶不帶', async () => {
    const r = await eg.recall.rebuild();
    assert.equal(r.rebuilt, true);
    const ix = load();
    assert.ok(ix, '讀得回來');
    const refs = ix.docs.map((d) => d.ref);
    assert.ok(refs.includes('global/oven-thermometer.md'));
    assert.ok(refs.includes(`projects/${pid}/memory/courier-webhook.md`));
    assert.ok(refs.includes(`machines/${eg.machine.id}/dev-port.md`));
    assert.ok(!refs.some((x) => x.startsWith('machines/m-other0000/')));
    assert.equal(ix.mid, eg.machine.id);
  });

  test('loaded：全域索引列的是 *、專案 MEMORY.md 列的是那個專案、開場訊息列的單機記憶是那個專案、沒列的是 null', () => {
    const ix = load();
    assert.equal(doc(ix, 'global/listed-rule.md').loaded, '*');
    assert.equal(doc(ix, 'global/oven-thermometer.md').loaded, null);
    assert.equal(doc(ix, `projects/${pid}/memory/cake-deposit.md`).loaded, pid);
    assert.equal(doc(ix, `projects/${pid}/memory/courier-webhook.md`).loaded, null);
    assert.equal(doc(ix, `projects/${pid}/memory/courier-webhook.md`).pid, pid);
    assert.equal(doc(ix, `machines/${eg.machine.id}/dev-port.md`).loaded, pid);
    assert.equal(doc(ix, `machines/${eg.machine.id}/dev-port.md`).pid, pid);
  });

  test('路徑是 ~/.engram/vault/… 的寫法；綁定的資料夾放在 roots', () => {
    const ix = load();
    assert.equal(doc(ix, 'global/oven-thermometer.md').path, '~/.engram/vault/global/oven-thermometer.md');
    assert.deepEqual(ix.roots.map((r) => r.pid), [pid]);
    assert.equal(ix.roots[0].path, repo.replace(/\\/g, '/').toLowerCase());
  });

  test('疑似金鑰被遮蔽：索引檔裡找不到原值', () => {
    const text = fs.readFileSync(file(), 'utf8');
    assert.ok(!text.includes(FAKE_TOKEN));
    assert.ok(!text.includes(FAKE_TOKEN.toLowerCase()));
  });

  test('用索引計分：沒列在索引的帶得出來，列了的不帶', () => {
    const ix = load();
    assert.deepEqual(score(ix, '烤箱溫度計要怎麼用沸水校正').map((h) => h.ref), ['global/oven-thermometer.md']);
    assert.deepEqual(score(ix, '客製蛋糕的訂金可以退嗎', { pid }), []);
  });

  test('「列出」只算清單項目開頭的連結（允許粗體）；說明句裡提到檔案、被「另有 N 筆未列出」省略的都不算', async () => {
    const memDir = path.join(eg.paths.vault, 'projects', pid, 'memory');
    const indexPath = path.join(memDir, 'MEMORY.md');
    const before = fs.readFileSync(indexPath, 'utf8');
    write(`projects/${pid}/memory/bold-item.md`, memoryText({ name: 'bold-item', description: '粗體包住連結的那一行' }));
    write(`projects/${pid}/memory/prose-only.md`, memoryText({ name: 'prose-only', description: '只在說明句裡被提到' }));
    write(`projects/${pid}/memory/omitted.md`, memoryText({ name: 'omitted', description: '被省略的記憶' }));
    fs.writeFileSync(indexPath, [
      '# 專案記憶',
      '- **[bold-item](bold-item.md)** — 粗體',
      '詳細的流程寫在 [prose-only](prose-only.md)，需要時再讀。',
      '- 參考：見 [prose-only](prose-only.md)',
      '- 另有 1 筆未列出，可用 `engram search <關鍵字>` 查詢。',
      '',
    ].join('\n'));
    try {
      await eg.recall.rebuild();
      const ix = load();
      assert.equal(doc(ix, `projects/${pid}/memory/bold-item.md`).loaded, pid);
      assert.equal(doc(ix, `projects/${pid}/memory/prose-only.md`).loaded, null, '說明句裡的連結不算列出');
      assert.equal(doc(ix, `projects/${pid}/memory/omitted.md`).loaded, null, '被省略的要能帶出');
    } finally {
      fs.writeFileSync(indexPath, before);
      for (const f of ['bold-item', 'prose-only', 'omitted']) fs.rmSync(path.join(memDir, `${f}.md`), { force: true });
      await eg.recall.rebuild();
    }
  });

  test('記憶、索引與綁定都沒變就不重建；改了記憶就重建', async () => {
    assert.equal((await eg.recall.rebuild()).rebuilt, false);
    write('global/oven-thermometer.md', memoryText({ name: 'oven-thermometer', type: 'reference', description: '烤箱溫度計用沸水校正（改過）', body: '校正前先預熱。' }));
    assert.equal((await eg.recall.rebuild()).rebuilt, true);
    assert.match(doc(load(), 'global/oven-thermometer.md').desc, /改過/);
    fs.rmSync(file());
    assert.equal((await eg.recall.rebuild()).rebuilt, true, '檔案不見了就重建');
  });

  test(`大量的記憶：檔案控制在 ${MAX_INDEX_BYTES / 1024 / 1024} MB 以內，每筆記憶都還在`, async () => {
    let seed = 11;
    // Math.imul：一般的乘法超過 2^53 會失去精度，序列很快就重複，內文會變成一樣的
    const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    const han = () => String.fromCodePoint(0x4e00 + Math.floor(rand() * 6000));
    for (let i = 0; i < 48; i++) {
      write(`global/bulk-${String(i).padStart(3, '0')}.md`, memoryText({ name: `bulk-${i}`, type: 'reference', description: `大量測試 ${i}`, body: Array.from({ length: 4000 }, han).join('') }));
    }
    const r = await eg.recall.rebuild();
    assert.equal(r.rebuilt, true);
    assert.ok(r.bytes <= MAX_INDEX_BYTES, `${r.bytes} bytes`);
    assert.ok(r.cap > 0, `有裁切：${JSON.stringify(r)}`);
    assert.ok(fs.statSync(file()).size <= MAX_INDEX_BYTES);
    assert.equal(load().docs.filter((d) => d.ref.startsWith('global/bulk-')).length, 48);
  });

  test('索引不是記憶：recall.json 在 local/cache，不在 vault', () => {
    assert.ok(file().startsWith(eg.paths.local));
    assert.ok(!fs.existsSync(path.join(eg.paths.vault, 'cache')));
  });
});
