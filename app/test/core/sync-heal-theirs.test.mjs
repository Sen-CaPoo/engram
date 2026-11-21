// S2 追加：自我修復放回被扣住的本機檔案之前，如果這次合併讓同一個檔案的內容和合併前不同（對方改過），
// 對方的版本要存進既有的衝突隔離區（vault/conflicts/cf_*），之後清掉疑似金鑰再提交時，對方的修改才不會無聲無息被蓋掉。
// 這個檔案自己一組 A／B 兩台電腦。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { git as engineGit } from '../../src/core/git.mjs';
import { healBlockedMerge } from '../../src/core/heal.mjs';
import { age, ageTree, git, machinePaths, makeBareRemote, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

let root; let remote; let A; let B;
const fakeKey = (n) => ['sk', '-ant-', 'api03-', `Qd${n}Rs8Tu9Vw1Xy2Za3Bc4De5Fg6Hi7Jk8Lm9No0Pq`].join('');
const vaultFile = (eg, ref) => path.join(eg.paths.vault, ...ref.split('/'));
const state = () => JSON.parse(fs.readFileSync(path.join(A.paths.local, 'state.json'), 'utf8'));
const settle = (eg) => { ageTree(eg.paths.vault); return eg.sync(); };
const heldBytes = (name, n) => Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from(`---\r\nname: ${name}\r\ndescription: "本機版本"\r\nmetadata:\r\n  type: reference\r\n---\r\n\r\n本機內容 key=${fakeKey(n)}\r\n`, 'utf8'),
]);
const writeHeld = (ref, bytes) => { fs.mkdirSync(path.dirname(vaultFile(A, ref)), { recursive: true }); fs.writeFileSync(vaultFile(A, ref), bytes); age(vaultFile(A, ref)); };
/** 兩台各改同一個被扣住的檔案之後，連續 3 次同步：前兩次被擋住，第 3 次修復 */
async function failTwiceThenHeal() {
  for (let i = 0; i < 2; i++) assert.equal((await settle(A)).ok, false);
  const third = await settle(A);
  assert.equal(third.ok, true, JSON.stringify(third.error));
  return third;
}

before(async () => {
  root = mkTmp();
  const cli = writeDriverCli(root);
  remote = makeBareRemote(path.join(root, 'remote.git'));
  const mA = machinePaths(root, 'office');
  const mB = machinePaths(root, 'home');
  await init({ ...mA, machineLabel: '公司電腦', remote, cli });
  A = await open(mA);
  assert.equal((await settle(A)).ok, true);
  await init({ ...mB, machineLabel: '家裡電腦', remote, cli });
  B = await open(mB);
  assert.equal((await settle(B)).ok, true);
  assert.equal((await settle(A)).ok, true);
});
after(() => rmTmp(root));

