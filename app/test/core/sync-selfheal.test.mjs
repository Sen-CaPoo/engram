// S2：同步自我修復。同一種非離線錯誤連續 3 次 → 診斷是哪些檔案擋住、為什麼沒被提交；
// 擋住合併的是被扣住（疑似金鑰）的檔案時，備份、暫時移開、合併、放回原位，本機版本一字不差。
// 這個檔案自己一組 A／B 兩台電腦，不與 sync.test.mjs 共用。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { healBlockedMerge, parseOverwriteBlockers, recoverHeal } from '../../src/core/heal.mjs';
import { age, ageTree, git, machinePaths, makeBareRemote, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

let root; let remote; let A; let B;
const fakeKey = (n) => ['sk', '-ant-', 'api03-', `Pq${n}Rs8Tu9Vw1Xy2Za3Bc4De5Fg6Hi7Jk8Lm9No0Pq`].join('');
const vaultFile = (eg, ref) => path.join(eg.paths.vault, ...ref.split('/'));
const state = () => JSON.parse(fs.readFileSync(path.join(A.paths.local, 'state.json'), 'utf8'));
const settle = (eg) => { ageTree(eg.paths.vault); return eg.sync(); };

/** 有 BOM、CRLF 的本機版本（含假金鑰，會被疑似金鑰關卡扣住）：用來證明搬移與放回是逐位元組不變 */
function heldBytes(name, n) {
  return Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(`---\r\nname: ${name}\r\ndescription: "本機版本"\r\nmetadata:\r\n  type: reference\r\n---\r\n\r\n本機內容 key=${fakeKey(n)}\r\n`, 'utf8'),
  ]);
}
const writeHeld = (ref, bytes) => { fs.mkdirSync(path.dirname(vaultFile(A, ref)), { recursive: true }); fs.writeFileSync(vaultFile(A, ref), bytes); age(vaultFile(A, ref)); };
const backups = (ref) => {
  const base = path.join(A.paths.local, 'backup');
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return [];
  return fs.readdirSync(base).map((d) => path.join(base, d, ...ref.split('/'))).filter((p) => fs.existsSync(p));
};

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

describe('parseOverwriteBlockers', () => {
  test('從 git 的訊息取出擋住合併的檔案（有未提交修改、與未追蹤檔案兩種）', () => {
    const modified = 'error: Your local changes to the following files would be overwritten by merge:\n\tglobal/a.md\n\tprojects/p1/memory/中文.md\nPlease commit your changes or stash them before you merge.\nAborting\n';
    assert.deepEqual(parseOverwriteBlockers(modified), ['global/a.md', 'projects/p1/memory/中文.md']);
    const untracked = 'error: The following untracked working tree files would be overwritten by merge:\n\tglobal/b.md\nPlease move or remove them before you merge.\nAborting\n';
    assert.deepEqual(parseOverwriteBlockers(untracked), ['global/b.md']);
    assert.deepEqual(parseOverwriteBlockers('fatal: something else'), []);
  });
});

