// 索引分層是所有電腦共用的設定（2.0.0 WP4a）：兩台電腦透過 bare repo（代替 GitHub）同步。
// 一台切到 on 並同步後，另一台算出同樣的索引、情境召回被強制開啟、連續同步不再產生索引的 commit；
// 有舊版電腦時不能切到 on；兩台同時改時留較新的那份。全部用合成資料，不會碰到真正的 ~/.engram 或 ~/.claude。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { ageTree, git, machinePaths, makeBareRemote, memoryText, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

let root;
let A;
let B;
const LAYER = /^- 另有 (\d+) 筆參考類記憶不在索引，相關時會自動帶出/m;
const read = (eg, ref) => fs.readFileSync(path.join(eg.paths.vault, ...ref.split('/')), 'utf8');
const indexCommits = (eg) => git(eg.paths.vault, 'log', '--format=%H', '--', 'global/INDEX.md').trim().split('\n').filter(Boolean).length;

async function syncBoth() {
  ageTree(A.paths.vault); ageTree(B.paths.vault);
  const a = await A.sync(); ageTree(B.paths.vault);
  const b = await B.sync(); ageTree(A.paths.vault);
  const a2 = await A.sync();
  for (const r of [a, b, a2]) assert.equal(r.ok, true, JSON.stringify(r.error));
}

before(async () => {
  root = mkTmp();
  const cli = writeDriverCli(root);
  const remote = makeBareRemote(path.join(root, 'remote.git'));
  const mA = machinePaths(root, 'office');
  const mB = machinePaths(root, 'home');
  await init({ ...mA, machineLabel: '倉庫筆電', remote, cli });
  A = await open(mA);
  assert.equal((await A.sync()).ok, true);
  await init({ ...mB, machineLabel: '門市桌機', remote, cli });
  B = await open(mB);
  assert.equal((await B.sync()).ok, true);
  await A.sync();
  for (const [name, type] of [['rule-one', 'feedback'], ['ref-one', 'reference'], ['ref-two', 'reference']]) {
    fs.writeFileSync(path.join(A.paths.vault, 'global', `${name}.md`), memoryText({ name, type, description: `${name} 的說明` }));
  }
  await syncBoth();
});
after(() => rmTmp(root));

describe('所有電腦共用的索引分層', () => {
  test('有舊版的電腦時不能切到 on，列出是哪一台', async () => {
    const p = path.join(A.paths.vault, 'machines', B.machine.id, 'machine.json');
    const before = fs.readFileSync(p, 'utf8');
    fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(before), engramVersion: '1.5.0', lastSeenAt: new Date().toISOString() }));
    try {
      await assert.rejects(A.settings.set({ indexLayers: 'on' }), (e) => e.code === 'E_INVALID' && /門市桌機（1\.5\.0）/.test(e.message));
      assert.equal((await A.settings.get()).indexLayers, 'observe');
    } finally {
      fs.writeFileSync(p, before);
    }
  });

  test('一台切到 on 並同步後：另一台算出同樣的索引、情境召回被強制開啟、連續同步不再產生索引的 commit', async () => {
    await B.settings.set({ recall: 'off' }); // 門市桌機本機關掉了情境召回
    await A.settings.set({ indexLayers: 'on' });
    assert.match(read(A, 'global/INDEX.md'), LAYER, '改設定當下就重建');
    await syncBoth();

    assert.equal(read(B, 'global/INDEX.md'), read(A, 'global/INDEX.md'));
    assert.equal(LAYER.exec(read(B, 'global/INDEX.md'))?.[1], '2');
    assert.doesNotMatch(read(B, 'global/INDEX.md'), /\[ref-one\]/);
    const s = await B.settings.get();
    assert.deepEqual([s.indexLayers, s.recall, s.recallForced], ['on', 'on', true]);
    await assert.rejects(B.settings.set({ recall: 'off' }), (e) => e.code === 'E_INVALID' && /強制開啟/.test(e.message));
    assert.match(read(B, `machines/${B.machine.id}/INDEX.md`), /^# 單機記憶/m);

    const [ca, cb] = [indexCommits(A), indexCommits(B)];
    await syncBoth();
    await syncBoth();
    assert.equal(indexCommits(A), ca, '倉庫筆電沒有新的索引 commit');
    assert.equal(indexCommits(B), cb, '門市桌機沒有新的索引 commit');
    assert.equal(read(B, 'global/INDEX.md'), read(A, 'global/INDEX.md'));
  });

  test('兩台同時改：合併後兩台都留 updatedAt 較新的那份，沒有衝突紀錄', async () => {
    await A.settings.set({ indexLayers: 'off' });
    await new Promise((r) => setTimeout(r, 30));
    await B.settings.set({ indexLayers: 'observe' });
    await syncBoth();
    assert.equal(JSON.parse(read(A, 'settings.json')).indexLayers, 'observe');
    assert.equal(read(A, 'settings.json'), read(B, 'settings.json'));
    assert.equal((await A.settings.get()).indexLayers, 'observe');
    assert.equal((await B.settings.get()).recall, 'off', '分層關掉之後，門市桌機回到自己的設定');
    assert.doesNotMatch(read(A, 'global/INDEX.md'), LAYER);
    assert.equal(read(B, 'global/INDEX.md'), read(A, 'global/INDEX.md'));
    const conflicts = path.join(A.paths.vault, 'conflicts');
    const ids = fs.existsSync(conflicts) ? fs.readdirSync(conflicts).filter((n) => n.startsWith('cf_')) : [];
    for (const id of ids) assert.notEqual(JSON.parse(fs.readFileSync(path.join(conflicts, id, 'meta.json'), 'utf8')).ref, 'settings.json');
  });

  test('共用設定不是記憶：不出現在記憶清單與搜尋', async () => {
    const list = await A.memories.list({});
    assert.ok(!list.some((x) => /settings\.json$/.test(x.ref)));
  });
});
