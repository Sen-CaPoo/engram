// 匯入精靈後端的端到端測試：在完全假造的電腦（暫存資料夾）上跑「計畫 → 演練 → 套用 → 還原」。
// 不碰真實的 ~/.claude、~/.engram 或任何真實專案資料夾。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { planImport, rehearseImport, applyImport, undoImport } from '../../src/migrate/index.mjs';
import { applyEdits, sanitizeEdits, itemKey } from '../../src/migrate/plan.mjs';
import { fingerprintLegacy } from '../../src/migrate/rehearse.mjs';
import { mkTmp, rmTmp, machinePaths, makeRepo, addTranscript, memoryText } from '../core/helpers.mjs';

function fakeMachine() {
  const root = mkTmp('engram-migrate-');
  const m = machinePaths(root, 'pc');
  const app = makeRepo(path.join(m.userHome, 'Desktop', 'shop-app'), { remote: 'https://github.com/example/shop-app.git' });
  const notes = path.join(m.userHome, 'Desktop', 'notes');
  fs.mkdirSync(notes, { recursive: true });
  const legacy = [];
  for (const [dir, files] of [
    [app, { 'db-choice.md': memoryText({ name: 'db-choice', description: '資料庫採用 PostgreSQL', type: 'project' }), 'user-pref.md': memoryText({ name: 'user-pref', description: '回覆一律使用正體中文', type: 'user' }) }],
    [notes, { 'printer.md': memoryText({ name: 'printer', description: '這台電腦的印表機要先裝驅動', type: 'reference', body: '本機安裝路徑在 C:\\Drivers。' }) }],
  ]) {
    const t = addTranscript(m.claudeHome, dir);
    const mem = path.join(t.dir, 'memory');
    fs.mkdirSync(mem, { recursive: true });
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(mem, f), text);
    fs.writeFileSync(path.join(mem, 'MEMORY.md'), Object.keys(files).map((f) => `- [${f}](${f})`).join('\n') + '\n');
    legacy.push({ dir, enc: t.enc, mem });
  }
  return { root, m, app, notes, legacy };
}

test('調整內容會被驗證並套用到計畫上', () => {
  const plan = { sources: [{ encoded: 'E1', how: 'transcript-cwd', target: { pid: null, name: 'x', isNew: true, archived: false }, items: [{ file: 'a.md', action: 'copy', scope: 'global' }, { file: 'b.md', action: 'copy', scope: 'project' }] }], totals: {} };
  const edits = sanitizeEdits({ items: { [itemKey('E1', 'a.md')]: { scope: 'project', evil: 1 }, [itemKey('E1', 'b.md')]: { action: 'skip-same' }, 'E1/c.md': { scope: 'nope' } }, names: { E1: '  新名字  ' } });
  assert.deepEqual(Object.keys(edits.items).sort(), ['E1/a.md', 'E1/b.md']);
  const out = applyEdits(plan, edits);
  assert.equal(out.sources[0].target.name, '新名字');
  assert.equal(out.sources[0].items[0].scope, 'project');
  assert.equal(out.totals.copy, 1);
  assert.equal(out.totals.skip, 1);
  assert.equal(plan.sources[0].items[0].scope, 'global', '原計畫不應被修改');
});

test('同一個編碼資料夾拆成多個來源時，命名與採用建議以來源為單位；只寫編碼的舊格式仍套用到該編碼的所有來源', () => {
  const src = (resolvedPath, file) => ({ encoded: 'E4', resolvedPath, how: 'content-path', target: { pid: null, name: resolvedPath.split('\\').pop(), isNew: true, archived: true }, items: [{ file, action: 'copy', scope: 'project' }] });
  const plan = { sources: [src('C:\\u\\Desktop\\甲方報告', 'a.md'), src('C:\\u\\Desktop\\乙方表單', 'b.md')], totals: {} };
  const out = applyEdits(plan, {
    names: { 'E4|C:\\u\\Desktop\\甲方報告': '甲方月報' },
    targets: { 'E4|C:\\u\\Desktop\\乙方表單': { path: 'C:\\u\\Desktop\\文件\\乙方表單' } },
  });
  assert.equal(out.sources[0].target.name, '甲方月報');
  assert.equal(out.sources[0].resolvedPath, 'C:\\u\\Desktop\\甲方報告', '另一個來源不受影響');
  assert.equal(out.sources[1].target.name, '乙方表單', '另一個來源不受影響');
  assert.equal(out.sources[1].resolvedPath, 'C:\\u\\Desktop\\文件\\乙方表單');
  const legacy = applyEdits(plan, { names: { E4: '舊格式' } });
  assert.deepEqual(legacy.sources.map((s) => s.target.name), ['舊格式', '舊格式']);
});

