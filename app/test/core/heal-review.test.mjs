// 第一輪審查的自我修復問題：F1（自我修復的衝突被自動駕駛選 theirs，本機版本被蓋掉）、F9（放回失敗後，下一次同步覆蓋原位被改過的內容）。
// 這個檔案自己一組 A／B 兩台電腦。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { resolveConflicts } from '../../src/autopilot/tasks/conflicts.mjs';
import { quarantine } from '../../src/core/conflicts.mjs';
import { git as engineGit } from '../../src/core/git.mjs';
import { healBlockedMerge, recoverHeal } from '../../src/core/heal.mjs';
import { pruneHealBackups } from '../../src/core/healbackup.mjs';
import { age, ageTree, machinePaths, makeBareRemote, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

let root; let remote; let A; let B;
const fakeKey = (n) => ['sk', '-ant-', 'api03-', `Rv${n}Rs8Tu9Vw1Xy2Za3Bc4De5Fg6Hi7Jk8Lm9No0Pq`].join('');
const vaultFile = (eg, ref) => path.join(eg.paths.vault, ...ref.split('/'));
const settle = (eg) => { ageTree(eg.paths.vault); return eg.sync(); };
const DAY = 24 * 3600_000;
/** 有 BOM、CRLF、含假金鑰（會被扣住）的本機版本 */
const heldBytes = (name, n) => Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from(`---\r\nname: ${name}\r\ndescription: "原本的說明"\r\nmetadata:\r\n  type: reference\r\n---\r\n\r\n原本的內容。\r\n\r\n本機才有的重要筆記：部署步驟第 3 步要先停服務。key=${fakeKey(n)}\r\n`, 'utf8'),
]);
const fresh = () => ({ actions: [], skipped: [], rejected: [], notes: [] });

/** 走完 S2 自我修復：A 的本機版本（含金鑰、被扣住）與 B 的修改衝突，連續 3 次同步後對方的版本在衝突紀錄裡 */
async function healConflict(name, n) {
  const ref = `global/${name}.md`;
  await A.memories.create({ scope: { kind: 'global' }, name, type: 'reference', description: '原本的說明', body: '原本的內容。' });
  assert.equal((await settle(A)).ok, true);
  assert.equal((await settle(B)).ok, true);
  const mine = heldBytes(name, n);
  fs.writeFileSync(vaultFile(A, ref), mine);
  age(vaultFile(A, ref));
  await B.memories.write(ref, { body: '原本的內容。\n\n對方補的一句。\n' });
  assert.equal((await settle(B)).ok, true);
  for (let i = 0; i < 2; i++) assert.equal((await settle(A)).ok, false);
  const third = await settle(A);
  assert.equal(third.ok, true, JSON.stringify(third.error));
  const healed = third.diagnosis.healed[0];
  assert.ok(fs.readFileSync(vaultFile(A, ref)).equals(mine), '修復後本機版本還在');
  return { ref, mine, cid: healed.theirs.id, stamp: healed.backup.split('/')[1] };
}

before(async () => {
  root = mkTmp();
  const cli = writeDriverCli(root);
  remote = makeBareRemote(path.join(root, 'remote.git'));
  const mA = machinePaths(root, 'office');
  const mB = machinePaths(root, 'home');
  await init({ ...mA, machineLabel: 'A', remote, cli });
  A = await open(mA);
  assert.equal((await settle(A)).ok, true);
  await init({ ...mB, machineLabel: 'B', remote, cli });
  B = await open(mB);
  assert.equal((await settle(B)).ok, true);
  assert.equal((await settle(A)).ok, true);
});
after(() => rmTmp(root));

