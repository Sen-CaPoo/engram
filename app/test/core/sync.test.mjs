// 兩台電腦透過 bare repo（代替 GitHub）同步：新增、合併、衝突隔離、大量刪除防護、密鑰關卡、離線。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { age, ageTree, git, machinePaths, makeBareRemote, memoryText, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

let root; let cli; let remote;
let A; let B; // engine
let mA; let mB;

const vaultFile = (eg, ref) => path.join(eg.paths.vault, ...ref.split('/'));
const write = (eg, ref, text) => { fs.mkdirSync(path.dirname(vaultFile(eg, ref)), { recursive: true }); fs.writeFileSync(vaultFile(eg, ref), text); age(vaultFile(eg, ref)); };
const read = (eg, ref) => fs.readFileSync(vaultFile(eg, ref), 'utf8');
async function syncBoth() {
  ageTree(A.paths.vault); ageTree(B.paths.vault);
  const a = await A.sync(); ageTree(B.paths.vault);
  const b = await B.sync(); ageTree(A.paths.vault);
  const a2 = await A.sync();
  return { a, b, a2 };
}

before(async () => {
  root = mkTmp();
  cli = writeDriverCli(root);
  remote = makeBareRemote(path.join(root, 'remote.git'));
  mA = machinePaths(root, 'office');
  mB = machinePaths(root, 'home');
  await init({ ...mA, machineLabel: '公司電腦', remote, cli });
  A = await open(mA);
  const r = await A.sync();
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.pushed, true);
  await init({ ...mB, machineLabel: '家裡電腦', remote, cli });
  B = await open(mB);
  const rb = await B.sync();
  assert.equal(rb.ok, true, JSON.stringify(rb.error));
  await A.sync();
});
after(() => rmTmp(root));