test('計畫 → 演練 → 套用 → 還原：全程可逆，原始記憶不變', async (t) => {
  const f = fakeMachine();
  t.after(() => rmTmp(f.root));
  await init({ home: f.m.home, claudeHome: f.m.claudeHome, userHome: f.m.userHome, machineLabel: '測試電腦' });
  const eg = await open({ home: f.m.home, claudeHome: f.m.claudeHome, userHome: f.m.userHome });
  const before = fingerprintLegacy(f.m.claudeHome);

  const plan = await planImport(eg);
  assert.equal(plan.totals.memories, 3);
  assert.equal(plan._srcDirs, undefined, '對外的計畫不能帶出內部路徑對照');
  assert.equal(plan.applied, false);

  // 使用者把 user-pref 留在專案範圍（示範調整）
  const appSrc = plan.sources.find((s) => s.items.some((i) => i.file === 'user-pref.md'));
  const edits = { items: { [itemKey(appSrc.encoded, 'user-pref.md')]: { scope: 'project' } } };

  const rh = await rehearseImport(eg, { edits });
  assert.equal(rh.ok, true, JSON.stringify(rh, null, 2));
  assert.equal(rh.realUntouched.ok, true);
  assert.deepEqual(fingerprintLegacy(f.m.claudeHome), before, '演練不能動到原始記憶');

  const applied = await applyImport(eg, { edits });
  assert.equal(applied.ok, true);
  assert.equal(applied.copied, 3);
  const mems = await eg.memories.list({});
  assert.equal(mems.length, 3);
  assert.ok(mems.find((m) => m.name === 'user-pref' && m.scope.kind === 'project'), '調整後的範圍要生效');
  const again = await planImport(eg);
  assert.equal(again.applied, true);
  assert.equal(again.tag, applied.tag);

  const undone = await undoImport(eg, { tag: applied.tag });
  assert.equal(undone.ok, true);
  assert.equal((await eg.memories.list({})).length, 0, '還原後 vault 不應留下匯入的記憶');
  for (const l of f.legacy) {
    assert.equal(fs.lstatSync(l.mem).isSymbolicLink(), false, '還原後記憶資料夾要換回實體資料夾');
    for (const file of fs.readdirSync(l.mem).filter((n) => n !== 'MEMORY.md')) {
      assert.ok(before[`${l.enc}/${file}`], `還原後多出未知檔案 ${file}`);
    }
  }
  await assert.rejects(() => undoImport(eg, { tag: applied.tag }), /已經還原過/);
});

test('匯入時親自改過範圍的記憶，不會馬上出現「改回去」的卡片；演練不留下沙盒暫存資料夾', async (t) => {
  const f = fakeMachine();
  t.after(() => rmTmp(f.root));
  await init({ home: f.m.home, claudeHome: f.m.claudeHome, userHome: f.m.userHome, machineLabel: '測試電腦' });
  const eg = await open({ home: f.m.home, claudeHome: f.m.claudeHome, userHome: f.m.userHome });
  const plan = await planImport(eg);
  const notesSrc = plan.sources.find((s) => s.items.some((i) => i.file === 'printer.md'));
  assert.equal(notesSrc.items.find((i) => i.file === 'printer.md').scope, 'machine', '前提：印表機記憶預設判為單機');
  const edits = { items: { [itemKey(notesSrc.encoded, 'printer.md')]: { scope: 'project' } } };

  assert.equal((await rehearseImport(eg, { edits })).ok, true);
  const applied = await applyImport(eg, { edits });
  assert.equal(applied.ok, true);
  const isPrinterH08 = (x) => x.code === 'H08' && x.refs[0].endsWith('/printer.md');
  assert.ok(!(await eg.health()).some(isPrinterH08), '使用者決定留在專案，收件匣不再建議改單機');
  assert.ok((await eg.health({ includeDismissed: true })).some((x) => isPrinterH08(x) && x.dismissed), '只是忽略：仍可在收件匣恢復');
  const leftovers = fs.readdirSync(path.join(eg.paths.local, 'tmp')).filter((n) => n.startsWith('rehearsal-'));
  assert.deepEqual(leftovers, [], '演練結束後的寫入不能重建已刪除的沙盒資料夾');
});