describe('F1：自我修復留下的衝突，自動駕駛不處理', () => {
  test('自動駕駛那一步不送 LLM、不動衝突紀錄、在執行紀錄註明原因，扣住的本機檔案一字不差', async () => {
    const { ref, mine, cid } = await healConflict('f1-auto', 1);
    const run = fresh();
    const labels = [];
    const call = async (label) => { labels.push(label); return { ok: true, data: { decisions: [{ id: cid, choice: 'theirs', reason: '對方的版本較新' }], verdicts: [{ id: cid, verdict: 'approve', reason: '被遮蔽的金鑰不算事實' }] } }; };
    call.state = {};
    await resolveConflicts({ eg: A, call, run, paused: [], preferences: '' });
    assert.deepEqual(labels, [], '沒有任何 LLM 呼叫（連判斷都不問）');
    assert.equal(run.actions.length, 0, '沒有處理任何衝突');
    assert.equal(run.skipped.length, 1);
    assert.equal(run.skipped[0].task, 'conflicts');
    assert.match(run.skipped[0].why, /自我修復/);
    assert.match(run.skipped[0].why, /留給你/);
    assert.ok(run.skipped[0].why.includes(ref));
    assert.ok(fs.readFileSync(vaultFile(A, ref)).equals(mine), '本機版本逐位元組不變');
    assert.ok((await A.conflicts.list()).some((c) => c.id === cid && c.by === 'heal'), '衝突紀錄還在，標明來源');
  });

  test('不是自我修復建立的、但任何一邊含金鑰遮蔽標記的衝突，一樣不自動處理', async () => {
    const ref = 'global/f1-masked.md';
    const id = await quarantine(A.paths.vault, { ref, kind: 'content', ours: '---\nname: f1-masked\n---\n\n金鑰是 ‹已遮蔽：anthropic› 的值。\n', theirs: '---\nname: f1-masked\n---\n\n另一個版本。\n', summary: '測試用' });
    const run = fresh();
    const call = async () => { throw new Error('不該呼叫 LLM'); };
    call.state = {};
    await resolveConflicts({ eg: A, call, run, paused: [], preferences: '' });
    assert.equal(run.actions.length, 0);
    assert.ok(run.skipped.some((s) => s.why.includes(ref)));
    assert.ok((await A.conflicts.list()).some((c) => c.id === id));
    await A.conflicts.resolve(id, { choice: 'ours' });
  });
});

describe('F1：解衝突要覆蓋有未提交內容的原檔時先備份（不論誰呼叫）', () => {
  test('使用者選 theirs：備份在 local/backup，內容與原檔一字不差，回傳備份位置；原檔變成對方的版本', async () => {
    const { ref, mine, cid } = await healConflict('f1-theirs', 2);
    const r = await A.conflicts.resolve(cid, { choice: 'theirs' });
    assert.equal(r.ok, true);
    assert.match(r.backup, /^backup\/[0-9TZ]+\/global\/f1-theirs\.md$/);
    const saved = path.join(A.paths.local, ...r.backup.split('/'));
    assert.ok(fs.readFileSync(saved).equals(mine), '備份與扣住的本機版本逐位元組相同（含 BOM、CRLF）');
    assert.match(fs.readFileSync(vaultFile(A, ref), 'utf8'), /對方補的一句/);
    assert.ok(fs.existsSync(path.join(path.dirname(saved).replace(/[\\/]global$/, ''), 'heal-backup.json')), '沿用備份的標記檔，gc 才認得');
    // 復原也找不回本機版本（它從來沒進過 git）：備份就是唯一的來源，所以一定要有
    assert.equal(fs.existsSync(saved), true);
  });

  test('使用者選 manual：一樣先備份', async () => {
    const { ref, mine, cid } = await healConflict('f1-manual', 3);
    const body = '---\nname: f1-manual\ndescription: "合併後"\nmetadata:\n  type: reference\n---\n\n合併後的內容。\n';
    const r = await A.conflicts.resolve(cid, { choice: 'manual', body });
    assert.ok(fs.readFileSync(path.join(A.paths.local, ...r.backup.split('/'))).equals(mine));
    assert.match(fs.readFileSync(vaultFile(A, ref), 'utf8'), /合併後的內容/);
  });

  test('選 ours、選 both、或原檔和 HEAD 一樣（沒有未提交的內容）：不備份，不多出沒用的資料夾', async () => {
    const { mine, cid } = await healConflict('f1-ours', 4);
    const before = fs.readdirSync(path.join(A.paths.local, 'backup')).length;
    const r = await A.conflicts.resolve(cid, { choice: 'ours' });
    assert.equal(r.backup, undefined);
    assert.equal(fs.readdirSync(path.join(A.paths.local, 'backup')).length, before);
    assert.ok(mine.length > 0);
    // 原檔乾淨（已經提交、和 HEAD 一樣）：選 theirs 也不備份
    await A.memories.create({ scope: { kind: 'global' }, name: 'f1-clean', type: 'reference', description: '乾淨', body: '乾淨。' });
    assert.equal((await settle(A)).ok, true);
    const id = await quarantine(A.paths.vault, { ref: 'global/f1-clean.md', kind: 'content', ours: '乾淨。', theirs: '---\nname: f1-clean\ndescription: "他的"\nmetadata:\n  type: reference\n---\n\n他的版本。\n', summary: '測試用' });
    const r2 = await A.conflicts.resolve(id, { choice: 'theirs' });
    assert.equal(r2.backup, undefined);
  });

  test('備份失敗（local/backup 寫不進去）時不覆蓋：丟錯，原檔原封不動、衝突紀錄還在', async () => {
    const { ref, mine, cid } = await healConflict('f1-nobackup', 5);
    const dir = path.join(A.paths.local, 'backup');
    const moved = `${dir}-moved`;
    fs.renameSync(dir, moved);
    fs.writeFileSync(dir, '我是檔案，不是資料夾');
    try {
      await assert.rejects(A.conflicts.resolve(cid, { choice: 'theirs' }), (e) => e.code === 'E_CONFLICT' && /備份/.test(e.message));
      assert.ok(fs.readFileSync(vaultFile(A, ref)).equals(mine), '原檔原封不動');
      assert.ok((await A.conflicts.list()).some((c) => c.id === cid));
    } finally {
      fs.rmSync(dir, { force: true });
      fs.renameSync(moved, dir);
    }
  });
});

