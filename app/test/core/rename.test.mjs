// 撞名資料夾依命名規則改名（SW-4）：盤點、改名、重新綁定、記憶裡的舊路徑、共用舊記憶資料夾退役、整批還原。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { init, open } from '../../src/core/index.mjs';
import { collisionCode, pathPattern, renamedPathMapper, replacePath } from '../../src/core/rename.mjs';
import { encodeProjectPath } from '../../src/core/paths.mjs';
import { isLink } from '../../src/core/fsx.mjs';
import { addTranscript, git, machinePaths, makeRepo, memoryText, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

const mem = (dir, file, opts) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), memoryText(opts)); };

describe('命名規則與路徑替換', () => {
  test('代號由路徑算出、固定不變、不分大小寫；同名不同位置得到不同代號', () => {
    const a = collisionCode('C:\\Users\\x\\Desktop\\專案\\範例');
    assert.match(a, /^[0-9a-hjkmnp-tv-z]{4}$/);
    assert.equal(collisionCode('c:\\users\\X\\desktop\\專案\\範例'), a);
    assert.notEqual(collisionCode('C:\\Users\\x\\Desktop\\文件\\範例'), a);
  });

  test('路徑替換：各種寫法都換、只換最後一段；名稱延續（另一個資料夾）與上層資料夾不換', () => {
    const home = 'C:\\Users\\x';
    const from = 'C:\\Users\\x\\Desktop\\甲方報告';
    const to = 'C:\\Users\\x\\Desktop\\甲方報告-k3fz';
    const cases = [
      ['檔案在 C:\\Users\\x\\Desktop\\甲方報告\\a.html。', '檔案在 C:\\Users\\x\\Desktop\\甲方報告-k3fz\\a.html。'],
      ['`C:/Users/x/Desktop/甲方報告`', '`C:/Users/x/Desktop/甲方報告-k3fz`'],
      ['cd /c/Users/x/Desktop/甲方報告/src', 'cd /c/Users/x/Desktop/甲方報告-k3fz/src'],
      ['成果在 Desktop\\甲方報告，主檔', '成果在 Desktop\\甲方報告-k3fz，主檔'],
      ['~/Desktop/甲方報告/x', '~/Desktop/甲方報告-k3fz/x'],
      ['另一個資料夾 Desktop\\甲方報告設定\\', '另一個資料夾 Desktop\\甲方報告設定\\'],
      ['上層 C:\\Users\\x\\Desktop 不換', '上層 C:\\Users\\x\\Desktop 不換'],
      ['MyDesktop\\甲方報告 不是同一個', 'MyDesktop\\甲方報告 不是同一個'],
    ];
    for (const [text, want] of cases) assert.equal(replacePath(text, from, to, home).text, want, text);
    assert.equal(replacePath(cases[0][0], from, to, home).count, 1);
    assert.ok(pathPattern(from, home).flags.includes('i'));
  });
});

