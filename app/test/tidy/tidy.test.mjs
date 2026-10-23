// 記憶整理（1.3.0）：整理計畫的驗證、整理記錄的決定、照核可內容執行、Claude 記回結果與整項復原。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { revOf } from '../../src/cli/commands/safe.mjs';
import { applyRecord, recordResult, undoItem } from '../../src/tidy/apply.mjs';
import { createFromPlan, parseScopeArg } from '../../src/tidy/plan.mjs';
import { recordView } from '../../src/tidy/view.mjs';
import { allowedDecisions, applyingNow, deleteRecord, listRecords, markReady, pruneRecords, readRecord, setDecisions, writeRecord } from '../../src/tidy/store.mjs';
import { machinePaths, makeRepo, mkTmp, rmTmp, writeDriverCli } from '../core/helpers.mjs';

let root;
let eg;
let pid;
let n = 0;

const vaultFile = (ref) => path.join(eg.paths.vault, ...ref.split('/'));
const raw = (ref) => fs.readFileSync(vaultFile(ref), 'utf8');
/** 讀取當下的版本（計畫的 base） */
const B = (ref) => revOf(raw(ref));

function memFile({ name, description, type = 'feedback', body }) {
  return `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;
}

/** 在暫存資料夾寫一份計畫（files：檔名 → 內容），回傳計畫檔路徑 */
function writePlan(plan, files = {}, dir = path.join(root, 'plans', `p${++n}`)) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  const file = path.join(dir, 'plan.json');
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));
  return file;
}

async function remember(name, description, body, scope = { kind: 'global' }, type = 'feedback') {
  const r = await eg.memories.create({ scope, name, type, description, body });
  return r.ref;
}

before(async () => {
  root = mkTmp();
  const m = machinePaths(root, 'home');
  await init({ ...m, machineLabel: '家裡電腦', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
  const repo = makeRepo(path.join(root, 'work', 'gateway'));
  pid = (await eg.identity.bind(repo, { create: { name: '閘道' } })).pid;
});
after(() => rmTmp(root));

describe('範圍參數', () => {
  test('global、machine、project、core、all、記憶 ref 與舊的 pid 寫法', () => {
    assert.deepEqual(parseScopeArg('global', 'pc-1'), { kind: 'global' });
    assert.deepEqual(parseScopeArg('machine', 'pc-1'), { kind: 'machine', mid: 'pc-1' });
    assert.deepEqual(parseScopeArg('project:demo-12345', 'pc-1'), { kind: 'project', pid: 'demo-12345' });
    assert.deepEqual(parseScopeArg('demo-12345', 'pc-1'), { kind: 'project', pid: 'demo-12345' });
    assert.deepEqual(parseScopeArg('core'), { kind: 'core' });
    assert.deepEqual(parseScopeArg('all'), { kind: 'all' });
    assert.deepEqual(parseScopeArg('global/a.md'), { kind: 'memory', ref: 'global/a.md' });
    assert.equal(parseScopeArg('../etc'), null);
    assert.equal(parseScopeArg('Global Memories'), null);
  });
});

describe('建立整理記錄', () => {
  test('合法的計畫：每一項記下版本與修改後的內容，狀態是待使用者決定', async () => {
    const a = await remember('profile', '使用者背景', '在公司負責專案。');
    const b = await remember('old-note', '過時的筆記', '舊的。');
    const c = await remember('report-html', '報告用 HTML', '報告做成 HTML。');
    const newA = memFile({ name: 'profile', description: '使用者背景（更新）', type: 'feedback', body: '在公司負責專案與內訓。' });
    const plan = {
      scope: 'global',
      request: '重點看重複',
      summary: '有一筆過時、一筆要搬到專案。',
      highlights: ['過時的筆記建議封存'],
      items: [
        { ref: a, group: '背景', action: 'update', title: '補上內訓', reason: '說明不完整', ops: [{ op: 'write', ref: a, base: revOf(raw(a)), file: 'profile.md' }] },
        { ref: b, action: 'archive', title: '封存', reason: '已經過時', ops: [{ op: 'remove', ref: b, base: B(b) }] },
        { ref: c, action: 'keep', title: '保留', reason: '仍然有效', ops: [] },
        { ref: null, action: 'create', title: '新增一筆', reason: '抽出跨專案的經驗', ops: [{ op: 'create', scope: 'global', file: 'new/longpaths.md' }] },
      ],
    };
    const file = writePlan(plan, { 'profile.md': newA, 'new/longpaths.md': memFile({ name: 'git-longpaths', description: 'git 長路徑', type: 'reference', body: '設 core.longpaths true。' }) });
    const rec = await createFromPlan(eg, file);
    assert.match(rec.id, /^\d{8}-\d{6}-[a-z0-9]{4}$/);
    assert.equal(rec.status, 'pending');
    assert.equal(rec.scope, 'global');
    assert.equal(rec.request, '重點看重複');
    assert.deepEqual(rec.items.map((it) => it.id), ['i1', 'i2', 'i3', 'i4']);
    assert.equal(rec.items[0].base, revOf(raw(a)));
    assert.equal(rec.items[0].ops[0].content, newA);
    assert.equal(rec.items[1].ops[0].base, revOf(raw(b)));
    assert.equal(rec.items[3].name, 'git-longpaths');
    assert.equal(rec.items[3].ops[0].ref, 'global/git-longpaths.md');
    assert.equal(rec.items[2].group, null);
    const list = await listRecords(eg.paths.local);
    assert.equal(list[0].id, rec.id);
    assert.equal(list[0].counts.suggested, 3);
    assert.ok(fs.existsSync(file), '不在草稿資料夾的計畫檔不動');
  });

  test('計畫有問題時一次列出所有問題，不建立記錄', async () => {
    const a = await remember('dup-a', '重複 A', '內容 A。');
    const b = await remember('dup-b', '重複 B', '內容 B，含 ‹已遮蔽：token›。');
    const before = (await listRecords(eg.paths.local)).length;
    const plan = {
      scope: 'global',
      summary: '測試',
      items: [
        { ref: 'global/nope.md', action: 'update', title: 't', reason: 'r', ops: [{ op: 'write', ref: 'global/nope.md', file: 'x.md' }] },
        { ref: a, action: 'update', title: 't', reason: 'r', ops: [{ op: 'write', ref: a, base: '0000000000', file: 'a.md' }] },
        { ref: b, action: 'update', title: 't', reason: 'r', ops: [{ op: 'write', ref: b, base: B(b), file: 'b.md' }, { op: 'write', ref: a, base: B(a), file: 'a2.md' }] },
        { ref: a, action: 'keep', title: 't', reason: 'r', ops: [{ op: 'remove', ref: a, base: B(a) }] },
        { ref: null, action: 'create', title: 't', reason: 'r', ops: [{ op: 'create', scope: 'global', file: '../escape.md' }] },
      ],
    };
    const file = writePlan(plan, {
      'a.md': memFile({ name: 'wrong-name', description: 'd', body: '改了 ‹已遮蔽：x›' }),
      'b.md': memFile({ name: 'dup-b', description: 'd', body: '內容 B。' }),
      'a2.md': memFile({ name: 'dup-a', description: 'd', body: 'x' }),
    });
    await assert.rejects(createFromPlan(eg, file), (err) => {
      assert.equal(err.code, 'E_INVALID');
      for (const re of [/記憶不存在/, /被修改過/, /name（wrong-name）/, /‹已遮蔽›/, /已經由第 2 項處理/, /同一筆記憶出現在第 2 項與第 4 項/, /不能有 ops/, /同一個資料夾/]) assert.match(err.message, re);
      return true;
    });
    assert.equal((await listRecords(eg.paths.local)).length, before);
  });

  test('不是 JSON、範圍看不懂、內容和目前相同、新增的檔名已存在都會擋下', async () => {
    const dir = path.join(root, 'plans', 'bad-json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plan.json'), '{ "scope": "global", ');
    await assert.rejects(createFromPlan(eg, path.join(dir, 'plan.json')), /不是有效的 JSON/);
    const a = await remember('same', '相同', '一樣。');
    const file = writePlan({ scope: 'everything', summary: 's', items: [
      { ref: a, action: 'update', title: 't', reason: 'r', ops: [{ op: 'write', ref: a, base: B(a), file: 'same.md' }] },
      { action: 'create', title: 't', reason: 'r', ops: [{ op: 'create', scope: 'global', file: 'dup.md' }] },
      { ref: a.replace('same', 'zzz'), action: 'keep', title: 't', reason: 'r', ops: [] },
    ] }, { 'same.md': raw(a), 'dup.md': memFile({ name: 'same', description: 'd', body: 'x' }) });
    await assert.rejects(createFromPlan(eg, file), (err) => /scope 看不懂/.test(err.message) && /完全相同/.test(err.message) && /已經存在/.test(err.message));
  });

  test('新的內容疑似含有金鑰時擋下', async () => {
    const a = await remember('api-notes', 'API 筆記', '金鑰放在認證管理員。');
    const file = writePlan({ scope: 'global', summary: 's', items: [{ ref: a, action: 'update', title: 't', reason: 'r', ops: [{ op: 'write', ref: a, base: B(a), file: 'a.md' }] }] }, {
      'a.md': memFile({ name: 'api-notes', description: 'API 筆記', body: 'token: ghp_1234567890abcdefghijABCDEFGHIJ123456' }),
    });
    await assert.rejects(createFromPlan(eg, file), /疑似含有金鑰/);
  });

  test('草稿資料夾裡的計畫與內容檔，建立成功後刪除', async () => {
    const a = await remember('draft-target', '草稿測試', '原本。');
    const dir = path.join(eg.paths.local, 'drafts', 'tidy-test');
    const file = writePlan({ scope: 'global', summary: 's', items: [{ ref: a, action: 'update', title: 't', reason: 'r', ops: [{ op: 'write', ref: a, base: B(a), file: 'a.md' }] }] }, {
      'a.md': memFile({ name: 'draft-target', description: '草稿測試', body: '改過。' }),
    }, dir);
    await createFromPlan(eg, file);
    assert.ok(!fs.existsSync(file) && !fs.existsSync(path.join(dir, 'a.md')));
    assert.ok(!fs.existsSync(dir), '清空的計畫資料夾一併移除');
    assert.ok(fs.existsSync(path.join(eg.paths.local, 'drafts')), '草稿資料夾本身保留');
  });

  test('核心準則：Engram 維護的區塊與全域索引那一行要保留', async () => {
    const cur = (await eg.core.read()).text;
    const broken = cur.replace(/<!-- engram:environments:begin -->[\s\S]*?<!-- engram:environments:end -->/, '').replace(/^@.*INDEX\.md$/m, '');
    const bad = writePlan({ scope: 'core', summary: 's', items: [{ ref: 'core/CORE.md', action: 'update', title: 't', reason: 'r', ops: [{ op: 'core', file: 'CORE.md' }] }] }, { 'CORE.md': broken });
    await assert.rejects(createFromPlan(eg, bad), (err) => /environments/.test(err.message) && /全域索引/.test(err.message));
    const good = writePlan({ scope: 'core', summary: 's', items: [{ ref: 'core/CORE.md', action: 'update', title: '精簡', reason: 'r', ops: [{ op: 'core', base: revOf(cur), file: 'CORE.md' }] }] }, { 'CORE.md': `${cur}\n- 新增一條規則。\n` });
    const rec = await createFromPlan(eg, good);
    assert.equal(rec.scope, 'core');
    assert.equal(rec.items[0].scope, 'core');
    assert.deepEqual(allowedDecisions(rec.items[0]), ['accept', 'keep', 'custom'], '核心準則不能封存');
    await deleteRecord(eg.paths.local, rec.id);
  });
});

describe('決定、執行與復原', () => {
  let rec;
  let refs;
  before(async () => {
    refs = {
      w: await remember('w-target', '要改寫', '舊內容。'),
      mv: await remember('mv-target', '要搬到專案', '只跟閘道有關。'),
      ar: await remember('ar-target', '要封存', '過時。'),
      kp: await remember('kp-target', '保留', '有效。'),
      cu: await remember('cu-target', '依備註', '原本。'),
      cf: await remember('cf-target', '會衝突', '原本。'),
    };
    const file = writePlan({
      scope: 'global',
      summary: '整理六筆',
      items: [
        { ref: refs.w, action: 'update', title: '改寫', reason: 'r', ops: [{ op: 'write', ref: refs.w, base: B(refs.w), file: 'w.md' }] },
        { ref: refs.mv, action: 'move', title: '搬到閘道專案', reason: 'r', ops: [{ op: 'create', scope: 'global', file: 'extract.md' }, { op: 'write', ref: refs.mv, base: B(refs.mv), file: 'mv.md' }, { op: 'move', ref: refs.mv, base: B(refs.mv), to: `project:${pid}` }] },
        { ref: refs.ar, action: 'keep', title: '保留', reason: 'r', ops: [] },
        { ref: refs.kp, action: 'archive', title: '封存', reason: 'r', ops: [{ op: 'remove', ref: refs.kp, base: B(refs.kp) }] },
        { ref: refs.cu, action: 'update', title: '改寫', reason: 'r', ops: [{ op: 'write', ref: refs.cu, base: B(refs.cu), file: 'cu.md' }] },
        { ref: refs.cf, action: 'update', title: '改寫', reason: 'r', ops: [{ op: 'write', ref: refs.cf, base: B(refs.cf), file: 'cf.md' }] },
      ],
    }, {
      'w.md': memFile({ name: 'w-target', description: '要改寫', body: '新內容。' }),
      'extract.md': memFile({ name: 'extracted-tip', description: '抽出的經驗', type: 'reference', body: '通用的部分。' }),
      'mv.md': memFile({ name: 'mv-target', description: '要搬到專案', body: '只跟閘道有關（修正連結）。' }),
      'cu.md': memFile({ name: 'cu-target', description: '依備註', body: '建議的內容。' }),
      'cf.md': memFile({ name: 'cf-target', description: '會衝突', body: '建議的內容。' }),
    });
    rec = await createFromPlan(eg, file);
  });

  test('還沒產生執行指令時不能執行', async () => {
    await assert.rejects(applyRecord(eg, rec.id), /還沒有產生執行指令/);
  });

  test('決定的檢查：不能選的決定、依備註調整沒有備註', async () => {
    await assert.rejects(setDecisions(eg.paths.local, rec.id, { i9: { decision: 'keep' } }), /找不到項目/);
    await assert.rejects(setDecisions(eg.paths.local, rec.id, { i3: { decision: 'accept' } }), /不能選/);
    await setDecisions(eg.paths.local, rec.id, { i1: { decision: 'accept' }, i2: { decision: 'accept' }, i3: { decision: 'archive' }, i5: { decision: 'custom' }, i6: { decision: 'accept' } });
    await assert.rejects(markReady(eg.paths.local, rec.id), /要寫備註/);
    await setDecisions(eg.paths.local, rec.id, { i5: { note: '說明改短一點' } });
    const r = await markReady(eg.paths.local, rec.id);
    assert.equal(r.command, `/engram:tidy-apply ${rec.id}`);
    const after = await readRecord(eg.paths.local, rec.id);
    assert.equal(after.status, 'ready');
    assert.equal(after.items[3].decision, 'keep', '沒有決定的項目當成維持原狀');
  });

  test('照核可的內容執行：先備份、每項記下結果與復原版本、衝突的項目不影響其他項', async () => {
    const before = { w: raw(refs.w), ar: raw(refs.ar), cf: raw(refs.cf) };
    fs.writeFileSync(vaultFile(refs.cf), `${raw(refs.cf)}\n另一台電腦改過。\n`); // 建議之後被改過
    const r = await applyRecord(eg, rec.id);
    const items = Object.fromEntries(r.record.items.map((it) => [it.id, it]));
    assert.equal(items.i1.result.status, 'done');
    assert.match(raw(refs.w), /新內容。/);
    assert.equal(items.i1.result.undo.length, 1);
    assert.equal(items.i2.result.status, 'done');
    assert.equal(items.i2.result.undo.length, 3);
    assert.ok(!fs.existsSync(vaultFile(refs.mv)));
    const moved = `projects/${pid}/memory/mv-target.md`;
    assert.match(raw(moved), /修正連結/);
    assert.deepEqual(items.i2.result.refs, ['global/extracted-tip.md', moved]);
    assert.match(raw('global/extracted-tip.md'), /通用的部分/);
    assert.equal(items.i3.result.status, 'done', '建議保留但使用者選封存');
    assert.ok(!fs.existsSync(vaultFile(refs.ar)));
    assert.equal(items.i4.result.status, 'kept');
    assert.ok(fs.existsSync(vaultFile(refs.kp)));
    assert.equal(items.i5.result.status, 'needs-claude');
    assert.equal(items.i6.result.status, 'failed');
    assert.equal(items.i6.result.error.code, 'E_CONFLICT');
    assert.equal(r.record.status, 'finishing');
    assert.deepEqual(r.needsClaude.map((it) => it.id), ['i5']);
    // 備份：動手前的內容與 SHA-256 清單
    const manifest = JSON.parse(fs.readFileSync(path.join(r.backup, 'manifest.json'), 'utf8'));
    assert.equal(fs.readFileSync(path.join(r.backup, 'vault', ...refs.w.split('/')), 'utf8'), before.w);
    assert.equal(fs.readFileSync(path.join(r.backup, 'vault', ...refs.ar.split('/')), 'utf8'), before.ar);
    assert.ok(manifest.files.some((f) => f.ref === refs.w && /^[0-9a-f]{64}$/.test(f.sha256)));
    assert.ok(!manifest.files.some((f) => f.ref === refs.kp), '維持原狀的項目不必備份');
    // 執行中或執行後不能再改決定，也不能再執行一次已完成的記錄
    await assert.rejects(setDecisions(eg.paths.local, rec.id, { i1: { decision: 'keep' } }), /已經執行過/);
  });

  test('Claude 記回依備註調整的結果後，記錄完成', async () => {
    await assert.rejects(recordResult(eg.paths.local, rec.id, 'i1', { status: 'done' }), /不是等 Claude 處理的狀態/);
    await assert.rejects(recordResult(eg.paths.local, rec.id, 'i5', { undo: ['not-a-sha'] }), /不合法的版本/);
    const w = await eg.memories.write(refs.cu, { text: memFile({ name: 'cu-target', description: '依備註', body: '短。' }) });
    const r = await recordResult(eg.paths.local, rec.id, 'i5', { undo: [w.undo.sha], message: '依備註改短' });
    assert.equal(r.status, 'done');
    const after = await readRecord(eg.paths.local, rec.id);
    assert.equal(after.items[4].result.by, 'claude');
    await assert.rejects(applyRecord(eg, rec.id), /已經執行完畢/);
  });

  test('整項復原：依相反順序 engram undo，回到執行前', async () => {
    const before = raw(refs.w);
    await undoItem(eg, rec.id, 'i1');
    assert.match(raw(refs.w), /舊內容。/);
    assert.notEqual(raw(refs.w), before);
    await undoItem(eg, rec.id, 'i2');
    assert.ok(fs.existsSync(vaultFile(refs.mv)), '搬走的記憶回到全域');
    assert.ok(!fs.existsSync(vaultFile('global/extracted-tip.md')), '新增的記憶移除');
    const after = await readRecord(eg.paths.local, rec.id);
    assert.equal(after.items[0].result.status, 'undone');
    await assert.rejects(undoItem(eg, rec.id, 'i1'), /沒有可以復原/);
  });
});

describe('中斷與清理', () => {
  test('執行中斷（程序已結束）後再執行，接著做沒有結果的項目', async () => {
    const a = await remember('resume-a', 'A', 'a。');
    const b = await remember('resume-b', 'B', 'b。');
    const file = writePlan({ scope: 'global', summary: 's', items: [
      { ref: a, action: 'archive', title: 't', reason: 'r', ops: [{ op: 'remove', ref: a, base: B(a) }] },
      { ref: b, action: 'archive', title: 't', reason: 'r', ops: [{ op: 'remove', ref: b, base: B(b) }] },
    ] });
    const rec = await createFromPlan(eg, file);
    await setDecisions(eg.paths.local, rec.id, { i1: { decision: 'accept' }, i2: { decision: 'accept' } });
    await markReady(eg.paths.local, rec.id);
    const stuck = await readRecord(eg.paths.local, rec.id);
    stuck.status = 'applying';
    stuck.applyingPid = 999999; // 不存在的程序
    stuck.items[0].result = { status: 'kept', at: new Date().toISOString() };
    await writeRecord(eg.paths.local, stuck);
    const r = await applyRecord(eg, rec.id);
    assert.equal(r.record.items[0].result.status, 'kept', '已有結果的項目不重做');
    assert.equal(r.record.items[1].result.status, 'done');
    assert.equal(r.record.status, 'done');
    assert.ok(fs.existsSync(vaultFile(a)));
  });

  test('刪除記錄；舊的記錄由每日維護清掉', async () => {
    const file = writePlan({ scope: 'global', summary: 's', items: [{ ref: await remember('prune-a', 'A', 'a。'), action: 'keep', title: 't', reason: 'r', ops: [] }] });
    const rec = await createFromPlan(eg, file);
    const old = await readRecord(eg.paths.local, rec.id);
    await writeRecord(eg.paths.local, old);
    const removed = await pruneRecords(eg.paths.local, { days: 90, now: Date.now() + 91 * 864e5 });
    assert.ok(removed >= 1);
    await assert.rejects(readRecord(eg.paths.local, rec.id), /找不到整理記錄/);
    await assert.rejects(readRecord(eg.paths.local, '../../etc/passwd'), /不是整理記錄的 id/);
  });
});

describe('第一輪審查的回歸測試（2026-10-24）', () => {
  const SECRET = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
  const ready = async (rec, decisions) => {
    await setDecisions(eg.paths.local, rec.id, decisions);
    await markReady(eg.paths.local, rec.id);
  };

  test('新增：整份核可的內容原樣寫入（frontmatter 的其他欄位不會被丟掉）', async () => {
    const content = '---\nname: kept-fields\ndescription: 保留欄位\nmetadata:\n  type: reference\n  originSessionId: s-123\n  engram:\n    pinned: true\ntags: [a, b]\n---\n\n內文。\n';
    const rec = await createFromPlan(eg, writePlan({ scope: 'global', summary: 's', items: [{ action: 'create', title: 't', reason: 'r', ops: [{ op: 'create', scope: 'global', file: 'k.md' }] }] }, { 'k.md': content }));
    await ready(rec, { i1: { decision: 'accept' } });
    const r = await applyRecord(eg, rec.id);
    assert.equal(r.record.items[0].result.status, 'done');
    assert.equal(raw('global/kept-fields.md'), content);
  });

  test('base 第一次處理一定要帶；搬移目的地已有同名、同一份計畫重複新增、釘選的記憶封存或合併掉都會擋下', async () => {
    const a = await remember('nb-a', 'A', 'a。');
    const dup = await remember('dupname', '全域的', 'x。');
    await remember('dupname', '專案的', 'y。', { kind: 'project', pid });
    const pin = await remember('pinned-one', '釘選', 'p。');
    await eg.memories.write(pin, { frontmatter: { 'metadata.engram.pinned': true } });
    const other = await remember('merge-other', '另一筆', 'o。');
    const file = writePlan({ scope: 'global', summary: 's', items: [
      { ref: a, action: 'archive', title: 't', reason: 'r', ops: [{ op: 'remove', ref: a }] },
      { ref: dup, action: 'move', title: 't', reason: 'r', ops: [{ op: 'move', ref: dup, base: B(dup), to: `project:${pid}` }] },
      { action: 'create', title: 't', reason: 'r', ops: [{ op: 'create', scope: 'global', file: 'n.md' }, { op: 'create', scope: 'global', file: 'n.md' }] },
      { ref: pin, action: 'archive', title: 't', reason: 'r', ops: [{ op: 'remove', ref: pin, base: B(pin) }] },
      { ref: other, action: 'merge', title: 't', reason: 'r', ops: [{ op: 'merge', refs: [other, pin], into: other, bases: [B(other), B(pin)], file: 'm.md' }] },
    ] }, { 'n.md': memFile({ name: 'twice', description: 'd', body: 'x' }), 'm.md': memFile({ name: 'merge-other', description: 'd', body: 'm' }) });
    await assert.rejects(createFromPlan(eg, file), (err) => {
      for (const re of [/缺少 global\/nb-a\.md 的 base/, /已經有同名的 dupname\.md/, /名稱重複/, /釘選的記憶，不要建議封存/, /釘選的記憶，不要建議合併掉/]) assert.match(err.message, re);
      return true;
    });
  });

  test('合併：半截 frontmatter、name 與目標不符、新的疑似金鑰都會擋下', async () => {
    const x = await remember('mx', 'X', 'x。');
    const y = await remember('my', 'Y', 'y。');
    const plan = (file) => ({ scope: 'global', summary: 's', items: [{ ref: x, action: 'merge', title: 't', reason: 'r', ops: [{ op: 'merge', refs: [x, y], into: x, bases: [B(x), B(y)], file }] }] });
    await assert.rejects(createFromPlan(eg, writePlan(plan('h.md'), { 'h.md': '---\nname: mx\ndescription: d\n\n內文' })), /frontmatter/);
    await assert.rejects(createFromPlan(eg, writePlan(plan('w.md'), { 'w.md': memFile({ name: 'other-name', description: 'd', body: 'b' }) })), /name（other-name）/);
    await assert.rejects(createFromPlan(eg, writePlan(plan('s.md'), { 's.md': memFile({ name: 'mx', description: 'd', body: `token ${SECRET}` }) })), /疑似含有金鑰/);
  });

  test('記錄裡的說明遮蔽疑似金鑰', async () => {
    const ref = 'global/desc-secret.md';
    fs.writeFileSync(vaultFile(ref), `---\nname: desc-secret\ndescription: 權杖 ${SECRET}\nmetadata:\n  type: reference\n---\n\n內文\n`);
    const rec = await createFromPlan(eg, writePlan({ scope: 'global', summary: 's', items: [{ ref, action: 'keep', title: 't', reason: 'r', ops: [] }] }));
    assert.ok(!JSON.stringify(rec).includes(SECRET));
    fs.rmSync(vaultFile(ref));
    await deleteRecord(eg.paths.local, rec.id);
  });

  test('一項是全有全無：後面步驟的前提不成立時，前面的步驟也不做', async () => {
    const a = await remember('atomic-a', 'A', 'a。');
    const rec = await createFromPlan(eg, writePlan({ scope: 'global', summary: 's', items: [{ ref: a, action: 'split', title: 't', reason: 'r', ops: [
      { op: 'create', scope: 'global', file: 'x.md' },
      { op: 'write', ref: a, base: B(a), file: 'a.md' },
    ] }] }, { 'x.md': memFile({ name: 'atomic-x', description: 'x', body: 'x' }), 'a.md': memFile({ name: 'atomic-a', description: 'A', body: '改過。' }) }));
    await ready(rec, { i1: { decision: 'accept' } });
    fs.appendFileSync(vaultFile(a), '另一台電腦改過。\n');
    const r = await applyRecord(eg, rec.id);
    assert.equal(r.record.items[0].result.status, 'failed');
    assert.ok(!fs.existsSync(vaultFile('global/atomic-x.md')), '前面的新增沒有做');
    assert.deepEqual(r.record.items[0].result.undo, []);
  });

  test('中斷在一項的中間（第一步已 commit、還沒記下）：續做時認得已完成的那一步、找回版本，接著做下一步', async () => {
    const a = await remember('resume-mid', 'A', 'a。');
    const xText = memFile({ name: 'resume-new', description: 'x', body: 'x' });
    const rec = await createFromPlan(eg, writePlan({ scope: 'global', summary: 's', items: [{ ref: a, action: 'split', title: 't', reason: 'r', ops: [
      { op: 'create', scope: 'global', file: 'x.md' },
      { op: 'write', ref: a, base: B(a), file: 'a.md' },
    ] }] }, { 'x.md': xText, 'a.md': memFile({ name: 'resume-mid', description: 'A', body: '改過。' }) }));
    await ready(rec, { i1: { decision: 'accept' } });
    // 模擬：程序開始這一項、做完第一步就被關掉
    const startedAt = new Date(Date.now() - 3000).toISOString();
    const created = await eg.memories.create({ scope: { kind: 'global' }, name: 'resume-new', type: 'feedback', description: 'x', body: 'x', text: xText });
    const stuck = await readRecord(eg.paths.local, rec.id);
    Object.assign(stuck, { status: 'applying', applyingPid: 999999, applyingSince: new Date().toISOString() });
    stuck.items[0].progress = { done: 0, undo: [], refs: [], startedAt };
    await writeRecord(eg.paths.local, stuck);
    const r = await applyRecord(eg, rec.id);
    const res = r.record.items[0].result;
    assert.equal(res.status, 'done', JSON.stringify(res));
    assert.equal(res.undo.length, 2);
    assert.ok(created.undo.sha.startsWith(res.undo[0]) || res.undo[0].startsWith(created.undo.sha.slice(0, 7)), '找回第一步的版本');
    assert.match(raw(a), /改過。/);
    assert.equal(r.record.items[0].progress, undefined, '完成後不留進度');
    await undoItem(eg, rec.id, 'i1');
    assert.ok(!fs.existsSync(vaultFile('global/resume-new.md')) && /a。/.test(raw(a)), '整項復原包含續做前的那一步');
  });

  test('已產生執行指令後改成未決定或「依備註調整」沒有備註：退回待決定；執行前也會檢查', async () => {
    const a = await remember('demote-a', 'A', 'a。');
    const rec = await createFromPlan(eg, writePlan({ scope: 'global', summary: 's', items: [{ ref: a, action: 'keep', title: 't', reason: 'r', ops: [] }] }));
    await ready(rec, { i1: { decision: 'keep' } });
    await setDecisions(eg.paths.local, rec.id, { i1: { decision: 'custom' } });
    assert.equal((await readRecord(eg.paths.local, rec.id)).status, 'pending');
    await assert.rejects(applyRecord(eg, rec.id), /還沒有產生執行指令/);
    await setDecisions(eg.paths.local, rec.id, { i1: { note: '改短' } });
    await markReady(eg.paths.local, rec.id);
    await setDecisions(eg.paths.local, rec.id, { i1: { decision: null } });
    assert.equal((await readRecord(eg.paths.local, rec.id)).status, 'pending');
    // 舊記錄（或手動改過的檔案）在 ready 卻缺備註：apply 擋下
    const bad = await readRecord(eg.paths.local, rec.id);
    Object.assign(bad, { status: 'ready' });
    bad.items[0].decision = 'custom';
    bad.items[0].note = '';
    await writeRecord(eg.paths.local, bad);
    await assert.rejects(applyRecord(eg, rec.id), /沒有備註/);
  });

  test('執行中的記錄不能刪；執行中超過 2 小時視為中斷，可以刪也可以續做', async () => {
    const a = await remember('busy-a', 'A', 'a。');
    const rec = await createFromPlan(eg, writePlan({ scope: 'global', summary: 's', items: [{ ref: a, action: 'keep', title: 't', reason: 'r', ops: [] }] }));
    const r = await readRecord(eg.paths.local, rec.id);
    Object.assign(r, { status: 'applying', applyingPid: process.ppid, applyingSince: new Date().toISOString() });
    await writeRecord(eg.paths.local, r);
    assert.equal(applyingNow(r), true);
    await assert.rejects(deleteRecord(eg.paths.local, rec.id), /正在執行中/);
    r.applyingSince = new Date(Date.now() - 3 * 3600_000).toISOString();
    await writeRecord(eg.paths.local, r);
    assert.equal(applyingNow(r), false);
    assert.deepEqual(await deleteRecord(eg.paths.local, rec.id), { ok: true });
  });
});

describe('第二輪審查的回歸測試（2026-10-24）', () => {
  const ready = async (rec, decisions) => {
    await setDecisions(eg.paths.local, rec.id, decisions);
    await markReady(eg.paths.local, rec.id);
  };

  test('續做時，記憶是被別人刪掉的（變更紀錄裡沒有這一項開始後自己做的 commit）：不當成已完成', async () => {
    const a = await remember('gone-elsewhere', 'A', 'a。');
    const rec = await createFromPlan(eg, writePlan({ scope: 'global', summary: 's', items: [{ ref: a, action: 'archive', title: 't', reason: 'r', ops: [{ op: 'remove', ref: a, base: B(a) }] }] }));
    await ready(rec, { i1: { decision: 'accept' } });
    const stuck = await readRecord(eg.paths.local, rec.id);
    Object.assign(stuck, { status: 'applying', applyingPid: 999999, applyingSince: new Date().toISOString() });
    stuck.items[0].progress = { done: 0, undo: [], refs: [], startedAt: new Date().toISOString() };
    await writeRecord(eg.paths.local, stuck);
    fs.rmSync(vaultFile(a)); // 不經過 Engram 刪掉（沒有 remove commit）
    const r = await applyRecord(eg, rec.id);
    assert.equal(r.record.items[0].result.status, 'failed');
    assert.deepEqual(r.record.items[0].result.undo, [], '不可以把別人的 commit 當成這一項的復原版本');
  });

  test('執行到一半的項目，介面不顯示「建議之後被改過」', async () => {
    const a = await remember('mid-view', 'A', 'a。');
    const rec = await createFromPlan(eg, writePlan({ scope: 'global', summary: 's', items: [{ ref: a, action: 'update', title: 't', reason: 'r', ops: [{ op: 'write', ref: a, base: B(a), file: 'a.md' }] }] }, { 'a.md': memFile({ name: 'mid-view', description: 'A', body: '改過。' }) }));
    await eg.memories.write(a, { text: memFile({ name: 'mid-view', description: 'A', body: '改過。' }) });
    const r = await readRecord(eg.paths.local, rec.id);
    r.items[0].progress = { done: 1, undo: [], refs: [], startedAt: new Date().toISOString() };
    await writeRecord(eg.paths.local, r);
    assert.deepEqual((await recordView(eg, rec.id)).items[0].changed, []);
    delete r.items[0].progress;
    await writeRecord(eg.paths.local, r);
    assert.deepEqual((await recordView(eg, rec.id)).items[0].changed, [a], '沒有進度時照常提醒');
  });

  test('釘選的記憶改寫或合併時要保留釘選', async () => {
    const pin = await remember('pin-keep', '釘選', 'p。');
    await eg.memories.write(pin, { frontmatter: { 'metadata.engram.pinned': true } });
    const other = await remember('pin-other', '另一筆', 'o。');
    await assert.rejects(createFromPlan(eg, writePlan({ scope: 'global', summary: 's', items: [{ ref: pin, action: 'update', title: 't', reason: 'r', ops: [{ op: 'write', ref: pin, base: B(pin), file: 'p.md' }] }] }, { 'p.md': memFile({ name: 'pin-keep', description: '釘選', body: '改過。' }) })), /改寫時要保留 metadata\.engram\.pinned/);
    await assert.rejects(createFromPlan(eg, writePlan({ scope: 'global', summary: 's', items: [{ ref: pin, action: 'merge', title: 't', reason: 'r', ops: [{ op: 'merge', refs: [pin, other], into: pin, bases: [B(pin), B(other)], file: 'm.md' }] }] }, { 'm.md': memFile({ name: 'pin-keep', description: '釘選', body: '合併。' }) })), /合併後的內容要保留 metadata\.engram\.pinned/);
  });

  test('引擎：整份內容新增時，同名檔剛好出現就不寫入（不改名成 -2）', async () => {
    await remember('race-x', 'X', 'x。');
    await assert.rejects(eg.memories.create({ scope: { kind: 'global' }, name: 'race-x', type: 'feedback', description: 'd', body: 'b', text: memFile({ name: 'race-x', description: 'd', body: 'b' }) }), (err) => err.code === 'E_CONFLICT');
    assert.ok(!fs.existsSync(vaultFile('global/race-x-2.md')));
  });
});

describe('第三輪審查的回歸測試（2026-10-24）', () => {
  test('續做：搬移、封存、合併已 commit、還沒記下進度時，認得是自己做的並找回版本', async () => {
    const mv = await remember('resume-mv', 'M', 'm。');
    const rm = await remember('resume-rm', 'R', 'r。');
    const p = await remember('resume-p', 'P', 'p。');
    const q = await remember('resume-q', 'Q', 'q。');
    const merged = memFile({ name: 'resume-p', description: 'P', body: 'p 與 q。' });
    const rec = await createFromPlan(eg, writePlan({ scope: 'global', summary: 's', items: [
      { ref: mv, action: 'move', title: 't', reason: 'r', ops: [{ op: 'move', ref: mv, base: B(mv), to: `project:${pid}` }] },
      { ref: rm, action: 'archive', title: 't', reason: 'r', ops: [{ op: 'remove', ref: rm, base: B(rm) }] },
      { ref: p, action: 'merge', title: 't', reason: 'r', ops: [{ op: 'merge', refs: [p, q], into: p, bases: [B(p), B(q)], file: 'm.md' }] },
    ] }, { 'm.md': merged }));
    await setDecisions(eg.paths.local, rec.id, { i1: { decision: 'accept' }, i2: { decision: 'accept' }, i3: { decision: 'accept' } });
    await markReady(eg.paths.local, rec.id);
    const startedAt = new Date(Date.now() - 3000).toISOString();
    // 模擬：三項都做完 commit、程序在記下結果前被關掉
    const s1 = (await eg.memories.move(mv, { kind: 'project', pid })).undo.sha;
    const s2 = (await eg.memories.remove(rm)).undo.sha;
    const s3 = (await eg.memories.merge([p, q], { into: p, text: merged })).undo.sha;
    const stuck = await readRecord(eg.paths.local, rec.id);
    Object.assign(stuck, { status: 'applying', applyingPid: 999999, applyingSince: new Date().toISOString() });
    for (const it of stuck.items) it.progress = { done: 0, undo: [], refs: [], startedAt };
    await writeRecord(eg.paths.local, stuck);
    const r = await applyRecord(eg, rec.id);
    const [a, b, c] = r.record.items.map((it) => it.result);
    assert.equal(a.status, 'done', JSON.stringify(a));
    assert.ok(s1.startsWith(a.undo[0]));
    assert.deepEqual(a.refs, [`projects/${pid}/memory/resume-mv.md`]);
    assert.equal(b.status, 'done', JSON.stringify(b));
    assert.ok(s2.startsWith(b.undo[0]));
    assert.equal(c.status, 'done', JSON.stringify(c));
    assert.ok(s3.startsWith(c.undo[0]));
    assert.equal(r.record.status, 'done');
  });

  test('引擎：名稱沒有英數時，整份內容新增照樣建立（不會誤報同名）', async () => {
    const r = await eg.memories.create({ scope: { kind: 'global' }, name: '記憶', type: 'feedback', description: 'd', body: 'b', text: memFile({ name: 'x', description: 'd', body: 'b' }) });
    assert.match(r.ref, /^global\/memory-[0-9a-z]{6}\.md$/);
  });
});
