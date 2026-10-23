// 引擎整合測試：初始化、記憶 CRUD、索引、綁定（junction 與設定檔備援）、SessionStart、健康檢查、復原。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open, E } from '../../src/core/index.mjs';
import { encodeProjectPath } from '../../src/core/paths.mjs';
import { isLink, linkTarget, sha1 } from '../../src/core/fsx.mjs';
import { addTranscript, age, ageTree, machinePaths, makeRepo, memoryText, mkTmp, rmTmp, writeDriverCli, git } from './helpers.mjs';

let root;
let m;
let cli;
let eg;

before(async () => {
  root = mkTmp();
  cli = writeDriverCli(root);
  m = machinePaths(root, 'office');
  await init({ ...m, machineLabel: '公司電腦', userName: 'Tester', cli });
  eg = await open(m);
});
after(() => rmTmp(root));

/** 模擬 Claude Code 直接寫進記憶資料夾的檔案：含金鑰的記憶只會從這裡進來（引擎的寫入 API 會拒絕） */
function plant(ref, text) {
  const p = path.join(eg.paths.vault, ...ref.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return { ref };
}

describe('初始化', () => {
  test('open() 在尚未初始化時丟 E_NOT_FOUND', async () => {
    const other = machinePaths(root, 'nobody');
    await assert.rejects(open(other), (e) => e.code === E.NOT_FOUND);
  });

  test('建立 vault 骨架、CORE.md、本機登記與首次 commit', async () => {
    const v = eg.paths.vault;
    for (const p of ['engram.json', '.gitattributes', 'core/CORE.md', 'global', 'projects', 'conflicts', `machines/${eg.machine.id}/machine.json`, `machines/${eg.machine.id}/bindings.json`]) {
      assert.ok(fs.existsSync(path.join(v, p)), `缺少 ${p}`);
    }
    const core = fs.readFileSync(path.join(v, 'core', 'CORE.md'), 'utf8');
    assert.match(core, /核心準則（Tester）/);
    assert.doesNotMatch(core, /\{\{/, 'CORE.md 不應殘留佔位符');
    assert.match(core, /公司電腦（/, '電腦清單應寫入 environments 區塊');
    assert.match(core, /@\.\.\/global\/INDEX\.md/);
    const log = git(v, 'log', '--format=%s');
    assert.match(log, /建立 vault/);
    const attrs = fs.readFileSync(path.join(v, '.gitattributes'), 'utf8');
    assert.match(attrs, /merge=engram-md/);
    assert.match(git(v, 'config', '--get', 'merge.engram-md.driver'), /merge-driver %O %A %B %P/);
  });

  test('重複 init 不覆寫既有檔案', async () => {
    const corePath = path.join(eg.paths.vault, 'core', 'CORE.md');
    const before = fs.readFileSync(corePath, 'utf8');
    await init({ ...m, machineLabel: '公司電腦', cli });
    assert.equal(fs.readFileSync(corePath, 'utf8'), before);
  });

  test('claudeMdBlock 產生附加用的管理區塊', async () => {
    const block = await eg.claudeMdBlock();
    assert.match(block, /^<!-- engram:begin/);
    assert.match(block, /@~\/\.engram\/vault\/core\/CORE\.md/);
    assert.match(block, new RegExp(`machines/${eg.machine.id}/INDEX\\.md`));
    assert.match(block, /<!-- engram:end -->\n$/);
  });
});

describe('記憶 CRUD 與索引', () => {
  test('remember 全域記憶：寫檔、重建 INDEX.md、commit 附 trailer', async () => {
    const r = await eg.memories.create({ scope: { kind: 'global' }, name: 'powershell-bom', type: 'feedback', description: '含中文的 .ps1 要加 UTF-8 BOM', body: '寫 .ps1 時加 BOM。' });
    assert.equal(r.ok, true);
    assert.equal(r.ref, 'global/powershell-bom.md');
    const idx = fs.readFileSync(path.join(eg.paths.vault, 'global', 'INDEX.md'), 'utf8');
    assert.match(idx, /\[powershell-bom\]\(~\/\.engram\/vault\/global\/powershell-bom\.md\) — 含中文的 \.ps1 要加 UTF-8 BOM/);
    assert.doesNotMatch(idx, /\d{4}-\d{2}-\d{2}T/, 'INDEX.md 不含時間戳記（R-13）');
    const body = git(eg.paths.vault, 'log', '-1', '--format=%B');
    assert.match(body, /Engram-Action: create/);
    assert.match(body, /Engram-Refs: global\/powershell-bom\.md/);
  });

  test('INDEX.md 重建冪等：連續兩次內容一字不差', async () => {
    const p = path.join(eg.paths.vault, 'global', 'INDEX.md');
    const a = sha1(fs.readFileSync(p, 'utf8'));
    await eg.normalize();
    await eg.normalize();
    assert.equal(sha1(fs.readFileSync(p, 'utf8')), a);
  });

  test('單機記憶寫到 machines/<mid>/，同名自動加 -2', async () => {
    const a = await eg.memories.create({ scope: { kind: 'machine' }, name: 'disk layout', type: 'reference', description: 'D 槽是資料碟', body: 'D:\\data' });
    const b = await eg.memories.create({ scope: { kind: 'machine' }, name: 'disk layout', type: 'reference', description: '另一筆', body: 'x' });
    assert.equal(a.ref, `machines/${eg.machine.id}/disk-layout.md`);
    assert.equal(b.ref, `machines/${eg.machine.id}/disk-layout-2.md`);
  });

  test('list、read、search（中文兩字詞）', async () => {
    const list = await eg.memories.list({ scope: 'global' });
    assert.equal(list.length, 1);
    assert.equal(list[0].type, 'feedback');
    const mem = await eg.memories.read('global/powershell-bom.md');
    assert.match(mem.body, /加 BOM/);
    const hits = await eg.search('中文');
    assert.ok(hits.some((h) => h.ref === 'global/powershell-bom.md'));
  });

  test('write 精準修改 frontmatter 與內文，其他行不變', async () => {
    const ref = 'global/powershell-bom.md';
    await eg.memories.write(ref, { frontmatter: { 'metadata.engram.pinned': true } });
    const t = fs.readFileSync(path.join(eg.paths.vault, ref), 'utf8');
    assert.match(t, /engram:\n\s+pinned: true/);
    assert.match(t, /description: 含中文的 \.ps1 要加 UTF-8 BOM|description: "含中文的 \.ps1 要加 UTF-8 BOM"/);
    await eg.memories.write(ref, { body: '新內文。\n' });
    assert.match(fs.readFileSync(path.join(eg.paths.vault, ref), 'utf8'), /---\n\n?新內文。\n$/);
  });

  test('move、remove、restore、undo 都是可追溯的 commit', async () => {
    const created = await eg.memories.create({ scope: { kind: 'global' }, name: 'temp-note', type: 'reference', description: '暫存', body: 'a' });
    const moved = await eg.memories.move(created.ref, { kind: 'machine' });
    assert.equal(moved.ref, `machines/${eg.machine.id}/temp-note.md`);
    await eg.memories.remove(moved.ref);
    assert.equal(fs.existsSync(path.join(eg.paths.vault, moved.ref)), false);
    await eg.memories.restore(moved.ref);
    assert.equal(fs.existsSync(path.join(eg.paths.vault, moved.ref)), true);
    const h = await eg.history({ limit: 5 });
    assert.equal(h[0].action, 'restore');
    assert.ok(h[0].undoable);
    await eg.undo(h[0].sha);
    assert.equal(fs.existsSync(path.join(eg.paths.vault, moved.ref)), false);
  });

  test('merge：只給內文（介面的合併對話框）時沿用目標的 frontmatter；給整份內容時照用', async () => {
    const a = await eg.memories.create({ scope: { kind: 'global' }, name: 'merge-a', type: 'feedback', description: '合併測試 A', body: 'A 的內容' });
    const b = await eg.memories.create({ scope: { kind: 'global' }, name: 'merge-b', type: 'feedback', description: '合併測試 B', body: 'B 的內容' });
    await eg.memories.merge([a.ref, b.ref], { into: a.ref, body: '## merge-a\n\nA 與 B 合併後的內容\n' });
    const t = fs.readFileSync(path.join(eg.paths.vault, a.ref), 'utf8');
    assert.match(t, /^---\nname: merge-a\n/);
    assert.match(t, /description: 合併測試 A|description: "合併測試 A"/);
    assert.match(t, /type: feedback/);
    assert.match(t, /supersedes:\n\s+- global\/merge-b\.md/);
    assert.match(t, /---\n\n?## merge-a\n\nA 與 B 合併後的內容\n$/);
    assert.equal(fs.existsSync(path.join(eg.paths.vault, b.ref)), false);
    const mem = await eg.memories.read(a.ref);
    assert.equal(mem.frontmatter.description, '合併測試 A');

    const c = await eg.memories.create({ scope: { kind: 'global' }, name: 'merge-c', type: 'user', description: '合併測試 C', body: 'C' });
    await eg.memories.merge([a.ref, c.ref], { into: c.ref, text: memoryText({ name: 'merge-c', description: '合併後的新說明', type: 'user', body: 'A、B、C 全部' }) });
    const m2 = await eg.memories.read(c.ref);
    assert.equal(m2.frontmatter.description, '合併後的新說明');
    assert.deepEqual(m2.frontmatter.metadata.engram.supersedes, [a.ref]);
    assert.match(m2.body, /A、B、C 全部/);
    assert.equal(fs.existsSync(path.join(eg.paths.vault, a.ref)), false);
  });

  test('merge：目標不存在又沒有 frontmatter 時拒絕，不寫任何檔案', async () => {
    const a = await eg.memories.create({ scope: { kind: 'global' }, name: 'merge-x', type: 'user', description: 'X', body: 'X' });
    const b = await eg.memories.create({ scope: { kind: 'global' }, name: 'merge-y', type: 'user', description: 'Y', body: 'Y' });
    await assert.rejects(eg.memories.merge([a.ref, b.ref], { into: 'global/merge-new.md', body: '只有內文' }), (e) => e.code === E.INVALID);
    assert.equal(fs.existsSync(path.join(eg.paths.vault, 'global/merge-new.md')), false);
    assert.equal(fs.existsSync(path.join(eg.paths.vault, a.ref)), true);
    assert.equal(fs.existsSync(path.join(eg.paths.vault, b.ref)), true);
  });

  test('M5：search 的摘要與說明先遮蔽疑似金鑰（金鑰落在摘要邊界也一樣）', async () => {
    const token = `ghp_${'Qw3Er5Ty7U'.repeat(4)}`;
    plant('global/ci-token-note.md', memoryText({ name: 'ci-token-note', type: 'reference', description: `CI 權杖 ${token}`, body: `CI 用的權杖：${token}\n存在認證管理員。` }));
    // 關鍵字之後剛好 80 個字元處開始是金鑰：先截摘要再遮蔽的話，被截斷的金鑰偵測不到
    plant('global/edge-token-note.md', memoryText({ name: 'edge-token-note', type: 'reference', description: '邊界測試', body: `邊界關鍵字${'甲'.repeat(75)}${token} 之後的文字` }));
    for (const q of ['權杖', '邊界關鍵字', 'ghp']) {
      const hits = await eg.search(q, { limit: 10 });
      assert.ok(hits.length > 0, `「${q}」應該有結果`);
      for (const h of hits) {
        assert.ok(!JSON.stringify(h).includes(token.slice(0, 12)), `search 結果不可以帶出金鑰（${q}）：${JSON.stringify(h)}`);
      }
    }
    assert.match((await eg.search('權杖', { limit: 10 })).find((h) => h.name === 'ci-token-note').snippet, /‹已遮蔽：github-token›/);
    // 說明含金鑰會讓全域 INDEX.md 也被扣住不提交；清掉，免得影響後面共用同一個 vault 的測試
    fs.rmSync(path.join(eg.paths.vault, 'global', 'ci-token-note.md'));
    fs.rmSync(path.join(eg.paths.vault, 'global', 'edge-token-note.md'));
  });

  test('M5：寫入 API 不把疑似金鑰帶進記憶庫；使用者確認不是金鑰（allowSecrets）才寫入並 commit', async () => {
    const token = `ghp_${'Mn4Bv6Cx8Z'.repeat(4)}`;
    const inHistory = () => git(eg.paths.vault, 'log', '--all', '-p').includes(token);
    await assert.rejects(eg.memories.create({ scope: { kind: 'global' }, name: 'held-token', type: 'reference', description: '測試', body: `權杖：${token}` }), (e) => e.code === E.SECRET);
    assert.equal(fs.existsSync(path.join(eg.paths.vault, 'global/held-token.md')), false, '被拒絕時不留下檔案');
    const plain = await eg.memories.create({ scope: { kind: 'global' }, name: 'plain-note', type: 'reference', description: '測試', body: '沒有金鑰' });
    await assert.rejects(eg.memories.write(plain.ref, { body: `改成含金鑰：${token}\n` }), (e) => e.code === E.SECRET);
    assert.match(fs.readFileSync(path.join(eg.paths.vault, plain.ref), 'utf8'), /沒有金鑰/, '被拒絕時檔案不動');
    await assert.rejects(eg.core.write(`${(await eg.core.read()).text}\ntoken: ${token}\n`), (e) => e.code === E.SECRET);
    assert.equal(inHistory(), false);
    // 使用者確認不是金鑰：記入「不是金鑰」清單（存雜湊），照常寫入並 commit
    const ok = await eg.memories.create({ scope: { kind: 'global' }, name: 'sample-token', type: 'reference', description: '文件裡的範例字串', body: `範例：${token}`, allowSecrets: true });
    assert.match(git(eg.paths.vault, 'show', `HEAD:${ok.ref}`), new RegExp(token));
    // 清單在 vault/not-secrets/<雜湊>（會同步到其他電腦），而且和這筆記憶在同一個 commit
    const { secretHash } = await import('../../src/core/secrets.mjs');
    const allowRef = `not-secrets/${secretHash(token)}`;
    assert.ok(!fs.readFileSync(path.join(eg.paths.vault, ...allowRef.split('/')), 'utf8').includes(token), '清單只存雜湊與預覽，不存值');
    assert.match(git(eg.paths.vault, 'show', '--name-only', '--format=', 'HEAD'), new RegExp(allowRef));
    // 不分檔案：搬到單機、合併到別筆都還認得（審查 N1）
    const moved = await eg.memories.move(ok.ref, { kind: 'machine' });
    assert.match(git(eg.paths.vault, 'show', `HEAD:${moved.ref}`), new RegExp(token), '新位置照常 commit，不會只提交一半');
    await eg.memories.remove(moved.ref);
    await eg.memories.remove(plain.ref);
  });

  test('M5：被扣住（含金鑰、從沒進 git）的記憶不能封存、移動或合併，避免永久遺失或只提交一半', async () => {
    const token = `ghp_${'Lk9Jh7Gf5D'.repeat(4)}`;
    const held = plant('global/held-note.md', memoryText({ name: 'held-note', description: '被扣住的記憶', type: 'reference', body: `權杖：${token}` }));
    const other = await eg.memories.create({ scope: { kind: 'global' }, name: 'held-other', type: 'reference', description: '另一筆', body: '沒有金鑰' });
    await assert.rejects(eg.memories.remove(held.ref), (e) => e.code === E.SECRET && /先在收件匣遮蔽金鑰/.test(e.hint));
    await assert.rejects(eg.memories.move(held.ref, { kind: 'machine' }), (e) => e.code === E.SECRET);
    await assert.rejects(eg.memories.merge([other.ref, held.ref], { into: other.ref, text: '合併' }), (e) => e.code === E.SECRET);
    await assert.rejects(eg.memories.merge([other.ref, held.ref], { into: held.ref, text: '合併' }), (e) => e.code === E.SECRET);
    assert.ok(fs.readFileSync(path.join(eg.paths.vault, held.ref), 'utf8').includes(token), '被扣住的檔案不動');
    assert.ok(fs.existsSync(path.join(eg.paths.vault, other.ref)));
    // 合併後的內容含金鑰 → 拒絕，其他筆都不刪
    const third = await eg.memories.create({ scope: { kind: 'global' }, name: 'held-third', type: 'reference', description: '第三筆', body: '沒有金鑰' });
    await assert.rejects(eg.memories.merge([other.ref, third.ref], { into: other.ref, text: `合併：${token}` }), (e) => e.code === E.SECRET);
    assert.ok(fs.existsSync(path.join(eg.paths.vault, third.ref)));
    // 已經含金鑰的記憶，編輯其他地方仍然可以（不算新增金鑰），檔案照樣扣住
    await eg.memories.write(held.ref, { text: fs.readFileSync(path.join(eg.paths.vault, held.ref), 'utf8').replace('被扣住的記憶', '被扣住的記憶（改過說明）') });
    assert.equal(git(eg.paths.vault, 'log', '--all', '-p').includes(token), false);
    // 遮蔽之後就可以封存
    await eg.secrets.redact(held.ref);
    await eg.memories.remove(held.ref);
    await eg.memories.remove(other.ref);
    await eg.memories.remove(third.ref);
  });

  test('審查 N7：已經在歷史裡的含金鑰檔案（例如偵測規則更新前就 commit 的）可以封存與合併（找得回來）；移動仍然拒絕', async () => {
    const token = `ghp_${'Hs7Tr5Yi3U'.repeat(4)}`;
    const ref = plant('global/old-flagged.md', memoryText({ name: 'old-flagged', description: '規則更新前就同步的', type: 'reference', body: `舊內容：${token}` })).ref;
    git(eg.paths.vault, 'add', ref);
    git(eg.paths.vault, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'legacy commit');
    await assert.rejects(eg.memories.move(ref, { kind: 'machine' }), (e) => e.code === E.SECRET && /不會同步/.test(e.message));
    await eg.memories.remove(ref);
    assert.equal(fs.existsSync(path.join(eg.paths.vault, ref)), false);
    await eg.memories.restore(ref);
    assert.ok(fs.readFileSync(path.join(eg.paths.vault, ref), 'utf8').includes(token), '從歷史還原');
    // 工作目錄改過、和 HEAD 不同時（新內容沒進過歷史）仍然拒絕封存
    fs.appendFileSync(path.join(eg.paths.vault, ref), '新加的一行\n');
    await assert.rejects(eg.memories.remove(ref), (e) => e.code === E.SECRET && /還沒進同步歷史/.test(e.message));
    fs.rmSync(path.join(eg.paths.vault, ref));
  });

  test('M2：「不是金鑰」只放行標記的那一組值；同一檔前綴與長度相同的另一組仍然當成金鑰', async () => {
    const a = `ghp_${'Aa1Bb2Cc3D'.repeat(4)}`;
    const b = `ghp_${'Zz9Yy8Xx7W'.repeat(4)}`;
    const ref = plant('global/two-tokens.md', memoryText({ name: 'two-tokens', description: '兩組權杖', type: 'reference', body: `舊的（已撤銷）：${a}` })).ref;
    const line = (await eg.memories.read(ref)).secretRanges[0].line;
    await eg.secrets.allow(ref, line);
    assert.equal((await eg.secrets.preview(ref)).matches.length, 0);
    fs.appendFileSync(path.join(eg.paths.vault, ref), `新的：${b}\n`);
    const p = await eg.secrets.preview(ref);
    assert.equal(p.matches.length, 1, '新的那組要被偵測到');
    assert.ok(p.after.includes(a) && !p.after.includes(b));
    assert.ok((await eg.health()).some((f) => f.code === 'H13' && f.refs.includes(ref)));
    fs.rmSync(path.join(eg.paths.vault, ref));
  });

  test('activity 統計每日變化', async () => {
    const days = await eg.activity({ days: 3 });
    assert.equal(days.length, 3);
    const today = days[days.length - 1];
    assert.ok(today.added >= 1);
  });
});

describe('綁定與 SessionStart', () => {
  test('git 專案：有內容的記憶資料夾 → 安全切換成 junction，原資料夾備份', async () => {
    const repo = makeRepo(path.join(root, 'work', 'gateway'), { remote: 'git@github.com:Example-Org/Demo-Gateway.git' });
    const t = addTranscript(m.claudeHome, repo);
    const memDir = path.join(t.dir, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'deploy-notes.md'), memoryText({ name: 'deploy-notes', description: '部署方式' }));
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- [部署筆記](deploy-notes.md) — Claude 寫的提示語\n');
    const r = await eg.identity.bind(repo, { create: { name: '示範閘道' } });
    assert.equal(r.method, 'junction');
    assert.equal(r.state, 'active');
    assert.ok(isLink(memDir), '記憶資料夾應變成 junction');
    const target = linkTarget(memDir);
    assert.ok(target.startsWith(eg.paths.vault));
    const idx = fs.readFileSync(path.join(target, 'MEMORY.md'), 'utf8');
    assert.match(idx, /Claude 寫的提示語/, '保留 Claude 原本寫的索引行');
    assert.ok(r.backup && fs.existsSync(path.join(r.backup, 'deploy-notes.md')), '原資料夾完整備份');
    const p = await eg.projects.get(r.pid);
    assert.deepEqual(p.remotes, ['github.com/example-org/demo-gateway']);
    assert.equal(p.paths[eg.machine.id].method, 'junction');
    // 透過 junction 寫入，檔案落在 vault
    fs.writeFileSync(path.join(memDir, 'new.md'), memoryText({ name: 'new', description: '新的' }));
    assert.ok(fs.existsSync(path.join(eg.paths.vault, 'projects', r.pid, 'memory', 'new.md')));
    // R-24：junction 路徑本身列入使用者層 additionalDirectories
    const settings = JSON.parse(fs.readFileSync(path.join(m.claudeHome, 'settings.json'), 'utf8'));
    assert.ok(settings.permissions.additionalDirectories.some((p) => p.toLowerCase() === memDir.toLowerCase()));
  });

  test('進行中的對話（transcript 剛更新）→ safe 模式延後切換', async () => {
    const repo = makeRepo(path.join(root, 'work', 'busy'));
    const t = addTranscript(m.claudeHome, repo, { ageMs: 1000 });
    fs.mkdirSync(path.join(t.dir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(t.dir, 'memory', 'a.md'), memoryText({ name: 'a', description: 'A' }));
    const r = await eg.identity.bind(repo, { create: { name: 'busy' } });
    assert.equal(r.state, 'pending');
    assert.equal(r.deferredReason, 'active-session');
    assert.equal(isLink(path.join(t.dir, 'memory')), false, '原資料夾不動');
  });

  test('SessionStart：remote 相同的新 clone 自動綁定（記憶資料夾不存在 → 當場建立 junction）', async () => {
    const clone = makeRepo(path.join(root, 'work2', 'gateway-clone'), { remote: 'https://github.com/example-org/demo-gateway' });
    const t = addTranscript(m.claudeHome, clone, { ageMs: 0 });
    const ctx = await eg.sessionContext({ cwd: path.join(clone), transcriptPath: t.file, sessionId: t.sessionId });
    assert.match(ctx.text, /^\[Engram\] 公司電腦（/);
    assert.match(ctx.text, /專案：示範閘道/);
    assert.match(ctx.text, /剛完成綁定/);
    assert.ok(ctx.text.split('\n').length <= 12 && ctx.text.length <= 1200);
    assert.ok(isLink(path.join(t.dir, 'memory')));
  });

  test('從 repo 子資料夾啟動也認得同一個專案', async () => {
    const repo = path.join(root, 'work', 'gateway');
    const sub = path.join(repo, 'src', 'deep');
    fs.mkdirSync(sub, { recursive: true });
    const ctx = await eg.sessionContext({ cwd: sub });
    assert.match(ctx.text, /專案：示範閘道.*已綁定/);
  });

  test('未納入的資料夾只顯示提示，不寫任何檔案', async () => {
    const dir = path.join(root, 'loose');
    fs.mkdirSync(dir, { recursive: true });
    const ctx = await eg.sessionContext({ cwd: dir });
    assert.match(ctx.text, /此資料夾尚未納入 Engram/);
    assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
  });

  test('中文撞名資料夾：改用 settings.local.json 備援並寫進 .git/info/exclude', async () => {
    const a = makeRepo(path.join(root, 'cjk', '甲方專案'));
    const b = path.join(root, 'cjk', '乙方專案');
    fs.mkdirSync(b, { recursive: true });
    assert.equal(encodeProjectPath(a), encodeProjectPath(b));
    addTranscript(m.claudeHome, a);
    addTranscript(m.claudeHome, b);
    const r = await eg.identity.bind(a, { create: { name: '甲方專案' } });
    assert.equal(r.method, 'settings');
    const s = JSON.parse(fs.readFileSync(path.join(a, '.claude', 'settings.local.json'), 'utf8'));
    assert.match(s.autoMemoryDirectory, new RegExp(`projects/${r.pid}/memory$`));
    // 不論是使用者的全域 gitignore（Claude Code 會加）還是我們寫的 .git/info/exclude，結果都必須是「被忽略」
    assert.doesNotThrow(() => git(a, 'check-ignore', '-q', '.claude/settings.local.json'));
    const ctx = await eg.sessionContext({ cwd: a });
    assert.match(ctx.text, /設定檔備援/);
    assert.match(ctx.text, /撞名/);
  });

  test('R-25：撞名的另一個資料夾事後才第一次開啟 → 判為撞名，不改寫原綁定、不冒充對方專案', async () => {
    const a = makeRepo(path.join(root, 'late', '甲方資料'));
    const tA = addTranscript(m.claudeHome, a);
    const r = await eg.identity.bind(a, { create: { name: '甲方資料' } });
    assert.equal(r.method, 'junction', '當時還沒有撞名');
    const b = path.join(root, 'late', '乙方資料');
    fs.mkdirSync(b, { recursive: true });
    assert.equal(encodeProjectPath(a), encodeProjectPath(b));
    const tB = addTranscript(m.claudeHome, b, { ageMs: 0 });
    assert.equal(tA.enc, tB.enc);
    const ctx = await eg.sessionContext({ cwd: b, transcriptPath: tB.file, sessionId: tB.sessionId });
    assert.doesNotMatch(ctx.text, /專案：甲方資料.*已綁定/, '不可告訴 Claude 它在甲方資料');
    assert.match(ctx.text, /撞名/);
    assert.match(ctx.text, /請不要引用這些記憶/);
    const bindings = JSON.parse(fs.readFileSync(path.join(eg.paths.vault, 'machines', eg.machine.id, 'bindings.json'), 'utf8'));
    const entry = Object.values(bindings).find((x) => x.pid === r.pid);
    assert.equal(entry.path.toLowerCase(), a.toLowerCase(), '原綁定路徑不變');
    // 對話結束後同步 → 轉成設定檔備援
    const st = JSON.parse(fs.readFileSync(path.join(eg.paths.local, 'state.json'), 'utf8'));
    assert.ok(st.pendingSplits.some((p) => p.encoded === tA.enc));
    age(tB.file, 10 * 60_000);
    await eg.sync({ network: false });
    const after = JSON.parse(fs.readFileSync(path.join(eg.paths.vault, 'machines', eg.machine.id, 'bindings.json'), 'utf8'));
    const conv = Object.values(after).find((x) => x.pid === r.pid);
    assert.equal(conv.method, 'settings');
    assert.equal(isLink(path.join(tA.dir, 'memory')), false, 'junction 已移除');
    const s = JSON.parse(fs.readFileSync(path.join(a, '.claude', 'settings.local.json'), 'utf8'));
    assert.match(s.autoMemoryDirectory, new RegExp(`projects/${r.pid}/memory$`));
  });

  test('R-25：撞名期間寫進錯誤專案的記憶 → H19，可移到正確的資料夾', async () => {
    const a = path.join(root, 'late', '甲方資料');
    const b = path.join(root, 'late', '乙方資料');
    const pid = (await eg.identity.resolve(a)).pid;
    const enc = encodeProjectPath(b);
    const sess = fs.readdirSync(path.join(m.claudeHome, 'projects', enc)).filter((f) => f.endsWith('.jsonl'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(m.claudeHome, 'projects', enc, f), 'utf8').split('\n')[0]))
      .find((x) => x.cwd.toLowerCase() === b.toLowerCase());
    const ref = `projects/${pid}/memory/misplaced.md`;
    fs.writeFileSync(path.join(eg.paths.vault, ...ref.split('/')), memoryText({ name: 'misplaced', description: '乙方的事', originSessionId: sess.sessionId }));
    const findings = await eg.health();
    const h19 = findings.find((f) => f.code === 'H19' && f.refs.includes(ref));
    assert.ok(h19, '應提示 H19');
    const res = await eg.apply(h19.fix);
    assert.ok(res.ref && !res.ref.includes(pid), '已移到另一個專案');
    const bindB = await eg.identity.resolve(b);
    assert.equal(bindB.confidence, 'certain');
    assert.notEqual(bindB.pid, pid);
  });

  test('R-25 反向：真的搬家（舊路徑消失、remote 相同）仍正確辨識並更新路徑', async () => {
    const oldDir = makeRepo(path.join(root, 'mv', 'gamma-old'), { remote: 'https://github.com/example/gamma.git' });
    addTranscript(m.claudeHome, oldDir);
    const r = await eg.identity.bind(oldDir, { create: { name: 'gamma' } });
    // 搬家後編碼不同，但同一個 repo：用 remote 認出
    const newDir = path.join(root, 'mv2', 'gamma');
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    fs.renameSync(oldDir, newDir);
    const t = addTranscript(m.claudeHome, newDir, { ageMs: 0 });
    const ctx = await eg.sessionContext({ cwd: newDir, transcriptPath: t.file });
    assert.match(ctx.text, /專案：gamma（/);
    assert.match(ctx.text, /剛完成綁定/);
    assert.equal((await eg.identity.resolve(newDir)).pid, r.pid);
  });

  test('R-25 反向：同一個編碼、舊路徑消失、標記檔相符 → 視為搬家', async () => {
    const dir = path.join(root, 'mv3', '筆記甲');
    fs.mkdirSync(dir, { recursive: true });
    addTranscript(m.claudeHome, dir);
    const r = await eg.identity.bind(dir, { create: { name: 'notes' } });
    // 改名成同樣字數的中文名稱 → 編碼相同
    const renamed = path.join(root, 'mv3', '筆記乙');
    fs.renameSync(dir, renamed);
    assert.equal(encodeProjectPath(dir), encodeProjectPath(renamed));
    const t = addTranscript(m.claudeHome, renamed, { ageMs: 0 });
    const ctx = await eg.sessionContext({ cwd: renamed, transcriptPath: t.file });
    assert.match(ctx.text, /專案：notes（.*已綁定/);
    const bindings = JSON.parse(fs.readFileSync(path.join(eg.paths.vault, 'machines', eg.machine.id, 'bindings.json'), 'utf8'));
    assert.equal(Object.values(bindings).find((x) => x.pid === r.pid).path.toLowerCase(), renamed.toLowerCase());
  });

  test('SW-1：撞名的另一個資料夾從沒開過 Claude Code，綁定時就直接改用設定檔備援', async () => {
    const a = makeRepo(path.join(root, 'sw1', '設計同步'));
    const b = path.join(root, 'sw1', '報表整理');
    fs.mkdirSync(b, { recursive: true }); // 只存在於檔案系統，沒有任何 transcript
    addTranscript(m.claudeHome, a);
    const r = await eg.identity.bind(a, { create: { name: '設計同步' } });
    assert.equal(r.method, 'settings');
    assert.equal(isLink(path.join(m.claudeHome, 'projects', encodeProjectPath(a), 'memory')), false);
  });

  test('R-18：與專案相關的單機記憶不進單機索引，只在開那個專案時列出', async () => {
    const pid = (await eg.projects.list()).find((p) => p.name === '示範閘道').pid;
    await eg.memories.create({ scope: { kind: 'machine' }, project: pid, name: 'gateway-local-port', type: 'reference', description: '閘道在這台電腦用 4000 埠', body: 'port 4000' });
    const idx = fs.readFileSync(path.join(eg.paths.vault, 'machines', eg.machine.id, 'INDEX.md'), 'utf8');
    assert.doesNotMatch(idx, /gateway-local-port/);
    assert.match(idx, /只與特定專案有關/);
    const ctx = await eg.sessionContext({ cwd: path.join(root, 'work', 'gateway') });
    assert.match(ctx.text, /gateway-local-port/);
    const other = await eg.sessionContext({ cwd: path.join(root, 'loose') });
    assert.doesNotMatch(other.text, /gateway-local-port/);
  });

  test('非 git 資料夾留下 .claude/engram.json；搬家後仍認得', async () => {
    const dir = path.join(root, 'docs', 'meeting-notes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    addTranscript(m.claudeHome, dir);
    const r = await eg.identity.bind(dir, { create: { name: '會議紀錄' } });
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'engram.json'), 'utf8'));
    assert.equal(marker.pid, r.pid);
    const moved = path.join(root, 'docs2', 'meeting-notes-renamed');
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(dir, moved);
    const res = await eg.identity.resolve(moved);
    assert.equal(res.pid, r.pid);
    assert.equal(res.confidence, 'certain');
  });
});

describe('健康檢查', () => {
  test('偵測重複、應升級全域、密鑰、junction 失效與碰撞', async () => {
    const pid = (await eg.projects.list()).find((p) => p.name === '示範閘道').pid;
    const dir = path.join(eg.paths.vault, 'projects', pid, 'memory');
    fs.writeFileSync(path.join(dir, 'user-pref.md'), memoryText({ name: 'user-pref', description: '使用者偏好正體中文', type: 'user' }));
    fs.writeFileSync(path.join(dir, 'user-pref-copy.md'), memoryText({ name: 'user-pref', description: '使用者偏好正體中文', type: 'user' }));
    const fake = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    fs.writeFileSync(path.join(dir, 'token-note.md'), memoryText({ name: 'token-note', description: '部署用權杖', body: `token: ${fake}` }));
    const findings = await eg.health();
    const codes = new Set(findings.map((f) => f.code));
    for (const c of ['H07', 'H09', 'H13', 'H06', 'H03']) assert.ok(codes.has(c), `應有 ${c}`);
    const h13 = findings.find((f) => f.code === 'H13');
    assert.doesNotMatch(JSON.stringify(h13), new RegExp(fake), '健康檢查結果不可含金鑰本身');
    const st = await eg.status();
    assert.ok(st.inbox.findings.high >= 1);
  });

  test('junction 被換成一般資料夾 → H17', async () => {
    const repo = path.join(root, 'work', 'gateway');
    const enc = encodeProjectPath(repo);
    const memDir = path.join(m.claudeHome, 'projects', enc, 'memory');
    fs.rmdirSync(memDir);
    fs.mkdirSync(memDir);
    const findings = await eg.health();
    assert.ok(findings.some((f) => f.code === 'H17' && f.severity === 'high'));
    const fix = findings.find((f) => f.code === 'H17' && f.severity === 'high').fix;
    await eg.apply(fix);
    assert.ok(isLink(memDir));
  });

  test('預設權限模式不是 auto → 提醒寫入會詢問；組織設定優先；finding id 不重複', async () => {
    const file = path.join(m.claudeHome, 'settings.json');
    const remote = path.join(m.claudeHome, 'remote-settings.json');
    const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const withMode = (mode) => JSON.stringify({ ...JSON.parse(original ?? '{}'), permissions: { ...JSON.parse(original ?? '{}').permissions, defaultMode: mode } });
    const asks = (fs_) => fs_.some((f) => f.code === 'H17' && f.title === '讀寫記憶時會跳出權限詢問');
    try {
      fs.writeFileSync(file, withMode('acceptEdits'));
      let findings = await eg.health();
      assert.ok(asks(findings), 'acceptEdits 應提醒');
      assert.equal(new Set(findings.map((f) => f.id)).size, findings.length, 'finding id 不可重複');
      fs.writeFileSync(file, withMode('auto'));
      assert.ok(!asks(await eg.health()), 'auto 不提醒');
      fs.writeFileSync(remote, JSON.stringify({ permissions: { defaultMode: 'default' } }));
      assert.ok(asks(await eg.health()), '組織下發的設定優先於使用者層');
    } finally {
      fs.rmSync(remote, { force: true });
      if (original === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, original);
    }
  });
});

describe('介面需要的引擎能力', () => {
  test('金鑰本機遮蔽、標記「不是金鑰」、secretRanges', async () => {
    const fake = ['gh', 'p_', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'].join('');
    const r = plant('global/leaky.md', memoryText({ name: 'leaky', description: '含權杖', type: 'reference', body: `第一行\ntoken: ${fake}\n` }));
    const mem = await eg.memories.read(r.ref);
    assert.equal(mem.secretRanges.length, 1);
    const p = await eg.secrets.preview(r.ref);
    assert.ok(p.matches.length === 1 && !p.after.includes(fake) && p.after.includes('‹已遮蔽：'));
    await eg.secrets.redact(r.ref);
    assert.doesNotMatch(fs.readFileSync(path.join(eg.paths.vault, r.ref), 'utf8'), new RegExp(fake));
    // 「這不是金鑰」
    const r2 = plant('global/not-secret.md', memoryText({ name: 'not-secret', description: '其實是範例字串', type: 'reference', body: `sample: ${fake}\n` }));
    const line = (await eg.memories.read(r2.ref)).secretRanges[0].line;
    await eg.secrets.allow(r2.ref, line);
    assert.equal((await eg.memories.read(r2.ref)).secretRanges.length, 0);
    assert.ok(!(await eg.health()).some((f) => f.code === 'H13' && f.refs.includes(r2.ref)));
  });

  test('健康卡片可忽略或延後；doctor 仍列出', async () => {
    const before = await eg.health();
    const f = before.find((x) => x.severity !== 'auto');
    await eg.findings.dismiss(f.id);
    assert.ok(!(await eg.health()).some((x) => x.id === f.id));
    const all = await eg.health({ includeDismissed: true });
    assert.ok(all.find((x) => x.id === f.id).dismissed);
    await eg.findings.restore(f.id);
    assert.ok((await eg.health()).some((x) => x.id === f.id));
  });

  test('status 提供各電腦最後同步時間與被擋下的檔案；identity.pending 列出等待切換', async () => {
    const st = await eg.status();
    assert.ok('lastSyncAt' in st.devices[0]);
    assert.ok(Array.isArray(st.sync.held));
    const pend = await eg.identity.pending();
    assert.ok(pend.some((p) => p.reason === 'active-session'));
  });

  test('同步工作準則：預覽、採用（CLAUDE.md 只留區塊）、還原（逐位元）', async () => {
    const claudeMd = path.join(m.claudeHome, 'CLAUDE.md');
    const original = `# 我的工作準則\n\n- 先想再寫\n- 保持簡單\n\n${await eg.claudeMdBlock()}`;
    fs.writeFileSync(claudeMd, original);
    const pv = await eg.core.guidelines.preview();
    assert.equal(pv.adopted, false);
    assert.match(pv.proposed, /先想再寫/);
    assert.equal(pv.coreLine, '@rules/user-guidelines.md');
    await eg.core.guidelines.adopt();
    assert.match(fs.readFileSync(claudeMd, 'utf8'), /^<!-- engram:begin/);
    assert.match(fs.readFileSync(path.join(eg.paths.vault, 'core', 'rules', 'user-guidelines.md'), 'utf8'), /先想再寫/);
    assert.match(fs.readFileSync(path.join(eg.paths.vault, 'core', 'CORE.md'), 'utf8'), /@rules\/user-guidelines\.md/);
    assert.ok((await eg.indexBudget()).rules > 0, '預算計入匯入的規則');
    await eg.core.guidelines.revert();
    assert.equal(fs.readFileSync(claudeMd, 'utf8'), original);
    assert.doesNotMatch(fs.readFileSync(path.join(eg.paths.vault, 'core', 'CORE.md'), 'utf8'), /user-guidelines/);
  });

  test('電腦改名、bindAuto 設定、使用者暫停', async () => {
    await eg.machine.rename('辦公室桌機');
    assert.equal(eg.machine.label, '辦公室桌機');
    assert.match(fs.readFileSync(path.join(eg.paths.vault, 'core', 'CORE.md'), 'utf8'), /辦公室桌機（/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(eg.paths.vault, 'machines', eg.machine.id, 'machine.json'), 'utf8')).label, '辦公室桌機');
    assert.deepEqual(await eg.settings.get(), { bindAuto: 'confident', collisionRename: 'ask' });
    await assert.rejects(eg.settings.set({ collisionRename: 'sometimes' }), /collisionRename/);
    await eg.settings.set({ bindAuto: 'ask' });
    const clone = makeRepo(path.join(root, 'ask', 'gateway-ask'), { remote: 'https://github.com/example-org/demo-gateway' });
    const t = addTranscript(m.claudeHome, clone, { ageMs: 0 });
    const ctx = await eg.sessionContext({ cwd: clone, transcriptPath: t.file });
    assert.match(ctx.text, /等待在 Engram 介面確認接上/);
    assert.equal(isLink(path.join(t.dir, 'memory')), false, '設定為先問我時不自動建立 junction');
    await eg.settings.set({ bindAuto: 'confident' });
    fs.writeFileSync(path.join(eg.paths.local, 'paused.json'), JSON.stringify({ junction: true, normalize: true, user: true }));
    const paused = await eg.sessionContext({ cwd: path.join(root, 'loose') });
    assert.match(paused.text, /Engram 已暫停（不同步、不自動接上）/);
    assert.equal((await eg.sync({ network: false })).state, 'paused');
    fs.rmSync(path.join(eg.paths.local, 'paused.json'));
    await eg.machine.rename('公司電腦');
  });

  test('R-45：外部傳入的 id、範圍、路徑與版本一律驗證', async () => {
    const outside = path.join(eg.paths.vault, 'core');
    await assert.rejects(eg.conflicts.resolve('../core', { choice: 'ours' }), (e) => e.code === 'E_INVALID');
    await assert.rejects(eg.conflicts.resolve('cf_x/../../core', { choice: 'ours' }), (e) => e.code === 'E_INVALID');
    assert.ok(fs.existsSync(outside), 'vault 內的其他資料夾沒有被刪除');
    const ref = (await eg.memories.list({ scope: 'global' }))[0].ref;
    await assert.rejects(eg.memories.move(ref, { kind: 'project', pid: '../../evil' }), (e) => e.code === 'E_INVALID');
    await assert.rejects(eg.memories.move(ref, { kind: 'machine', mid: 'a/../b' }), (e) => e.code === 'E_INVALID');
    await assert.rejects(eg.projects.rename('../x', 'y'), (e) => e.code === 'E_INVALID');
    await assert.rejects(eg.apply({ action: 'allow-read', args: { path: 'C:\\' } }), (e) => e.code === 'E_INVALID');
    await assert.rejects(eg.memories.restore(ref, { rev: '--output=x' }), (e) => e.code === 'E_INVALID');
    await assert.rejects(eg.apply({ action: 'reassign', args: { ref, root: 'C:\\Windows' } }), (e) => e.code === 'E_INVALID');
    await assert.rejects(eg.apply({ action: 'rebind', args: { dir: 'C:\\Windows' } }), (e) => e.code === 'E_INVALID');
    await assert.rejects(eg.apply({ action: 'forget-binding', args: { encoded: '__proto__' } }), (e) => e.code === 'E_INVALID');
    await assert.rejects(eg.memories.read('projects/../../x.md'), (e) => e.code === 'E_INVALID');
  });

  test('導入相關的 commit 不能單獨復原', async () => {
    const h = await eg.history({ limit: 200 });
    const b = h.find((c) => c.action === 'bind');
    assert.equal(b.undoable, false);
    await assert.rejects(eg.undo(b.sha));
  });
});