describe('撞名資料夾改名', () => {
  test('盤點 → 改名（重新綁定、記憶路徑、舊記憶資料夾退役、被占用的下次再試）→ 由 undo(sha) 整批還原', async () => {
    const root = mkTmp('engram-rename-');
    let child = null;
    try {
      const cli = writeDriverCli(root);
      const mm = machinePaths(root, 'pc');
      await init({ ...mm, machineLabel: '公司電腦', cli });
      const e = await open(mm);
      const desk = path.join(mm.userHome, 'Desktop');
      const A = path.join(desk, '甲方報告');
      const B = path.join(desk, '乙方資料');
      const C = path.join(desk, '丙方設計'); // 沒用過 Claude Code，不改
      for (const d of [A, B, C]) fs.mkdirSync(d, { recursive: true });
      const ta = addTranscript(mm.claudeHome, A, { sessionId: 'sa' });
      addTranscript(mm.claudeHome, B, { sessionId: 'sb' });
      const shared = path.join(ta.dir, 'memory');
      mem(shared, 'a-note.md', { name: 'a-note', description: '甲方', originSessionId: 'sa', body: `簡報在 ${A}\\slides.html。` });
      mem(shared, 'b-note.md', { name: 'b-note', description: '乙方', originSessionId: 'sb' });
      // 內含其他專案的資料夾（改名會連帶移動）：兩個字的「甲乙」與「丙丁」撞名，丙丁裡有另一個專案
      const P = path.join(desk, '甲乙');
      const Q = path.join(desk, '丙丁');
      const Qin = makeRepo(path.join(Q, 'inner-app'));
      for (const d of [P]) fs.mkdirSync(d, { recursive: true });
      addTranscript(mm.claudeHome, P);
      addTranscript(mm.claudeHome, Q);
      addTranscript(mm.claudeHome, Qin);
      // 30 分鐘內有對話的撞名資料夾：「戊方專案」與「己方專案」（四個字，另一組編碼要不同 → 放在 Downloads）
      const dl = path.join(mm.userHome, 'Downloads');
      const R = path.join(dl, '戊方專案');
      const S = path.join(dl, '己方專案');
      fs.mkdirSync(R, { recursive: true });
      fs.mkdirSync(S, { recursive: true });
      addTranscript(mm.claudeHome, R, { ageMs: 60_000 });

      const imported = await e.sweepLegacy({ dryRun: false, plan: await e.sweepLegacy({ dryRun: true }) });
      assert.equal(imported.bound.length, 2);
      const pidA = (await e.projects.list()).find((p) => p.name === '甲方報告').pid;
      const bindingsFile = path.join(e.paths.vault, 'machines', e.machine.id, 'bindings.json');
      const bindingsBefore = JSON.parse(fs.readFileSync(bindingsFile, 'utf8'));
      const footA = Object.values(bindingsBefore).find((b) => b.path.toLowerCase() === A.toLowerCase()).footprint;
      assert.equal(Object.values(bindingsBefore).find((b) => b.path.toLowerCase() === A.toLowerCase()).method, 'settings', '測試前提：撞名只用設定檔');
      // 另一台電腦寫的記憶提到同樣的路徑（指的是那台的資料夾）：不改
      const vault = e.paths.vault;
      const homeNote = path.join(vault, 'projects', pidA, 'memory', 'home-note.md');
      fs.writeFileSync(homeNote, memoryText({ name: 'home-note', description: '家裡', body: `家裡的 ${A}\\draft。` }));
      git(vault, 'add', '-A');
      git(vault, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--no-verify', '-m', 'engram(home-pc0001): autosave');
      const aNoteRef = `projects/${pidA}/memory/a-note.md`;
      const aNoteBefore = fs.readFileSync(path.join(vault, ...aNoteRef.split('/')), 'utf8');

      const plan = await e.collisions.plan();
      const of = (p) => plan.find((it) => it.path.toLowerCase() === p.toLowerCase());
      assert.equal(of(A).to, `${A}-${collisionCode(A)}`);
      assert.ok(of(B).to);
      assert.equal(of(C), undefined, '沒用過的資料夾不在計畫裡');
      assert.equal(of(Q).blocked, 'contains-projects');
      assert.equal(of(R).blocked, 'active-session');
      assert.ok(of(P).to);
      assert.notEqual(encodeProjectPath(of(A).to), encodeProjectPath(of(B).to), '新名稱彼此不撞名');

      // 「甲乙」被另一個程式當作工作目錄（Windows 不能改名）→ 這次略過
      child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: P, stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 300));

      const r = await e.collisions.apply({});
      assert.deepEqual(r.renamed.map((x) => path.basename(x.from)).sort(), ['乙方資料', '甲方報告']);
      assert.ok(r.skipped.some((x) => x.path.toLowerCase() === P.toLowerCase() && x.reason === 'busy'), JSON.stringify(r.skipped));
      assert.ok(r.skipped.some((x) => x.reason === 'contains-projects'));
      const A2 = of(A).to;
      assert.ok(fs.existsSync(A2) && !fs.existsSync(A));
      assert.ok(fs.existsSync(C), '沒用過的資料夾不動');
      // 重新綁定：不再撞名，auto 模式改用 junction；第一次綁定的足跡沿用
      const after = JSON.parse(fs.readFileSync(bindingsFile, 'utf8'));
      const bA = Object.values(after).find((b) => b.path.toLowerCase() === A2.toLowerCase());
      assert.equal(bA.pid, pidA);
      assert.equal(bA.method, 'junction');
      assert.deepEqual(bA.footprint, footA);
      assert.ok(!Object.values(after).some((b) => b.path.toLowerCase() === A.toLowerCase()), '舊路徑的綁定已移除');
      assert.ok(isLink(path.join(mm.claudeHome, 'projects', encodeProjectPath(A2), 'memory')));
      // 記憶裡的舊路徑：這台寫的換掉，另一台寫的不動
      assert.match(fs.readFileSync(path.join(vault, ...aNoteRef.split('/')), 'utf8'), new RegExp(path.basename(A2)));
      assert.doesNotMatch(fs.readFileSync(homeNote, 'utf8'), new RegExp(path.basename(A2)));
      // 共用的舊記憶資料夾（都收編完、用過它的資料夾都改名了）→ 移到備份
      assert.equal(fs.existsSync(shared), false);
      assert.equal(r.retired.length, 1);
      // 改名紀錄與歷史
      const hist = (await e.history({ limit: 5 })).find((c) => c.action === 'rename-folder');
      assert.ok(hist?.undoable, '改名的 commit 可以還原');
      assert.equal(JSON.parse(fs.readFileSync(path.join(vault, 'machines', e.machine.id, 'renames.json'), 'utf8')).batches.length, 1);

      // 由 undo(sha) 整批還原
      const u = await e.undo(r.undo.sha);
      assert.equal(u.ok, true, JSON.stringify(u));
      assert.ok(fs.existsSync(A) && !fs.existsSync(A2));
      assert.equal(fs.readFileSync(path.join(vault, ...aNoteRef.split('/')), 'utf8'), aNoteBefore, '記憶內容逐位元回到改名前');
      assert.deepEqual(JSON.parse(fs.readFileSync(bindingsFile, 'utf8')), bindingsBefore, '綁定表回到改名前');
      assert.equal(fs.existsSync(path.join(mm.claudeHome, 'projects', encodeProjectPath(A2), 'memory')), false, '改名時建立的 junction 已移除');
      assert.ok(fs.existsSync(path.join(shared, 'a-note.md')), '共用的舊記憶資料夾放回原處');
      assert.ok((await e.history({ limit: 3 })).some((c) => c.action === 'undo'));
    } finally {
      child?.kill();
      rmTmp(root);
    }
  });

  test('H06：列出建議的新名稱，一鍵改名只接受引擎盤點出來的資料夾', async () => {
    const root = mkTmp('engram-rename2-');
    try {
      const cli = writeDriverCli(root);
      const mm = machinePaths(root, 'pc');
      await init({ ...mm, machineLabel: '公司電腦', cli });
      const e = await open(mm);
      const desk = path.join(mm.userHome, 'Desktop');
      const A = path.join(desk, '甲方報告');
      const B = path.join(desk, '乙方資料');
      const D = path.join(desk, '印表機');
      const E = path.join(desk, '練習用');
      for (const d of [A, B, D, E]) fs.mkdirSync(d, { recursive: true });
      addTranscript(mm.claudeHome, A);
      addTranscript(mm.claudeHome, B);
      addTranscript(mm.claudeHome, D);
      const h06 = (await e.health()).filter((f) => f.code === 'H06');
      const two = h06.find((f) => f.severity === 'high');
      assert.ok(two, '兩個用過的資料夾共用紀錄：高');
      assert.equal(two.fix.action, 'rename-collisions');
      assert.equal(two.fix.args.paths.length, 2);
      assert.match(two.detail, new RegExp(`甲方報告-${collisionCode(A)}`));
      const one = h06.find((f) => f.severity === 'medium');
      assert.ok(one && one.fix.args.paths[0].toLowerCase() === D.toLowerCase(), '只和沒用過的資料夾撞名：中');
      await assert.rejects(e.apply({ action: 'rename-collisions', args: { paths: [E] } }), /不需要或不能改名/);
      const r = await e.apply(one.fix);
      assert.equal(r.renamed.length, 1);
      assert.ok(fs.existsSync(`${D}-${collisionCode(D)}`));
      assert.ok(fs.existsSync(A), '只改指定的資料夾');
    } finally { rmTmp(root); }
  });
});