describe('F1：對應的衝突紀錄還在，自我修復的備份就不清理', () => {
  test('超過 30 天也不刪；使用者處理完（紀錄刪掉）之後才會被清掉', async () => {
    const { cid, stamp, mine, ref } = await healConflict('f1-prune', 6);
    const healDir = path.join(A.paths.local, 'backup', stamp);
    assert.ok(fs.readFileSync(path.join(healDir, ...ref.split('/'))).equals(mine));
    assert.equal(JSON.parse(fs.readFileSync(path.join(A.paths.vault, 'conflicts', cid, 'meta.json'), 'utf8')).healBackup, stamp, '紀錄指向這份備份');
    await pruneHealBackups(A._ctx, { now: Date.now() + 40 * DAY });
    assert.equal(fs.existsSync(healDir), true, '紀錄還在：不刪');
    await A.conflicts.resolve(cid, { choice: 'ours' });
    await pruneHealBackups(A._ctx, { now: Date.now() + 40 * DAY });
    assert.equal(fs.existsSync(healDir), false, '紀錄處理掉之後，超過 30 天才清');
  });
});

describe('F9：合併完成但放回失敗，下一次同步不能無條件覆蓋原位被改過的內容', () => {
  /** A 本機新增含金鑰的檔案（被扣住），B 推同名檔；用注入的檔案操作讓「放回」失敗（合併已經成功）。回傳放回失敗之後的狀態 */
  async function mergedButNotRestored(name, n) {
    const ref = `global/${name}.md`;
    const mine = heldBytes(name, n);
    fs.writeFileSync(vaultFile(A, ref), mine);
    age(vaultFile(A, ref));
    assert.equal((await settle(A)).ok, true);
    await B.memories.create({ scope: { kind: 'global' }, name, type: 'reference', description: '對方的', body: '對方的內容。' });
    assert.equal((await settle(B)).ok, true);
    await engineGit(['fetch', 'origin'], { cwd: A.paths.vault });
    const headBefore = (await engineGit(['rev-parse', 'HEAD'], { cwd: A.paths.vault })).stdout.trim();
    const original = vaultFile(A, ref);
    const locked = (p) => path.resolve(p) === path.resolve(original) || path.resolve(p).startsWith(path.resolve(A.paths.vault));
    const io = {
      rename: (from, to) => { if (locked(to)) throw Object.assign(new Error('EPERM: 檔案被防毒軟體鎖住'), { code: 'EPERM' }); return fs.renameSync(from, to); },
      copyFile: (from, to, ...rest) => { if (locked(to)) throw Object.assign(new Error('EPERM: 檔案被防毒軟體鎖住'), { code: 'EPERM' }); return fs.copyFileSync(from, to, ...rest); },
    };
    await assert.rejects(healBlockedMerge(A._ctx, {
      blockers: [ref],
      plan: { secrets: [{ ref, kinds: ['anthropic'] }], recent: [], held: [], unmerged: [] },
      headBefore,
      theirsRef: 'refs/remotes/origin/main',
      merge: async () => { await engineGit(['merge', '--ff-only', 'refs/remotes/origin/main'], { cwd: A.paths.vault }); },
      io,
    }), (e) => e.code === 'E_CONFLICT' && /還沒放回原位/.test(e.message));
    return { ref, mine, original };
  }
  const marker = () => JSON.parse(fs.readFileSync(path.join(A.paths.local, 'heal-pending.json'), 'utf8'));

  test('合併成功、放回失敗：標記檔留著並記下合併後 HEAD 的版本；原位是合併帶進來的對方版本，本機版本在暫存', async () => {
    const { ref, mine, original } = await mergedButNotRestored('f9-state', 7);
    const m = marker();
    assert.equal(m.phase, 'merged');
    const headBlob = (await engineGit(['rev-parse', `HEAD:${ref}`], { cwd: A.paths.vault })).stdout.trim();
    assert.equal(m.files[0].headBlob, headBlob);
    assert.match(fs.readFileSync(original, 'utf8'), /對方的內容/);
    assert.ok(fs.readFileSync(m.files[0].aside).equals(mine), '本機版本還在暫存');
    // 原位沒人動過：恢復時直接放回，不多存備份
    const r = await recoverHeal(A._ctx);
    assert.deepEqual(r.files, [ref]);
    assert.deepEqual(r.preserved, []);
    assert.ok(fs.readFileSync(original).equals(mine));
    assert.equal(fs.existsSync(path.join(A.paths.local, 'heal-pending.json')), false);
    await engineGit(['checkout', '--', ref], { cwd: A.paths.vault }); // 收拾：把被扣住的本機版本換回記憶庫的版本，免得影響後面的測試
  });

  test('放回失敗的這段期間有人改了那筆記憶：下一次同步先把目前的內容另存，再放回本機版本，並回報與寫進 state.json', async () => {
    const { ref, mine, original } = await mergedButNotRestored('f9-edited', 8);
    const edited = '---\nname: f9-edited\ndescription: "這段期間改的"\nmetadata:\n  type: reference\n---\n\nClaude 在放回失敗的這段期間改的內容。\n';
    fs.writeFileSync(original, edited);
    const r = await settle(A);
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.healRecovered.preserved.length, 1);
    const kept = r.healRecovered.preserved[0];
    assert.equal(kept.ref, ref);
    assert.equal(fs.readFileSync(path.join(A.paths.local, ...kept.backup.split('/')), 'utf8'), edited, '被改過的內容另存，一字不差');
    assert.ok(fs.readFileSync(original).equals(mine), '本機版本放回');
    const st = JSON.parse(fs.readFileSync(path.join(A.paths.local, 'state.json'), 'utf8'));
    assert.deepEqual(st.syncHeal.preserved, r.healRecovered.preserved);
    assert.equal(fs.existsSync(path.join(A.paths.local, 'heal-pending.json')), false);
    await engineGit(['checkout', '--', ref], { cwd: A.paths.vault });
    await settle(A);
  });

  test('標記檔沒有 headBlob（舊的標記、或合併還沒完成就被終止）而原位已經有檔案：保守起見先另存再放回', async () => {
    const ref = 'global/f9-nohead.md';
    const mine = heldBytes('f9-nohead', 9);
    const aside = path.join(A.paths.local, 'tmp', 'heal-19990103T000000000Z', 'global', 'f9-nohead.md');
    const backup = path.join(A.paths.local, 'backup', '19990103T000000000Z', 'global', 'f9-nohead.md');
    for (const p of [aside, backup]) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, mine); }
    fs.writeFileSync(vaultFile(A, ref), '原位已經有別的內容\n');
    fs.writeFileSync(path.join(A.paths.local, 'heal-pending.json'), JSON.stringify({ v: 1, files: [{ ref, original: vaultFile(A, ref), aside, backup }] }));
    const r = await recoverHeal(A._ctx);
    assert.equal(r.preserved.length, 1);
    assert.equal(fs.readFileSync(path.join(A.paths.local, ...r.preserved[0].backup.split('/')), 'utf8'), '原位已經有別的內容\n');
    assert.ok(fs.readFileSync(vaultFile(A, ref)).equals(mine));
    fs.rmSync(vaultFile(A, ref));
  });
});