describe('擋住合併的是被扣住的檔案：連續 3 次後備份、暫移、合併、放回', () => {
  test('未追蹤的本機檔案（含假金鑰）擋住對方新增的同名檔：前兩次回報衝突，第 3 次自動修復，本機版本一字不差', async () => {
    const ref = 'global/shared-note.md';
    const mine = heldBytes('shared-note', 1);
    writeHeld(ref, mine);
    const first = await settle(A);
    assert.equal(first.ok, true);
    assert.ok(first.skipped.secrets.some((s) => s.ref === ref), '前置：本機版本被扣住');
    await B.memories.create({ scope: { kind: 'global' }, name: 'shared-note', type: 'reference', description: '對方的版本', body: '對方內容。' });
    assert.equal((await settle(B)).ok, true);

    for (const n of [1, 2]) {
      const r = await settle(A);
      assert.equal(r.ok, false, `第 ${n} 次`);
      assert.equal(r.error.code, 'E_CONFLICT');
      assert.equal(r.diagnosis, undefined, '還沒到 3 次，不診斷');
      assert.equal(state().syncIssue.count, n);
      assert.ok(fs.readFileSync(vaultFile(A, ref)).equals(mine), '失敗時本機版本不動');
    }
    const third = await settle(A);
    assert.equal(third.ok, true, JSON.stringify(third.error));
    assert.deepEqual(third.diagnosis.blockers, [{ ref, reason: 'secret', kinds: third.diagnosis.blockers[0].kinds }]);
    assert.equal(third.diagnosis.healed.length, 1);
    assert.equal(third.diagnosis.healed[0].ref, ref);

    assert.ok(fs.readFileSync(vaultFile(A, ref)).equals(mine), '放回原位後一字不差（含 BOM、CRLF）');
    assert.match(git(A.paths.vault, 'show', `HEAD:${ref}`), /對方內容/, '合併成功：記憶庫裡是對方的版本');
    const kept = backups(ref);
    assert.equal(kept.length, 1, '備份在 local/backup 底下，保留相對路徑');
    assert.ok(fs.readFileSync(kept[0]).equals(mine), '備份也一字不差');
    assert.equal(fs.existsSync(path.join(A.paths.local, 'heal-pending.json')), false, '標記檔已清掉');
    assert.equal(state().syncIssue, null, '成功後問題記錄清空');
    assert.equal(state().syncHeal.files[0].ref, ref);
    assert.ok(state().sync.blockedBySecrets?.includes(ref), '放回的本機版本仍被扣住');
    const again = await settle(A);
    assert.equal(again.ok, true);
    assert.ok(fs.readFileSync(vaultFile(A, ref)).equals(mine));
    assert.ok(!git(remote, 'log', '--all', '-p').includes(fakeKey(1)), '金鑰沒有進遠端');
  });

  test('有未提交修改的追蹤檔案（含假金鑰）擋住對方對同一檔的修改：一樣修復，記憶庫是對方的版本、本機版本放回', async () => {
    const ref = 'global/tracked-note.md';
    await A.memories.create({ scope: { kind: 'global' }, name: 'tracked-note', type: 'reference', description: '原本的說明', body: '原本的內容。' });
    assert.equal((await settle(A)).ok, true);
    assert.equal((await settle(B)).ok, true);
    const mine = heldBytes('tracked-note', 2);
    writeHeld(ref, mine);
    await B.memories.write(ref, { body: '對方改過的內容。\n' });
    assert.equal((await settle(B)).ok, true);
    assert.equal((await settle(A)).ok, false);
    assert.equal((await settle(A)).ok, false);
    const third = await settle(A);
    assert.equal(third.ok, true, JSON.stringify(third.error));
    assert.equal(third.diagnosis.healed[0].ref, ref);
    assert.ok(fs.readFileSync(vaultFile(A, ref)).equals(mine));
    assert.match(git(A.paths.vault, 'show', `HEAD:${ref}`), /對方改過的內容/);
    assert.ok(backups(ref).some((p) => fs.readFileSync(p).equals(mine)));
  });

  test('擋住的不是被扣住的檔案（剛被修改、還沒過 10 秒）：只診斷、不搬移，錯誤照舊', async () => {
    const ref = 'global/recent-note.md';
    const mine = Buffer.from('---\nname: recent-note\ndescription: "剛寫的"\nmetadata:\n  type: reference\n---\n\n剛寫的內容。\n', 'utf8');
    const touchNow = () => { fs.mkdirSync(path.dirname(vaultFile(A, ref)), { recursive: true }); fs.writeFileSync(vaultFile(A, ref), mine); };
    touchNow();
    await B.memories.create({ scope: { kind: 'global' }, name: 'recent-note', type: 'reference', description: '對方的', body: '對方。' });
    assert.equal((await settle(B)).ok, true);
    let last;
    for (let i = 0; i < 3; i++) {
      touchNow(); // 每一輪都是剛修改的
      last = await A.sync();
    }
    assert.equal(last.ok, false);
    assert.equal(last.error.code, 'E_CONFLICT');
    assert.deepEqual(last.diagnosis.blockers, [{ ref, reason: 'recent' }]);
    assert.deepEqual(last.diagnosis.healed, []);
    assert.ok(fs.readFileSync(vaultFile(A, ref)).equals(mine), '沒有被動過');
    assert.equal(state().syncIssue.diagnosis.blockers[0].reason, 'recent', '診斷寫進 state.json');
    // 清理：讓這個檔案過了「剛修改」的時間，下一輪就能正常收尾
    age(vaultFile(A, ref));
    fs.rmSync(vaultFile(A, ref));
    await settle(A);
    await settle(A);
  });

  test('任何一步失敗就維持原狀：備份建不起來時，檔案原封不動、不留標記，之後恢復正常再修復', async () => {
    const ref = 'global/backup-fail.md';
    const mine = heldBytes('backup-fail', 3);
    writeHeld(ref, mine);
    assert.equal((await settle(A)).ok, true);
    await B.memories.create({ scope: { kind: 'global' }, name: 'backup-fail', type: 'reference', description: '對方的', body: '對方。' });
    assert.equal((await settle(B)).ok, true);
    const blocker = path.join(A.paths.local, 'backup');
    fs.rmSync(blocker, { recursive: true, force: true });
    fs.writeFileSync(blocker, '我是檔案，不是資料夾'); // 讓建立備份資料夾失敗
    try {
      await settle(A); await settle(A);
      const third = await settle(A);
      assert.equal(third.ok, false);
      assert.equal(third.error.code, 'E_CONFLICT');
      assert.ok(third.diagnosis.healFailed, '診斷寫明修復失敗的原因');
      assert.deepEqual(third.diagnosis.healed, []);
      assert.ok(fs.readFileSync(vaultFile(A, ref)).equals(mine), '原檔原封不動');
      assert.equal(fs.existsSync(path.join(A.paths.local, 'heal-pending.json')), false);
    } finally {
      fs.rmSync(blocker, { force: true });
    }
    const healed = await settle(A);
    assert.equal(healed.ok, true, JSON.stringify(healed.error));
    assert.ok(fs.readFileSync(vaultFile(A, ref)).equals(mine));
  });
});