describe('對抗式審查的情境', () => {
  async function machine(prefix) {
    const root = mkTmp(prefix);
    const cli = writeDriverCli(root);
    const mm = machinePaths(root, 'pc');
    await init({ ...mm, machineLabel: '公司電腦', cli });
    return { root, mm, e: await open(mm) };
  }
  // 兩個用過的四字資料夾互相撞名
  function pair(mm, a = '甲方報告', b = '乙方資料') {
    const desk = path.join(mm.userHome, 'Desktop');
    const A = path.join(desk, a);
    const B = path.join(desk, b);
    for (const d of [A, B]) fs.mkdirSync(d, { recursive: true });
    addTranscript(mm.claudeHome, A);
    addTranscript(mm.claudeHome, B);
    return { desk, A, B };
  }

  test('路徑替換只認這個資料夾本身：別的磁碟、別的使用者、OneDrive、NAS、Linux 路徑、Windows 副本與名稱相近的兄弟資料夾都不改', () => {
    const root = mkTmp('engram-rp-');
    try {
      const home = path.join(root, 'Sen');
      const from = path.join(home, 'Desktop', '照片優化');
      fs.mkdirSync(from, { recursive: true });
      fs.mkdirSync(path.join(home, 'Desktop', '照片優化 舊版'), { recursive: true });
      const to = `${from}-66ca`;
      const drive = from.slice(0, 2);
      const tail = from.slice(3).split(path.sep).join('/');
      const keep = [
        'D:\\Backup\\Desktop\\照片優化\\2024',
        'C:\\Users\\Amy\\Desktop\\照片優化\\a.jpg',
        `${home}\\OneDrive\\Desktop\\照片優化\\b.jpg`,
        '\\\\nas\\home\\Desktop\\照片優化\\c.jpg',
        '/home/deploy/Desktop/照片優化/app.py',
        `${from} - 複製\\d.jpg`,
        `${from} (2)\\e.jpg`,
        `${from} 舊版\\f.jpg`,
      ];
      for (const t of keep) assert.equal(replacePath(t, from, to, home).count, 0, t);
      const change = [
        `${from}\\a.jpg`,
        `${drive}/${tail}/a.jpg`,
        `/${drive[0].toLowerCase()}/${tail}/a.jpg`,
        `/mnt/${drive[0].toLowerCase()}/${tail}/a.jpg`,
        `file:///${drive}/${tail}/a.jpg`,
        '~/Desktop/照片優化/a.jpg',
        '放在 Desktop\\照片優化 裡',
      ];
      for (const t of change) assert.equal(replacePath(t, from, to, home).count, 1, t);
      assert.equal(replacePath(`開啟 file:///${drive}/${tail}/a.jpg`, from, to, home).text, `開啟 file:///${drive}/${tail}-66ca/a.jpg`);
    } finally { rmTmp(root); }
  });

  test('記憶路徑改到一半失敗：已改的記憶改回原文、資料夾改回原名，不留下指向不存在路徑的記憶', async () => {
    const { root, mm, e } = await machine('engram-rp2-');
    try {
      const { A } = pair(mm);
      const r0 = await e.identity.bind(A, { create: { name: '甲方報告' } });
      const a1 = await e.memories.create({ scope: { kind: 'project', pid: r0.pid }, name: 'a1', type: 'project', description: '一', body: `在 ${A}\\x。` });
      const a2 = await e.memories.create({ scope: { kind: 'project', pid: r0.pid }, name: 'a2', type: 'project', description: '二', body: `在 ${A}\\y。` });
      const abs1 = path.join(e.paths.vault, ...a1.ref.split('/'));
      const abs2 = path.join(e.paths.vault, ...a2.ref.split('/'));
      const before1 = fs.readFileSync(abs1, 'utf8');
      fs.chmodSync(abs2, 0o444); // 第二筆寫不進去
      await assert.rejects(e.collisions.apply({}));
      fs.chmodSync(abs2, 0o644);
      assert.equal(fs.readFileSync(abs1, 'utf8'), before1, '第一筆已改回原文');
      assert.ok(fs.existsSync(A), '資料夾改回原名');
    } finally { rmTmp(root); }
  });

  test('不自動改名：有 worktree 的主 repo、Python 虛擬環境、30 分鐘內有檔案修改、Claude Code 記了 MCP 設定、OneDrive 底下', async () => {
    const { root, mm, e } = await machine('engram-rb-');
    try {
      const desk = path.join(mm.userHome, 'Desktop');
      const make = (name, setup) => { const d = path.join(desk, name); fs.mkdirSync(d, { recursive: true }); setup?.(d); addTranscript(mm.claudeHome, d); return d; };
      const old = (d) => { const t = new Date(Date.now() - 3 * 3600_000); for (const n of fs.readdirSync(d)) fs.utimesSync(path.join(d, n), t, t); };
      const wt = make('主庫專案', (d) => { makeRepo(d); git(d, 'worktree', 'add', '-q', path.join(root, 'wt'), '-b', 'wt'); old(d); });
      const venv = make('虛擬環境', (d) => { fs.mkdirSync(path.join(d, '.venv')); fs.writeFileSync(path.join(d, '.venv', 'pyvenv.cfg'), 'home = C:\\Python\n'); old(d); });
      // 子資料夾裡的虛擬環境、主 repo、worktree（改名會連帶移動它們）
      const nestedVenv = make('後端服務', (d) => { fs.mkdirSync(path.join(d, 'backend', '.venv'), { recursive: true }); fs.writeFileSync(path.join(d, 'backend', '.venv', 'pyvenv.cfg'), 'home = C:\\Python\n'); old(d); });
      const nestedMain = make('多個專案', (d) => { const sub = makeRepo(path.join(d, 'apps', 'web')); git(sub, 'worktree', 'add', '-q', path.join(root, 'wt-nested'), '-b', 'wt2'); old(d); });
      const elsewhere = makeRepo(path.join(root, 'elsewhere'));
      const nestedWt = make('分支試做', (d) => { git(elsewhere, 'worktree', 'add', '-q', path.join(d, 'try'), '-b', 'wt3'); old(d); });
      const busy = make('最近修改', (d) => fs.writeFileSync(path.join(d, 'notes.txt'), 'x'));
      const mcp = make('外掛設定');
      fs.writeFileSync(path.join(mm.userHome, '.claude.json'), JSON.stringify({ projects: { [mcp.split(path.sep).join('/')]: { mcpServers: { demo: { command: 'x' } } } } }));
      make('甲方報告'); // 讓上面四個字的資料夾都撞名
      const od = path.join(mm.userHome, 'OneDrive', '共用文件');
      fs.mkdirSync(od, { recursive: true });
      fs.mkdirSync(path.join(mm.userHome, 'OneDrive', '共用照片'), { recursive: true });
      addTranscript(mm.claudeHome, od);
      const plan = await e.collisions.plan();
      const reason = (p) => plan.find((it) => it.path.toLowerCase() === p.toLowerCase())?.blocked;
      assert.equal(reason(wt), 'git-worktree');
      assert.equal(reason(venv), 'python-venv');
      assert.equal(reason(nestedVenv), 'python-venv');
      assert.equal(reason(nestedMain), 'git-worktree');
      assert.equal(reason(nestedWt), 'git-worktree');
      assert.equal(reason(busy), 'recent-activity');
      assert.equal(reason(mcp), 'claude-project-settings');
      assert.equal(reason(od), 'onedrive');
    } finally { rmTmp(root); }
  });

  test('改名後才收編的舊記憶：依改名紀錄歸到改名後的資料夾，不另建封存專案', async () => {
    const { root, mm, e } = await machine('engram-rp4-');
    try {
      const desk = path.join(mm.userHome, 'Desktop');
      const A = path.join(desk, '甲方報告');
      const B = path.join(desk, '乙方資料');
      for (const d of [A, B]) fs.mkdirSync(d, { recursive: true });
      const ta = addTranscript(mm.claudeHome, A, { sessionId: 'sa' });
      addTranscript(mm.claudeHome, B, { sessionId: 'sb' });
      const r = await e.collisions.apply({});
      assert.equal(r.renamed.length, 2);
      // 改名之前寫下、還沒收編的記憶（originSessionId 指向改名前的對話）
      mem(path.join(ta.dir, 'memory'), 'late.md', { name: 'late', description: '晚到的', originSessionId: 'sa' });
      const plan = await e.sweepLegacy({ dryRun: true });
      const s = plan.sources.find((x) => x.items.some((i) => i.file === 'late.md'));
      assert.equal(s.resolvedPath.toLowerCase(), `${A}-${collisionCode(A)}`.toLowerCase());
      assert.equal(s.exists, true);
      assert.equal(s.target.archived, false);
    } finally { rmTmp(root); }
  });

  test('整批還原時有資料夾被占用：其他筆照樣還原，被占用的那筆維持改名後的完整狀態；關掉程式後再按一次還原就完成', async () => {
    const { root, mm, e } = await machine('engram-rp5-');
    let child = null;
    try {
      const { A, B } = pair(mm);
      await e.identity.bind(A, { create: { name: '甲方報告' } });
      await e.identity.bind(B, { create: { name: '乙方資料' } });
      const bindingsFile = path.join(e.paths.vault, 'machines', e.machine.id, 'bindings.json');
      const bindingsBefore = JSON.parse(fs.readFileSync(bindingsFile, 'utf8'));
      const r = await e.collisions.apply({});
      assert.equal(r.renamed.length, 2);
      const to = (p) => r.renamed.find((x) => x.from.toLowerCase() === p.toLowerCase()).to;
      const [A2, B2] = [to(A), to(B)];
      child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: A2, stdio: 'ignore' });
      await new Promise((res) => setTimeout(res, 300));

      const u1 = await e.undo(r.undo.sha);
      assert.equal(u1.done, false);
      assert.equal(u1.ok, false);
      assert.ok(u1.notes.some((n) => n.includes(path.basename(A2))), JSON.stringify(u1.notes));
      assert.equal(u1.en.notes.length, u1.notes.length, '英文 notes 與中文 notes 一一對應');
      assert.ok(u1.en.notes.some((n) => n.includes(A2) && /could not be renamed back/.test(n) && /Close any program using this folder/.test(n)), JSON.stringify(u1.en.notes));
      assert.ok(fs.existsSync(B) && !fs.existsSync(B2), '沒被占用的那筆已還原');
      assert.ok(fs.existsSync(A2) && !fs.existsSync(A), '被占用的那筆停在新名稱');
      const mid = Object.values(JSON.parse(fs.readFileSync(bindingsFile, 'utf8')));
      assert.ok(mid.some((b) => b.path.toLowerCase() === A2.toLowerCase()), '被占用的那筆，綁定仍指向新名稱');
      assert.ok(!mid.some((b) => b.path.toLowerCase() === A.toLowerCase()));
      assert.ok(mid.some((b) => b.path.toLowerCase() === B.toLowerCase()));
      const map = await renamedPathMapper({ vault: e.paths.vault, mid: e.machine.id });
      assert.equal(map(path.join(A, 'src')).toLowerCase(), path.join(A2, 'src').toLowerCase(), '對話紀錄的舊路徑仍對應到新名稱');
      assert.equal(map(B), B, '已還原的那筆不再對應');
      assert.ok((await e.history({ limit: 10 })).find((c) => c.action === 'rename-folder')?.undoable, '還可以再按還原');

      child.kill();
      child = null;
      await new Promise((res) => setTimeout(res, 300));
      const u2 = await e.undo(r.undo.sha);
      assert.equal(u2.ok, true, JSON.stringify(u2));
      assert.deepEqual(u2.restored.map((x) => x.to.toLowerCase()), [A.toLowerCase()], '只重試剩下的那筆');
      assert.ok(fs.existsSync(A) && !fs.existsSync(A2));
      assert.deepEqual(JSON.parse(fs.readFileSync(bindingsFile, 'utf8')), bindingsBefore, '綁定表回到改名前');
      assert.equal((await e.undo(r.undo.sha)).already, true);
    } finally {
      child?.kill();
      rmTmp(root);
    }
  });

  test('還原時改名後的資料夾不見了：那一筆只拆新綁定、視為完成並說明；原位置另建的無關資料夾不會被綁到原專案', async () => {
    for (const recreate of [false, true]) {
      const { root, mm, e } = await machine(`engram-rp7${recreate ? 'b' : 'a'}-`);
      try {
        const { A, B } = pair(mm);
        await e.identity.bind(A, { create: { name: '甲方報告' } });
        await e.identity.bind(B, { create: { name: '乙方資料' } });
        const r = await e.collisions.apply({});
        const A2 = r.renamed.find((x) => x.from.toLowerCase() === A.toLowerCase()).to;
        fs.rmSync(A2, { recursive: true, force: true }); // 使用者刪掉（或搬走）改名後的資料夾
        if (recreate) fs.mkdirSync(A); // 又在原位置建了同名、內容無關的新資料夾
        const u = await e.undo(r.undo.sha);
        assert.equal(u.done, true, JSON.stringify(u));
        assert.equal(u.ok, false, '有說明，不是全部照常還原');
        assert.ok(u.notes.some((n) => n.includes(A2)), JSON.stringify(u.notes));
        assert.equal(u.en.notes.length, u.notes.length, '英文 notes 與中文 notes 一一對應');
        assert.ok(u.en.notes.some((n) => n.includes(A2) && /^Could not find the renamed folder /.test(n)), JSON.stringify(u.en.notes));
        assert.equal(/is a different folder and is not bound/.test(u.en.notes.join('\n')), recreate, '原位置另有資料夾時才附加說明');
        assert.deepEqual(u.restored.map((x) => x.to.toLowerCase()), [B.toLowerCase()], '只有真的改回的那筆算還原');
        const bindings = Object.values(JSON.parse(fs.readFileSync(path.join(e.paths.vault, 'machines', e.machine.id, 'bindings.json'), 'utf8')));
        assert.ok(!bindings.some((b) => [A.toLowerCase(), A2.toLowerCase()].includes(b.path.toLowerCase())), `${recreate ? '原位置的新資料夾' : '不存在的資料夾'}沒有綁定`);
        assert.ok(bindings.some((b) => b.path.toLowerCase() === B.toLowerCase()));
        assert.equal((await e.undo(r.undo.sha)).already, true, '整批已結束');
      } finally { rmTmp(root); }
    }
  });

  test('改名對應表：撤銷失敗而停在新名稱的照樣對應；連續改名一路接到最後的位置；已還原的不對應', async () => {
    const root = mkTmp('engram-rp6-');
    try {
      const vault = path.join(root, 'vault');
      const desk = path.join(root, 'Desktop');
      const X = path.join(desk, '甲方報告');
      const X1 = `${X}-k3fz`;
      const X2 = `${X1}-9a2b`;
      const Y = path.join(desk, '乙方資料');
      const Y1 = `${Y}-m7qd`;
      const Z = path.join(desk, '丙方設計');
      const Z1 = `${Z}-p4rt`;
      for (const d of [X2, Y1, Z]) fs.mkdirSync(d, { recursive: true });
      fs.mkdirSync(path.join(vault, 'machines', 'pc'), { recursive: true });
      fs.writeFileSync(path.join(vault, 'machines', 'pc', 'renames.json'), JSON.stringify({
        batches: [
          { id: 'b1', items: [{ from: X, to: X1 }, { from: Y, to: Y1, undoFailed: '資料夾被占用' }, { from: Z, to: Z1, undoneAt: '2026-10-01T00:00:00Z' }] },
          { id: 'b2', items: [{ from: X1, to: X2 }] },
        ],
      }));
      const map = await renamedPathMapper({ vault, mid: 'pc' });
      assert.equal(map(path.join(X, 'a')).toLowerCase(), path.join(X2, 'a').toLowerCase());
      assert.equal(map(X1).toLowerCase(), X2.toLowerCase());
      assert.equal(map(Y).toLowerCase(), Y1.toLowerCase());
      assert.equal(map(Z), Z);
      assert.equal(map(null), null);
    } finally { rmTmp(root); }
  });
});