test('SW-2：計畫產生後來源又被修改 → 這個來源這次不套用，重新規劃後才匯入並接上', async (t) => {
  const f = fakeMachine();
  t.after(() => rmTmp(f.root));
  await init({ home: f.m.home, claudeHome: f.m.claudeHome, userHome: f.m.userHome, machineLabel: '測試電腦' });
  const eg = await open({ home: f.m.home, claudeHome: f.m.claudeHome, userHome: f.m.userHome });
  const appLegacy = f.legacy.find((l) => l.dir === f.app);
  // 精靈送出的調整：使用者略過 user-pref.md，並附上規劃當時每個來源的指紋
  const wizardEdits = (plan) => ({
    items: { [itemKey(appLegacy.enc, 'user-pref.md')]: { action: 'skip-same' } },
    revs: Object.fromEntries(plan.sources.map((s) => [`${s.encoded}|${s.resolvedPath ?? ''}`, s.rev])),
  });

  const plan = await planImport(eg);
  assert.ok(plan.sources.every((s) => /^[0-9a-f]{16}$/.test(s.rev)), '每個來源都要有指紋');
  // 產生計畫之後，Claude 又改了這個來源的一筆記憶
  fs.writeFileSync(path.join(appLegacy.mem, 'db-choice.md'), memoryText({ name: 'db-choice', description: '資料庫改用 PostgreSQL 16', type: 'project' }));

  const applied = await applyImport(eg, { edits: wizardEdits(plan) });
  assert.deepEqual(applied.deferred, [{ path: f.app, reason: 'changed-since-plan' }]);
  assert.equal(applied.copied, 1, '沒有變更的來源照常匯入');
  assert.equal(fs.lstatSync(appLegacy.mem).isSymbolicLink(), false, '延後的來源不能換成 junction');
  assert.deepEqual((await eg.memories.list({})).map((m) => m.name), ['printer']);

  // 重新規劃：看到改過的內容，套用後才匯入並接上；使用者略過的檔案仍不進 vault
  const again = await planImport(eg);
  assert.deepEqual(again.sources.map((s) => s.encoded), [appLegacy.enc]);
  const applied2 = await applyImport(eg, { edits: wizardEdits(again) });
  assert.deepEqual(applied2.deferred, []);
  assert.equal(fs.lstatSync(appLegacy.mem).isSymbolicLink(), true);
  const names = (await eg.memories.list({})).map((m) => m.name).sort();
  assert.deepEqual(names, ['db-choice', 'printer']);
  const db = (await eg.memories.list({})).find((m) => m.name === 'db-choice');
  assert.match(db.description, /PostgreSQL 16/, '匯入的是使用者重新審閱過的內容');
});

test('SW-2：所有來源都有變更時不建立還原點，只回報延後', async (t) => {
  const f = fakeMachine();
  t.after(() => rmTmp(f.root));
  await init({ home: f.m.home, claudeHome: f.m.claudeHome, userHome: f.m.userHome, machineLabel: '測試電腦' });
  const eg = await open({ home: f.m.home, claudeHome: f.m.claudeHome, userHome: f.m.userHome });
  const plan = await planImport(eg);
  const revs = Object.fromEntries(plan.sources.map((s) => [`${s.encoded}|${s.resolvedPath ?? ''}`, s.rev]));
  for (const l of f.legacy) fs.writeFileSync(path.join(l.mem, 'late.md'), memoryText({ name: 'late', description: '規劃後才寫的記憶', type: 'project' }));
  const r = await applyImport(eg, { edits: { revs } });
  assert.equal(r.tag, null);
  assert.equal(r.deferred.length, 2);
  assert.equal((await planImport(eg)).applied, false, '沒有套用任何東西，不能留下匯入紀錄');
});