describe('healBlockedMerge／recoverHeal', () => {
  const plan = (ref) => ({ secrets: [{ ref, kinds: ['anthropic'] }], recent: [], held: [], unmerged: [] });

  test('暫移之後合併失敗：檔案放回原位、一字不差，不留標記與暫存，備份保留', async () => {
    const ref = 'global/unit-restore.md';
    const mine = heldBytes('unit-restore', 4);
    writeHeld(ref, mine);
    let sawMissing = false;
    const r = await healBlockedMerge(A._ctx, {
      blockers: [ref], plan: plan(ref),
      merge: async () => { sawMissing = !fs.existsSync(vaultFile(A, ref)); throw new Error('合併出錯'); },
    });
    assert.equal(sawMissing, true, '合併進行時，原位是空的（已暫時移開）');
    assert.equal(r.merged, false);
    assert.match(r.diagnosis.healFailed, /合併出錯/);
    assert.ok(fs.readFileSync(vaultFile(A, ref)).equals(mine));
    assert.equal(fs.existsSync(path.join(A.paths.local, 'heal-pending.json')), false);
    assert.equal(backups(ref).length, 1);
    assert.equal(fs.readdirSync(path.join(A.paths.local, 'tmp')).filter((n) => n.startsWith('heal-')).length, 0, '暫存資料夾已清掉');
    fs.rmSync(vaultFile(A, ref));
  });

  test('blockers 裡有不是被扣住的檔案 → 不搬移', async () => {
    const ref = 'global/unit-not-held.md';
    const mine = Buffer.from('普通內容\n', 'utf8');
    fs.writeFileSync(vaultFile(A, ref), mine);
    let merged = false;
    const r = await healBlockedMerge(A._ctx, { blockers: [ref], plan: { secrets: [], recent: [], held: [], unmerged: [] }, merge: async () => { merged = true; } });
    assert.equal(merged, false);
    assert.equal(r.merged, false);
    assert.deepEqual(r.diagnosis.blockers, [{ ref, reason: 'uncommitted' }]);
    assert.ok(fs.readFileSync(vaultFile(A, ref)).equals(mine));
    fs.rmSync(vaultFile(A, ref));
  });

  test('程序在暫移途中被終止（留下標記）：下一次同步一開始就把檔案放回原位', async () => {
    const ref = 'global/unit-interrupted.md';
    const mine = heldBytes('unit-interrupted', 5);
    const aside = path.join(A.paths.local, 'tmp', 'heal-19990101T000000000Z', 'global', 'unit-interrupted.md');
    const backup = path.join(A.paths.local, 'backup', '19990101T000000000Z', 'global', 'unit-interrupted.md');
    for (const p of [aside, backup]) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, mine); }
    fs.writeFileSync(path.join(A.paths.local, 'heal-pending.json'), JSON.stringify({ v: 1, at: new Date().toISOString(), files: [{ ref, original: vaultFile(A, ref), aside, backup }] }));
    assert.equal(fs.existsSync(vaultFile(A, ref)), false);
    const r = await settle(A);
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.ok(fs.readFileSync(vaultFile(A, ref)).equals(mine), '放回原位');
    assert.equal(fs.existsSync(path.join(A.paths.local, 'heal-pending.json')), false);
    assert.equal(fs.existsSync(aside), false);
    assert.ok(fs.readFileSync(backup).equals(mine), '備份還在');
    fs.rmSync(vaultFile(A, ref));
    await settle(A);
  });

  test('標記還在、暫存的本機版本卻不見了（暫存資料夾被清掉），原位也是空的：用備份補回，不當成已經放回去', async () => {
    const ref = 'global/unit-aside-gone.md';
    const mine = heldBytes('unit-aside-gone', 7);
    const aside = path.join(A.paths.local, 'tmp', 'heal-19990102T000000000Z', 'global', 'unit-aside-gone.md'); // 不存在
    const backup = path.join(A.paths.local, 'backup', '19990102T000000000Z', 'global', 'unit-aside-gone.md');
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, mine);
    const t = new Date(Date.now() - 3 * 3600_000);
    fs.utimesSync(backup, t, t);
    fs.writeFileSync(path.join(A.paths.local, 'heal-pending.json'), JSON.stringify({ v: 1, at: new Date().toISOString(), files: [{ ref, original: vaultFile(A, ref), aside, backup }] }));
    assert.deepEqual(await recoverHeal(A._ctx), { recovered: true, files: [ref], preserved: [] });
    assert.ok(fs.readFileSync(vaultFile(A, ref)).equals(mine), '從備份補回，一字不差');
    assert.equal(Math.round(fs.statSync(vaultFile(A, ref)).mtimeMs / 1000), Math.round(t.getTime() / 1000), '修改時間也補回');
    assert.equal(fs.existsSync(path.join(A.paths.local, 'heal-pending.json')), false);
    fs.rmSync(vaultFile(A, ref));
  });

  test('recoverHeal：沒有標記時什麼都不做', async () => {
    assert.deepEqual(await recoverHeal(A._ctx), { recovered: false });
  });
});