describe('沒有遠端時的同步', () => {
  test('sync 只做本機 commit，狀態為僅本機', async () => {
    const dir = path.join(eg.paths.vault, 'global');
    fs.writeFileSync(path.join(dir, 'manual.md'), memoryText({ name: 'manual', description: '手動新增' }));
    ageTree(eg.paths.vault);
    const r = await eg.sync();
    assert.equal(r.ok, true);
    assert.equal(r.state, 'never');
    assert.equal(git(eg.paths.vault, 'status', '--porcelain', '--', 'global/'), '');
    const ctx = await eg.sessionContext({ cwd: path.join(root, 'loose') });
    assert.match(ctx.text, /僅本機/);
  });

  test('密鑰檔不會被 commit', async () => {
    const st = git(eg.paths.vault, 'status', '--porcelain');
    assert.match(st, /token-note\.md/);
  });

  test('10 秒內被改過的檔案這一輪不提交', async () => {
    const p = path.join(eg.paths.vault, 'global', 'fresh.md');
    fs.writeFileSync(p, memoryText({ name: 'fresh', description: '剛寫' }));
    const r = await eg.sync();
    assert.ok(r.skipped.recent.includes('global/fresh.md'));
    age(p);
    await eg.sync();
    assert.equal(git(eg.paths.vault, 'status', '--porcelain', '--', 'global/fresh.md'), '');
  });
});