test('R-25：三個中文撞名資料夾共用一個記憶資料夾 → 各自以 settings 綁定，不建立 junction', async (t) => {
  const root = mkTmp('engram-collide-');
  t.after(() => rmTmp(root));
  const m = machinePaths(root, 'pc');
  // 三個名稱都是四個中文字的資料夾：路徑編碼完全相同
  const dirs = ['甲乙丙丁', '春夏秋冬', '東南西北'].map((n) => path.join(m.userHome, 'Desktop', n));
  const sessions = dirs.map((d) => { fs.mkdirSync(d, { recursive: true }); return addTranscript(m.claudeHome, d); });
  assert.equal(new Set(sessions.map((s) => s.enc)).size, 1, '三個資料夾的編碼應相同');
  const mem = path.join(sessions[0].dir, 'memory');
  fs.mkdirSync(mem, { recursive: true });
  sessions.forEach((s, i) => fs.writeFileSync(path.join(mem, `note-${i}.md`), memoryText({ name: `note-${i}`, description: `第 ${i + 1} 個資料夾的記憶`, originSessionId: s.sessionId })));
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), sessions.map((_, i) => `- [note-${i}](note-${i}.md)`).join('\n') + '\n');

  await init({ home: m.home, claudeHome: m.claudeHome, userHome: m.userHome, machineLabel: '測試電腦' });
  const eg = await open({ home: m.home, claudeHome: m.claudeHome, userHome: m.userHome });
  const plan = await planImport(eg);
  assert.deepEqual(plan.sources.map((s) => s.resolvedPath).sort(), [...dirs].sort(), '依 originSessionId 分成三個來源');

  const revs = Object.fromEntries(plan.sources.map((s) => [`${s.encoded}|${s.resolvedPath ?? ''}`, s.rev]));
  const applied = await applyImport(eg, { edits: { revs } });
  assert.deepEqual(applied.deferred, []);
  assert.equal(applied.bound, 3);
  assert.equal(fs.lstatSync(mem).isSymbolicLink(), false, '共用的記憶資料夾不能換成 junction');
  for (const [i, d] of dirs.entries()) {
    const local = JSON.parse(fs.readFileSync(path.join(d, '.claude', 'settings.local.json'), 'utf8'));
    assert.ok(local.autoMemoryDirectory, `${d} 要寫入 autoMemoryDirectory`);
    const dir = local.autoMemoryDirectory.replace(/^~(?=[\\/])/, m.userHome); // Claude Code 會自行展開 ~，各台電腦通用
    assert.ok(fs.existsSync(path.join(dir, `note-${i}.md`)), '各自的記憶在自己的專案裡');
  }
  const pids = new Set((await eg.memories.list({})).map((x) => x.scope.pid));
  assert.equal(pids.size, 3, '三個資料夾是三個不同的專案');

  // 還原：settings 綁定移除，原記憶資料夾保持原樣
  await undoImport(eg, { tag: applied.tag });
  for (const d of dirs) {
    const f = path.join(d, '.claude', 'settings.local.json');
    assert.ok(!fs.existsSync(f) || !JSON.parse(fs.readFileSync(f, 'utf8')).autoMemoryDirectory, '還原後移除 autoMemoryDirectory');
  }
  assert.deepEqual(fs.readdirSync(mem).sort(), ['MEMORY.md', 'note-0.md', 'note-1.md', 'note-2.md']);
});

// 兩個來源的 commit 順序：匯入 A、匯入 B（全部複製完）→ 綁定 A、綁定 B
for (const [failAt, what] of [[3, '第一個綁定的 commit'], [4, '第二個綁定的 commit（第一個已接上）']]) {
  test(`中途失敗（${what}）：留下紀錄與還原點，失敗的綁定自行撤銷，「還原到匯入前」回到原狀`, async (t) => {
    const f = fakeMachine();
    t.after(() => rmTmp(f.root));
    await init({ home: f.m.home, claudeHome: f.m.claudeHome, userHome: f.m.userHome, machineLabel: '測試電腦' });
    const eg = await open({ home: f.m.home, claudeHome: f.m.claudeHome, userHome: f.m.userHome });
    const before = fingerprintLegacy(f.m.claudeHome);
    // 注入失敗：vault 的第 failAt 個 commit 失敗（此時記憶資料夾已換成 junction）
    const hook = path.join(eg.paths.vault, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, `#!/bin/sh\nf="$(git rev-parse --git-dir)/fail-count"\nn=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$f"\n[ $n -ge ${failAt} ] && { echo injected >&2; exit 1; }\nexit 0\n`);
    fs.chmodSync(hook, 0o755);

    const err = await applyImport(eg, {}).then(() => null, (e) => e);
    assert.ok(err, '應該失敗');
    assert.ok(err.tag, '錯誤要帶出這次匯入的紀錄，讓使用者能還原');
    assert.match(err.hint, /還原到匯入前/);
    const p = await planImport(eg);
    assert.equal(p.applied, true);
    assert.equal(p.tag, err.tag);
    assert.ok(p.lastImport.failed, '精靈要知道上次匯入中途失敗');
    const linked = f.legacy.filter((l) => fs.lstatSync(l.mem).isSymbolicLink()).length;
    assert.equal(linked, failAt - 3, '失敗的那一個綁定已自行撤銷；在它之前完成的綁定仍在');

    fs.rmSync(hook);
    const undone = await undoImport(eg, { tag: err.tag });
    assert.equal(undone.ok, true, JSON.stringify(undone));
    for (const l of f.legacy) assert.equal(fs.lstatSync(l.mem).isSymbolicLink(), false, '還原後換回實體資料夾');
    assert.equal((await eg.memories.list({})).length, 0);
    assert.deepEqual(fingerprintLegacy(f.m.claudeHome), before, '原始記憶與匯入前一致');
    assert.equal(fs.existsSync(path.join(f.notes, '.claude')), false, '非 git 資料夾的標記檔與設定檔都清掉');
  });
}