describe('其他非離線錯誤也會連續計數、診斷，成功後清空', () => {
  test('遠端位置壞掉（不是離線）連續 3 次：診斷列出被扣住的檔案；恢復後第一次成功就清掉', async () => {
    const ref = 'global/diag-note.md';
    writeHeld(ref, heldBytes('diag-note', 6));
    assert.equal((await settle(A)).ok, true);
    const good = git(A.paths.vault, 'remote', 'get-url', 'origin').trim();
    git(A.paths.vault, 'remote', 'set-url', 'origin', path.join(root, 'no-such-remote.git'));
    try {
      const codes = new Set();
      let last;
      for (let i = 1; i <= 3; i++) {
        last = await settle(A);
        assert.equal(last.ok, false);
        codes.add(last.error.code);
        assert.equal(state().syncIssue.count, i);
        assert.equal(state().syncIssue.offline, false);
      }
      assert.equal(codes.size, 1, '同一種錯誤');
      assert.ok(Date.parse(state().syncIssue.since) <= Date.parse(state().syncIssue.at));
      assert.ok(last.diagnosis.uncommitted.some((u) => u.ref === ref && u.reason === 'secret'), '沒被提交的原因：疑似金鑰被扣住');
      assert.deepEqual(state().syncIssue.diagnosis.uncommitted.map((u) => u.ref), last.diagnosis.uncommitted.map((u) => u.ref));
    } finally {
      git(A.paths.vault, 'remote', 'set-url', 'origin', good);
    }
    assert.equal((await settle(A)).ok, true);
    assert.equal(state().syncIssue, null);
    fs.rmSync(vaultFile(A, ref));
    await settle(A);
  });

  test('只做本機存檔（network:false）成功，不會清掉網路同步的失敗記錄', async () => {
    const good = git(A.paths.vault, 'remote', 'get-url', 'origin').trim();
    git(A.paths.vault, 'remote', 'set-url', 'origin', path.join(root, 'no-such-remote.git'));
    try {
      assert.equal((await A.sync()).ok, false);
      const before = state().syncIssue;
      assert.equal((await A.sync({ network: false })).ok, true);
      assert.deepEqual(state().syncIssue, before);
    } finally {
      git(A.paths.vault, 'remote', 'set-url', 'origin', good);
    }
    assert.equal((await A.sync()).ok, true);
  });
});