describe('對方改過被扣住的檔案：對方的版本進衝突隔離區', () => {
  test('本機新增（未追蹤、含假金鑰）的檔案與對方新增的同名檔：對方版本成為衝突紀錄，本機版本放回、金鑰沒有進遠端，使用者能找回對方的版本', async () => {
    const ref = 'global/both-new.md';
    const mine = heldBytes('both-new', 1);
    writeHeld(ref, mine);
    assert.equal((await settle(A)).ok, true);
    await B.memories.create({ scope: { kind: 'global' }, name: 'both-new', type: 'reference', description: '對方的版本', body: '對方寫的內容。' });
    assert.equal((await settle(B)).ok, true);

    const third = await failTwiceThenHeal();
    assert.ok(fs.readFileSync(vaultFile(A, ref)).equals(mine), '本機版本放回，一字不差');
    const healed = third.diagnosis.healed[0];
    assert.equal(healed.ref, ref);
    assert.equal(healed.theirs.kind, 'conflict');
    assert.match(healed.theirs.id, /^cf_/);
    assert.ok(third.conflicts.includes(healed.theirs.id), '同步結果列出這筆衝突');
    assert.deepEqual(state().syncHeal.files[0].theirs, healed.theirs, 'state.json 的 syncHeal 有指向');

    const c = (await A.conflicts.list()).find((x) => x.id === healed.theirs.id);
    assert.equal(c.ref, ref);
    assert.match(c.theirs, /對方寫的內容/, '對方的版本找得回來');
    assert.ok(c.ours && !c.ours.includes(fakeKey(1)) && /已遮蔽/.test(c.ours), '本機版本放進紀錄前已遮蔽金鑰');
    assert.match(c.summary, /對方/);
    assert.ok(c.en?.summary && !/[一-鿿]/.test(c.en.summary));
    assert.equal(c.base, null, '兩邊都是新增，沒有共同祖先');

    // 紀錄會 commit 並同步出去（遮蔽過所以沒被金鑰關卡擋住），另一台電腦也看得到；金鑰不會進遠端
    await settle(A);
    assert.ok(git(remote, 'ls-tree', '-r', '--name-only', 'main').includes(`conflicts/${c.id}/theirs.md`));
    assert.ok(!git(remote, 'log', '--all', '-p').includes(fakeKey(1)));
    await settle(B);
    assert.ok((await B.conflicts.list()).some((x) => x.id === c.id), '另一台的收件匣也有');

    // 既有的流程：使用者選「兩個都留」，對方的版本另存成一筆記憶，本機被扣住的版本不動
    const r = await A.conflicts.resolve(c.id, { choice: 'both' });
    assert.ok(r.ok !== false);
    const saved = fs.readdirSync(path.join(A.paths.vault, 'global')).filter((n) => /^both-new.*\.md$/.test(n) && n !== 'both-new.md');
    assert.equal(saved.length, 1);
    assert.match(fs.readFileSync(path.join(A.paths.vault, 'global', saved[0]), 'utf8'), /對方寫的內容/);
    assert.ok(fs.readFileSync(vaultFile(A, ref)).equals(mine));
    assert.equal((await A.conflicts.list()).some((x) => x.id === c.id), false);
  });

  test('追蹤中的檔案：本機改成含假金鑰、對方改了同一檔 → 紀錄有對方的版本，base 是合併前記憶庫裡的版本', async () => {
    const ref = 'global/both-edit.md';
    await A.memories.create({ scope: { kind: 'global' }, name: 'both-edit', type: 'reference', description: '原本的說明', body: '原本的內容。' });
    assert.equal((await settle(A)).ok, true);
    assert.equal((await settle(B)).ok, true);
    const mine = heldBytes('both-edit', 2);
    writeHeld(ref, mine);
    await B.memories.write(ref, { body: '對方改過的內容。\n' });
    assert.equal((await settle(B)).ok, true);

    const third = await failTwiceThenHeal();
    assert.ok(fs.readFileSync(vaultFile(A, ref)).equals(mine));
    const c = (await A.conflicts.list()).find((x) => x.id === third.diagnosis.healed[0].theirs.id);
    assert.match(c.theirs, /對方改過的內容/);
    assert.match(c.base, /原本的內容/);
    assert.ok(!c.ours.includes(fakeKey(2)));
    // 之後清掉金鑰、改成乾淨內容再提交：覆蓋的是記憶庫的版本，但對方的版本還在衝突紀錄裡，沒有消失
    fs.writeFileSync(vaultFile(A, ref), '---\nname: both-edit\ndescription: "清掉金鑰後"\nmetadata:\n  type: reference\n---\n\n清掉金鑰後的內容。\n');
    assert.equal((await settle(A)).ok, true);
    assert.match(git(A.paths.vault, 'show', `HEAD:${ref}`), /清掉金鑰後的內容/);
    assert.match((await A.conflicts.list()).find((x) => x.id === c.id).theirs, /對方改過的內容/);
  });

  test('本機有自己還沒推送的 commit（--no-ff 合併）：對方的版本是遠端的版本，不是合併後的內容', async () => {
    const ref = 'global/ahead-note.md';
    const mine = heldBytes('ahead-note', 3);
    writeHeld(ref, mine);
    assert.equal((await settle(A)).ok, true);
    await B.memories.create({ scope: { kind: 'global' }, name: 'ahead-note', type: 'reference', description: '對方的', body: '對方在遠端的內容。' });
    assert.equal((await settle(B)).ok, true);
    await A.memories.create({ scope: { kind: 'global' }, name: 'ahead-other', type: 'reference', description: '本機另一筆', body: '本機還沒推送的 commit。' });

    const third = await failTwiceThenHeal();
    assert.equal(third.pulled >= 1, true);
    assert.ok(fs.readFileSync(vaultFile(A, ref)).equals(mine));
    const c = (await A.conflicts.list()).find((x) => x.id === third.diagnosis.healed[0].theirs.id);
    assert.match(c.theirs, /對方在遠端的內容/);
    assert.match(git(A.paths.vault, 'show', 'HEAD:global/ahead-other.md'), /還沒推送/, '本機自己的 commit 還在');
  });

  test('衝突隔離區建不起來時：對方的版本另存到 local/backup/<時間>/theirs/，並在診斷註明（state.json 的 syncHeal、日誌用同一份）', async () => {
    const ref = 'global/seam-note.md';
    const mine = heldBytes('seam-note', 4);
    writeHeld(ref, mine);
    assert.equal((await settle(A)).ok, true);
    await B.memories.create({ scope: { kind: 'global' }, name: 'seam-note', type: 'reference', description: '對方的', body: '對方的內容（要另存）。' });
    assert.equal((await settle(B)).ok, true);
    await engineGit(['fetch', 'origin'], { cwd: A.paths.vault });
    const headBefore = (await engineGit(['rev-parse', 'HEAD'], { cwd: A.paths.vault })).stdout.trim();
    const r = await healBlockedMerge(A._ctx, {
      blockers: [ref],
      plan: { secrets: [{ ref, kinds: ['anthropic'] }], recent: [], held: [], unmerged: [] },
      headBefore,
      theirsRef: 'refs/remotes/origin/main',
      merge: async () => { await engineGit(['merge', '--ff-only', 'refs/remotes/origin/main'], { cwd: A.paths.vault }); },
      quarantineRecord: async () => { throw new Error('衝突隔離區不能用'); },
    });
    assert.equal(r.merged, true);
    const t = r.diagnosis.healed[0].theirs;
    assert.equal(t.kind, 'backup');
    assert.match(t.path, /^backup\/[0-9TZ]+\/theirs\/global\/seam-note\.md$/);
    assert.match(fs.readFileSync(path.join(A.paths.local, ...t.path.split('/')), 'utf8'), /對方的內容（要另存）/);
    assert.ok(fs.readFileSync(vaultFile(A, ref)).equals(mine));
    assert.equal(fs.existsSync(path.join(A.paths.local, 'heal-pending.json')), false);
  });
});