describe('兩台電腦同步', () => {
  test('第二台 clone 後兩台都登記在 vault，裝置清單正確', async () => {
    const sa = await A.status();
    assert.equal(sa.devices.length, 2);
    assert.deepEqual(sa.devices.map((d) => d.label).sort(), ['公司電腦', '家裡電腦']);
    assert.equal(sa.sync.state, 'ok');
    assert.notEqual(A.machine.id, B.machine.id);
  });

  test('公司電腦新增的全域記憶出現在家裡電腦，INDEX.md 一致', async () => {
    await A.memories.create({ scope: { kind: 'global' }, name: 'answer-in-zh-tw', type: 'feedback', description: '一律用正體中文回答', body: '回答使用正體中文。' });
    await syncBoth();
    assert.match(read(B, 'global/answer-in-zh-tw.md'), /正體中文/);
    assert.equal(read(A, 'global/INDEX.md'), read(B, 'global/INDEX.md'));
  });

  test('單機記憶各自只出現在自己的單機索引', async () => {
    await A.memories.create({ scope: { kind: 'machine' }, name: 'office-proxy', type: 'reference', description: '公司代理設定', body: 'proxy.corp:8080' });
    await syncBoth();
    const idxB = path.join(B.paths.vault, 'machines', B.machine.id, 'INDEX.md');
    assert.ok(fs.existsSync(vaultFile(B, `machines/${A.machine.id}/office-proxy.md`)), '檔案會同步（單一寫入者）');
    assert.doesNotMatch(fs.existsSync(idxB) ? fs.readFileSync(idxB, 'utf8') : '', /office-proxy/, '但不在家裡電腦的單機索引');
  });

  test('兩邊改同一筆的不同段落 → 自動合併', async () => {
    const ref = 'global/two-paragraphs.md';
    write(A, ref, memoryText({ name: 'two-paragraphs', description: '兩段', body: '第一段：原文。\n\n中間不動。\n\n第二段：原文。' }));
    await syncBoth();
    write(A, ref, read(A, ref).replace('第一段：原文。', '第一段：公司改過。').replace('modified: 2026-10-01T00:00:00.000Z', 'modified: 2026-10-10T00:00:00.000Z'));
    write(B, ref, read(B, ref).replace('第二段：原文。', '第二段：家裡改過。').replace('modified: 2026-10-01T00:00:00.000Z', 'modified: 2026-10-11T00:00:00.000Z'));
    await syncBoth();
    for (const eg of [A, B]) {
      const t = read(eg, ref);
      assert.match(t, /第一段：公司改過。/);
      assert.match(t, /第二段：家裡改過。/);
      assert.match(t, /modified: 2026-10-11T00:00:00\.000Z/, 'modified 取較新的一方');
      assert.doesNotMatch(t, /<<<<<<<|>>>>>>>/);
    }
  });

  test('兩邊改同一行 → 保留本機版本、對方版本進 vault/conflicts，兩台都看得到', async () => {
    const ref = 'global/same-line.md';
    write(A, ref, memoryText({ name: 'same-line', description: '同一行', body: '結論：未定。' }));
    await syncBoth();
    write(A, ref, read(A, ref).replace('結論：未定。', '結論：採用方案甲。'));
    write(B, ref, read(B, ref).replace('結論：未定。', '結論：採用方案乙。'));
    const { b } = await syncBoth();
    assert.ok(b.conflicts.length >= 1, '家裡電腦合併時應產生衝突紀錄');
    for (const eg of [A, B]) assert.doesNotMatch(read(eg, ref), /<<<<<<<|=======\n|>>>>>>>/);
    const list = await A.conflicts.list();
    const c = list.find((x) => x.ref === ref);
    assert.ok(c, '衝突紀錄應同步到公司電腦');
    assert.ok(c.ours && c.theirs);
    assert.match(c.summary, /在兩台電腦都被修改/);
    assert.match(c.en.summary, /^"same-line" was modified on both computers \(body\)\. /, '衝突摘要附英文版（合併器產生）');
    const findings = await A.health();
    const h15 = findings.find((f) => f.code === 'H15');
    assert.ok(h15);
    assert.equal(h15.en.title, `Conflict needs attention: ${ref}`);
    assert.ok(h15.en.detail && !/\p{Script=Han}/u.test(h15.en.detail), '衝突的英文說明用 meta.en.summary，沒有中文');
    assert.equal(h15.fix.en.label, 'Resolve conflict');
    // 處理：改用對方版本
    await A.conflicts.resolve(c.id, { choice: c.theirs.includes('方案甲') ? 'theirs' : 'ours' });
    await syncBoth();
    assert.equal((await B.conflicts.list()).filter((x) => x.ref === ref).length, 0);
    assert.match(read(B, ref), /方案甲/);
  });

  test('一邊修改、一邊刪除 → 保留修改後的版本，衝突摘要附英文版（同步引擎產生）', async () => {
    const ref = 'global/modify-delete.md';
    write(A, ref, memoryText({ name: 'modify-delete', description: '修改與刪除', body: '原文。' }));
    await syncBoth();
    write(A, ref, read(A, ref).replace('原文。', '公司改過。'));
    fs.rmSync(vaultFile(B, ref));
    await syncBoth();
    const c = (await A.conflicts.list()).find((x) => x.ref === ref);
    assert.ok(c, '衝突紀錄應同步到公司電腦');
    assert.equal(c.kind, 'modify-delete');
    assert.match(c.summary, /刪除了這筆記憶/);
    assert.equal(c.en.summary, 'This computer deleted this memory, but the other computer modified it, so the modified version was kept');
    for (const eg of [A, B]) assert.match(read(eg, ref), /公司改過。/);
  });

  test('只有 modified／originSessionId 不同 → 乾淨合併', async () => {
    const ref = 'global/meta-only.md';
    write(A, ref, memoryText({ name: 'meta-only', description: '只改中繼資料', body: '不變。', originSessionId: 'aaaaaaaa-0000-0000-0000-000000000001' }));
    await syncBoth();
    write(A, ref, read(A, ref).replace('2026-10-01T00:00:00.000Z', '2026-10-05T00:00:00.000Z').replace('000000000001', '000000000002'));
    write(B, ref, read(B, ref).replace('2026-10-01T00:00:00.000Z', '2026-10-06T00:00:00.000Z').replace('000000000001', '000000000003'));
    const before = (await A.conflicts.list()).length;
    await syncBoth();
    assert.equal((await A.conflicts.list()).length, before, '不應產生新的衝突');
    assert.match(read(A, ref), /2026-10-06T00:00:00\.000Z/);
    assert.match(read(A, ref), /000000000003/, 'originSessionId 跟著較新的 modified');
  });

  test('兩邊各自在 MEMORY.md 加一行 → 聯集、不重複', async () => {
    const pidA = (await A.memories.create({ scope: { kind: 'global' }, name: 'placeholder', type: 'reference', description: 'x', body: 'x' })) && null;
    void pidA;
    // 建一個專案（不綁定資料夾），兩邊各新增一筆記憶與索引行
    const { createProject } = await import('../../src/core/identity.mjs');
    const p = await A._ctx.locked('t', () => createProject(A._ctx, { name: 'shared', root: null }));
    ageTree(A.paths.vault);
    await A.sync(); await B.sync();
    const dirA = path.join(A.paths.vault, 'projects', p.id, 'memory');
    const dirB = path.join(B.paths.vault, 'projects', p.id, 'memory');
    fs.mkdirSync(dirB, { recursive: true }); // 空資料夾不會被 git 同步；實際使用時由 junction 建立
    fs.writeFileSync(path.join(dirA, 'from-office.md'), memoryText({ name: 'from-office', description: '公司' }));
    fs.writeFileSync(path.join(dirA, 'MEMORY.md'), '- [公司](from-office.md) — 公司寫的\n');
    fs.writeFileSync(path.join(dirB, 'from-home.md'), memoryText({ name: 'from-home', description: '家裡' }));
    fs.writeFileSync(path.join(dirB, 'MEMORY.md'), '- [家裡](from-home.md) — 家裡寫的\n');
    await syncBoth();
    await B.sync();
    for (const d of [dirA, dirB]) {
      const idx = fs.readFileSync(path.join(d, 'MEMORY.md'), 'utf8');
      assert.match(idx, /公司寫的/);
      assert.match(idx, /家裡寫的/);
      assert.equal(idx.split('\n').filter((l) => l.includes('from-office.md')).length, 1);
    }
  });

  test('大量刪除被扣住不同步，可一鍵還原（H18）', async () => {
    const { createProject } = await import('../../src/core/identity.mjs');
    const p = await A._ctx.locked('t', () => createProject(A._ctx, { name: 'mass', root: null }));
    const dir = path.join(A.paths.vault, 'projects', p.id, 'memory');
    for (const n of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(dir, `${n}.md`), memoryText({ name: n, description: n }));
    ageTree(A.paths.vault);
    await A.sync();
    for (const n of ['a', 'b', 'c']) fs.rmSync(path.join(dir, `${n}.md`));
    const r = await A.sync();
    assert.equal(r.held.length, 1);
    assert.equal(r.held[0].refs.length, 3);
    assert.match(git(remote, 'ls-tree', '-r', '--name-only', 'main'), new RegExp(`projects/${p.id}/memory/a\\.md`), '遠端仍保留');
    const findings = await A.health();
    const h18 = findings.find((f) => f.code === 'H18');
    assert.ok(h18);
    assert.equal(h18.en.title, 'Mass deletion detected: mass');
    assert.equal(h18.en.detail, '3 memories were deleted in the same round. Syncing those deletions is on hold.');
    assert.equal(h18.fix.en.label, 'Restore');
    await A.apply(h18.fix);
    assert.ok(fs.existsSync(path.join(dir, 'a.md')));
  });

  test('疑似含金鑰的檔案不會推到遠端', async () => {
    const fake = ['sk', '-ant-', 'api03-', 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe9Dc8Ba7'].join('');
    write(A, 'global/has-secret.md', memoryText({ name: 'has-secret', description: '不該同步', body: `key=${fake}` }));
    const r = await A.sync();
    assert.ok(r.skipped.secrets.some((s) => s.ref === 'global/has-secret.md'));
    assert.doesNotMatch(git(remote, 'ls-tree', '-r', '--name-only', 'main'), /has-secret\.md/);
    fs.rmSync(vaultFile(A, 'global/has-secret.md'));
  });

  test('沒有新變更時兩台輪流同步不產生任何 commit（原本每次落後都用 --no-ff 合併，兩台會無限互相產生空的合併 commit）', async () => {
    await syncBoth();
    const count = () => Number(git(remote, 'rev-list', '--count', 'main').trim());
    const before = count();
    for (let i = 0; i < 3; i++) await syncBoth();
    assert.equal(count(), before);
    // 兩邊各有新的 commit（真的分歧）時才產生合併 commit
    await A.memories.create({ scope: { kind: 'global' }, name: 'diverge-a', type: 'reference', description: 'A 寫的', body: 'A' });
    await B.memories.create({ scope: { kind: 'global' }, name: 'diverge-b', type: 'reference', description: 'B 寫的', body: 'B' });
    await syncBoth();
    assert.match(read(A, 'global/diverge-b.md'), /B/);
    assert.match(read(B, 'global/diverge-a.md'), /A/);
    const settled = count();
    for (let i = 0; i < 2; i++) await syncBoth();
    assert.equal(count(), settled, '合併之後也要收斂');
  });

  test('審查：被扣住的檔案只在 A，兩台的索引一致、多輪同步後不再產生新 commit（不會互相改寫索引）', async () => {
    const fake = ['sk', '-ant-', 'api03-', 'Qa1Ws2Ed3Rf4Tg5Yh6Uj7Ik8Ol9Pz0Xc1Vb2Nm3'].join('');
    // 沒進過 git 的被扣住檔案（Claude Code 直接寫入），以及進過 git、之後被改成含金鑰的檔案
    write(A, 'global/held-new.md', memoryText({ name: 'held-new', description: '只在公司電腦', body: `key=${fake}` }));
    await A.memories.create({ scope: { kind: 'global' }, name: 'held-old', type: 'reference', description: '原本的說明', body: '沒有金鑰' });
    await syncBoth();
    write(A, 'global/held-old.md', memoryText({ name: 'held-old', description: '改過的說明', type: 'reference', body: `加上 key=${fake}` }));
    for (let i = 0; i < 2; i++) await syncBoth();
    const count = () => Number(git(remote, 'rev-list', '--count', 'main').trim());
    const before = count();
    for (let i = 0; i < 3; i++) await syncBoth();
    assert.equal(count(), before, '已經收斂，之後的同步不該再有 commit');
    assert.equal(read(A, 'global/INDEX.md'), read(B, 'global/INDEX.md'));
    assert.doesNotMatch(read(A, 'global/INDEX.md'), /held-new/, '沒進過 git 的被扣住檔案不列入索引');
    assert.match(read(A, 'global/INDEX.md'), /held-old.*原本的說明/, '進過 git 的用 HEAD 版本');
    assert.ok(!git(remote, 'log', '--all', '-p').includes(fake));
    fs.rmSync(vaultFile(A, 'global/held-new.md'));
    await A.secrets.redact('global/held-old.md');
    await syncBoth();
  });

  test('審查 N2：在 A 確認「不是金鑰」的值，同步到 B 之後 B 也認得：不出現 H13、可以編輯並同步回 A', async () => {
    const sample = ['gh', 'p_', 'Ab3Cd5Ef7Gh9Ij1Kl3Mn5Op7Qr9St1Uv3Wx5Yz7Za'].join('');
    await A.secrets.allowValue(sample);
    const mem = await A.memories.create({ scope: { kind: 'global' }, name: 'sample-in-docs', type: 'reference', description: '文件裡的範例權杖', body: `範例：${sample}` });
    await syncBoth();
    assert.match(read(B, mem.ref), new RegExp(sample));
    assert.ok(!(await B.health()).some((f) => f.code === 'H13' && f.refs.includes(mem.ref)), 'B 不該把它當成金鑰');
    await B.memories.write(mem.ref, { body: `範例：${sample}\n（B 補充）\n` });
    await B.memories.move(mem.ref, { kind: 'machine' });
    await syncBoth();
    assert.ok(!fs.existsSync(vaultFile(A, mem.ref)));
    const tree = git(remote, 'ls-tree', '-r', '--name-only', 'main');
    assert.ok(tree.includes(`machines/${B.machine.id}/sample-in-docs.md`) && !tree.includes(mem.ref), '搬移完整同步，不是只提交了刪除');
  });

  test('遠端無法連線時回報錯誤狀態而不丟例外', async () => {
    const moved = `${remote}-gone`;
    fs.renameSync(remote, moved);
    try {
      write(A, 'global/offline-note.md', memoryText({ name: 'offline-note', description: '離線時寫的' }));
      const r = await A.sync();
      assert.equal(r.ok, false);
      assert.ok(['offline', 'error'].includes(r.state));
      assert.equal(r.committed, 1, '本機 commit 仍完成');
      const st = await A.status();
      assert.ok(st.sync.error);
    } finally {
      fs.renameSync(moved, remote);
    }
    const r2 = await A.sync();
    assert.equal(r2.ok, true);
  });
});