describe('開場訊息：非離線的同步失敗超過 1 小時要告訴使用者', () => {
  const ctxText = async () => (await A.sessionContext({ cwd: path.join(root, 'elsewhere') })).text;
  const setIssue = async (patch) => {
    const file = path.join(A.paths.local, 'state.json');
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...cur, syncIssue: patch }));
  };
  before(() => fs.mkdirSync(path.join(root, 'elsewhere'), { recursive: true }));

  test('非離線、超過 1 小時：多一行，寫明原因與持續時間，並要求 Claude 主動告訴使用者', async () => {
    const since = new Date(Date.now() - (5 * 60 + 30) * 60_000).toISOString();
    await setIssue({ key: 'k', code: 'E_CONFLICT', message: '本機有尚未提交的變更，這一輪暫不合併', count: 34, since, at: new Date().toISOString(), offline: false, diagnosis: { blockers: [{ ref: 'global/shared-note.md', reason: 'secret' }], healed: [] } });
    const text = await ctxText();
    assert.match(text, /同步已連續失敗 5 小時 30 分/);
    assert.match(text, /E_CONFLICT/);
    assert.match(text, /本機有尚未提交的變更/);
    assert.match(text, /告訴使用者/);
    assert.match(text, /例外/, '註明這是「使用者沒問就不要提」的例外');
    assert.ok(text.split('\n').length <= 12 && text.length <= 1200);
  });

  test('離線、或不到 1 小時：不加這一行', async () => {
    const at = new Date().toISOString();
    await setIssue({ key: 'k', code: 'E_OFFLINE', message: '連不到', count: 50, since: new Date(Date.now() - 9 * 3600_000).toISOString(), at, offline: true });
    assert.doesNotMatch(await ctxText(), /連續失敗/);
    await setIssue({ key: 'k', code: 'E_GIT', message: 'x', count: 4, since: new Date(Date.now() - 30 * 60_000).toISOString(), at, offline: false });
    assert.doesNotMatch(await ctxText(), /連續失敗/);
    await setIssue(null);
    assert.doesNotMatch(await ctxText(), /連續失敗/);
  });
});
