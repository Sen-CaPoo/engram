// 收編計畫與執行：來源歸屬（originSessionId、transcript cwd、編碼反推、尾段建議）、範圍建議、舊版本、去重、命名、H05。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { contentPathFor, encodedTail } from '../../src/core/sweep.mjs';
import { applyEdits } from '../../src/migrate/plan.mjs';
import { machineSpecific, suggestScope } from '../../src/core/classify.mjs';
import { encodeProjectPath } from '../../src/core/paths.mjs';
import { isLink } from '../../src/core/fsx.mjs';
import { cleanupFootprint } from '../../src/core/identity.mjs';
import { addTranscript, age, machinePaths, makeRepo, memoryText, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

let root; let m; let eg;
const mem = (dir, file, opts) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), memoryText(opts)); };

before(async () => {
  root = mkTmp();
  const cli = writeDriverCli(root);
  m = machinePaths(root, 'pc');
  await init({ ...m, machineLabel: '公司電腦', cli });
  eg = await open(m);
});
after(() => rmTmp(root));

describe('範圍判斷規則（依真實資料演練校正）', () => {
  test('只提到磁碟路徑 → 仍是專案', () => {
    assert.equal(suggestScope({ type: 'project', text: '檔案放在 C:\\Users\\x\\Desktop\\line\\site' }).scope, 'project');
  });
  test('安裝位置＋路徑、或「這台電腦」→ 單機；單獨的「本機」不算', () => {
    assert.equal(suggestScope({ type: 'project', text: '已安裝在 C:\\tools\\cua' }).scope, 'machine');
    assert.equal(suggestScope({ type: 'reference', text: '這台電腦的網路設定' }).scope, 'machine');
    assert.equal(suggestScope({ type: 'project', text: '本機 OfficeCLI 的版本' }).scope, 'project');
  });
  test('type=user 一律全域，不判成單機；feedback 先留在專案', () => {
    assert.equal(suggestScope({ type: 'user', text: '使用者在這台電腦用 Windows 11' }).scope, 'global');
    assert.equal(machineSpecific({ type: 'user', text: '本機' }).yes, false);
    assert.equal(suggestScope({ type: 'feedback', text: '簡報用圖大於表大於文' }).scope, 'project');
  });
  test('回歸（第二輪演練）：「本機」當 local 用的專案記憶不可判成單機', () => {
    // 合成案例：模仿真實資料中被誤判的句型，不含任何真實內容
    const projectLike = [
      '首頁改版已實作完成並本機驗證；含動畫瘦身與 C:\\work\\site\\src 的修正',
      'PM 任務頁改版已開 PR；本機驗證流程記在 docs',
      '統計頁 AI 分類已實作並本機全驗證；色票驗證結論',
      '供應商改接另一家模型；含在本機跑 curl 時的編碼陷阱',
      '遙測系統架構與決策；本機開發用 docker compose 起服務',
      '官方帳號監控：在本機跑排程，通知到桌面與聊天室',
      '網站上線方式：site/ 是 git repo，本機預覽用靜態伺服器',
      'BYOK 切換工具設計書：跨平台零安裝，本機測試流程',
      '思考強度選單從哪來；本機實測各模型的結果',
      '一行指令安裝腳本；在本機開發時用 C:\\tmp\\demo 測試',
      '開通信 HTML 寄送實測：本機產生 HTML 後貼到網頁信箱',
      '資料庫與看板的查詢管道，本機用 sqlcmd 連線',
      '此 Windows Git Bash 環境下 heredoc 含三個單引號會解析失敗，改用 Write 工具',
      '查雲端租用戶的方法：MCP 工具壞掉時改用 CLI，路徑 C:\\Program Files\\cli',
      '錄音檔 id 要加前綴；沒有逐字稿時下載音檔本機轉錄（含 DLL 修正）',
    ];
    for (const t of projectLike) assert.equal(machineSpecific({ type: 'project', text: t }).yes, false, t);
  });

  test('回歸：真正只屬於這台電腦的內容判成單機', () => {
    const machineLike = [
      '這台電腦的網路環境基準與優化，還原腳本在 C:\\Users\\x\\net\\restore.ps1',
      '在這台 Windows 機器上跑 benchmark 的環境事實（LibreOffice 路徑）',
      'C 槽寫滿導致 Docker 引擎崩潰；資料碟與備份都在 C 槽',
      'MCP 安裝在 C:\\tools\\demo-mcp，runtime 在 C:\\tools\\runtime',
      '本機安裝的 CLI 版本與路徑 C:\\Users\\x\\.democli',
    ];
    for (const t of machineLike) assert.equal(machineSpecific({ type: 'project', text: t }).yes, true, t);
  });

  test('編碼尾段', () => {
    assert.equal(encodedTail('C--Users-Someone-Desktop-Github---------Demo-Dashboard', 'C:\\Users\\Someone'), 'Demo-Dashboard');
    assert.equal(encodedTail('C--Users-Someone-Desktop-QA', 'C:\\Users\\Someone'), 'QA');
  });

  test('SW-3：內文提到的資料夾（中文句子緊接標點、相對家目錄、提到裡面的檔案）', () => {
    const home = 'C:\\Users\\Someone';
    const enc4 = encodeProjectPath('C:\\Users\\Someone\\Desktop\\甲方報告');
    const cases = [
      ['簡報在 `C:\\Users\\Someone\\Desktop\\甲方報告\\slides.html`。', enc4, 'C:\\Users\\Someone\\Desktop\\甲方報告'],
      ['「甲方報告」(C:\\Users\\Someone\\Desktop\\甲方報告) 是', enc4, 'C:\\Users\\Someone\\Desktop\\甲方報告'],
      ['成果在 Desktop\\甲方報告\\，主檔是 a.html', enc4, 'C:\\Users\\Someone\\Desktop\\甲方報告'],
      ['description: Desktop/甲方報告:每週更新', enc4, 'C:\\Users\\Someone\\Desktop\\甲方報告'],
      ['~/Desktop/QA/notes.md', 'C--Users-Someone-Desktop-QA', 'C:\\Users\\Someone\\Desktop\\QA'],
      // 編碼相同的兩個不同資料夾 → 無法判斷
      ['C:\\Users\\Someone\\Desktop\\甲方報告 與 C:\\Users\\Someone\\Desktop\\乙方表單', enc4, null],
      // 網址、上層資料夾、編碼不同的路徑都不算
      ['https://example.com/p/2026-03-09', enc4, null],
      ['C:\\Users\\Someone\\Desktop 底下', 'C--Users-Someone-Desktop-QA', null],
      ['C:/Users/Someone/.local/bin/tool.exe', 'C--Users-Someone-Desktop-QA', null],
    ];
    for (const [text, enc, want] of cases) assert.equal(contentPathFor(text, enc, home)?.toLowerCase() ?? null, want?.toLowerCase() ?? null, text);
  });
});

describe('SW-3：撞名與搬家的來源歸屬、空的封存專案、封存專案接上資料夾', () => {
  test('同一個編碼資料夾裡的記憶依內文分回各自的資料夾；內文優先於唯一的對話紀錄與編碼反推；先全部複製再綁定', async () => {
    const r0 = mkTmp('engram-sw3-');
    try {
      const cli = writeDriverCli(r0);
      const mm = machinePaths(r0, 'pc');
      await init({ ...mm, machineLabel: '測試', cli });
      const e = await open(mm);
      const desk = path.join(mm.userHome, 'Desktop');
      // 四個字的資料夾在 Claude Code 內部都編碼成同一個名稱；現存、也是唯一有對話紀錄的只有「丙方資料」
      const live = path.join(desk, '丙方資料');
      fs.mkdirSync(live, { recursive: true });
      const t = addTranscript(mm.claudeHome, live);
      const memDir = path.join(t.dir, 'memory');
      mem(memDir, 'report.md', { name: 'report', description: '報告', body: `簡報在 \`${path.join(desk, '甲方報告', 'slides.html')}\`。` });
      mem(memDir, 'form.md', { name: 'form', description: '表單', body: '追蹤表在 Desktop\\乙方表單\\，下拉選單用名稱範圍。' });
      mem(memDir, 'data.md', { name: 'data', description: '資料' });
      mem(memDir, 'trainer.md', { name: 'trainer', description: '講師', type: 'user', body: '成果檔在 Desktop\\丁方內訓\\。' });
      fs.mkdirSync(path.join(desk, '文件', '乙方表單'), { recursive: true }); // 「乙方表單」搬到了文件底下
      // 六個字的編碼：磁碟上唯一的候選是「甲乙\丙丁戊」，但記憶內文說的是另一個已不存在的資料夾
      fs.mkdirSync(path.join(desk, '甲乙', '丙丁戊'), { recursive: true });
      const enc6 = encodeProjectPath(path.join(desk, '公司內訓教材'));
      assert.equal(enc6, encodeProjectPath(path.join(desk, '甲乙', '丙丁戊')));
      mem(path.join(mm.claudeHome, 'projects', enc6, 'memory'), 'class.md', { name: 'class', description: '課程', body: `教材放在 ${path.join(desk, '公司內訓教材')}\\。` });
      // 同一個記憶資料夾裡沒寫路徑的那筆：其他記憶指向的資料夾和磁碟上同編碼的資料夾不同 → 不可用編碼反推綁過去
      mem(path.join(mm.claudeHome, 'projects', enc6, 'memory'), 'class-pref.md', { name: 'class-pref', description: '講課偏好', type: 'user' });
      // 沒有撞名的記憶資料夾、沒有對話紀錄：沒寫路徑的記憶跟著同資料夾其他記憶指向的資料夾
      const spec = path.join(desk, 'Spec_舊版規格');
      const encSpec = encodeProjectPath(spec);
      mem(path.join(mm.claudeHome, 'projects', encSpec, 'memory'), 'spec.md', { name: 'spec', description: '規格', body: `工作目錄 \`${spec}\\\`。` });
      mem(path.join(mm.claudeHome, 'projects', encSpec, 'memory'), 'spec-style.md', { name: 'spec-style', description: '規格寫法', type: 'reference' });

      const plan = await e.sweepLegacy({ dryRun: true });
      const by = (p) => plan.sources.find((s) => s.resolvedPath?.toLowerCase() === p.toLowerCase());
      const files = (s) => s.items.map((i) => i.file).sort();
      const sLive = by(live);
      assert.equal(sLive.how, 'transcript-cwd');
      assert.deepEqual(files(sLive), ['data.md'], '只有沒寫路徑的那筆歸給現存的資料夾');
      const sReport = by(path.join(desk, '甲方報告'));
      assert.equal(sReport.how, 'content-path');
      assert.equal(sReport.exists, false);
      assert.equal(sReport.target.name, '甲方報告', '用原資料夾名稱，不是「未歸屬（編碼）」');
      assert.equal(sReport.target.archived, true);
      const sForm = by(path.join(desk, '乙方表單'));
      assert.deepEqual(files(sForm), ['form.md']);
      assert.ok(sForm.suggestions.some((x) => x.kind === 'path' && x.path.toLowerCase() === path.join(desk, '文件', '乙方表單').toLowerCase()), '建議搬家後的新位置');
      // 英文版（1.1.0）：每個項目與建議都附 en.reason，中文 reason 不變
      for (const s of plan.sources) {
        for (const it of s.items) assert.ok(it.reason && typeof it.en?.reason === 'string' && it.en.reason, `項目缺英文理由：${it.file}`);
        for (const sg of s.suggestions) assert.ok(sg.reason && typeof sg.en?.reason === 'string' && sg.en.reason, `建議缺英文理由：${sg.kind}`);
      }
      assert.match(sForm.suggestions.find((x) => x.kind === 'path').en.reason, /no longer exists; a folder with the same name is here/);
      const sClass = by(path.join(desk, '公司內訓教材'));
      assert.equal(sClass.how, 'content-path', '內文優先於編碼反推');
      assert.equal(sClass.exists, false);
      assert.ok(!plan.sources.some((s) => s.resolvedPath?.toLowerCase() === path.join(desk, '甲乙', '丙丁戊').toLowerCase()), '不可綁到編碼剛好相同的別的資料夾');
      assert.equal(plan.sources.find((s) => s.encoded === enc6 && !s.resolvedPath)?.how, 'unknown', '有撞名跡象時，沒寫路徑的那筆無法判斷');
      const specSources = plan.sources.filter((s) => s.encoded === encSpec);
      assert.equal(specSources.length, 1, '沒有撞名時，同一個記憶資料夾不拆開');
      assert.deepEqual(files(specSources[0]), ['spec-style.md', 'spec.md']);
      assert.equal(specSources[0].target.name, 'Spec_舊版規格');
      const willArchive = plan.sources.filter((s) => s.target.archived && s.items.some((i) => (i.scope ?? 'project') === 'project')).length;
      assert.equal(plan.totals.archived, willArchive, '封存專案數只算真的會建立的（記憶全進全域的來源不算）');

      const r = await e.sweepLegacy({ dryRun: false, plan });
      assert.deepEqual(r.deferred, [], '同一個編碼資料夾拆成多個來源時，綁定不會被誤判為規劃後有變更');
      assert.ok(isLink(memDir), '現存的資料夾換成 junction');
      const names = (await e.projects.list()).map((p) => p.name).sort();
      assert.deepEqual(names, ['Spec_舊版規格', '丙方資料', '乙方表單', '公司內訓教材', '甲方報告'], '記憶全進全域的來源（丁方內訓、撞名無法判斷的講課偏好）不建立空的封存專案');
      assert.ok(fs.existsSync(path.join(e.paths.vault, 'global', 'trainer.md')));

      const rb = await e.rollbackImport(r.restorePoint);
      assert.equal(rb.ok, true);
      assert.equal(isLink(memDir), false);
      assert.deepEqual(fs.readdirSync(memDir).filter((f) => f !== 'MEMORY.md').sort(), ['data.md', 'form.md', 'report.md', 'trainer.md'], '原本的記憶全部回來');
      assert.equal(fs.existsSync(path.join(e.paths.vault, 'global', 'trainer.md')), false);
      assert.equal((await e.projects.list()).length, 0, '匯入建立的專案都已移除');
    } finally { rmTmp(r0); }
  });

  test('H08「改為單機記憶」放到記憶所屬的那台電腦：內文的主機名稱優先，其次是寫進 vault 的那台；都不知道時不提供一鍵修正', async () => {
    const r0 = mkTmp('engram-h08-');
    try {
      const cli = writeDriverCli(r0);
      const mm = machinePaths(r0, 'pc');
      await init({ ...mm, machineLabel: '公司電腦', cli });
      const e = await open(mm);
      const { git: g } = await import('./helpers.mjs');
      const vault = e.paths.vault;
      // 另一台電腦（家裡電腦）登記在 vault，並寫了一筆提到「這台電腦」的專案記憶
      fs.mkdirSync(path.join(vault, 'machines', 'home-pc0001'), { recursive: true });
      fs.writeFileSync(path.join(vault, 'machines', 'home-pc0001', 'machine.json'), JSON.stringify({ id: 'home-pc0001', label: '家裡電腦', hostname: 'HOMEBOX' }));
      const pdir = path.join(vault, 'projects', 'demo-abcde', 'memory');
      fs.mkdirSync(pdir, { recursive: true });
      fs.writeFileSync(path.join(vault, 'projects', 'demo-abcde', 'project.json'), JSON.stringify({ id: 'demo-abcde', name: 'demo', aliases: [], remotes: [], rootCommits: [], archived: false }));
      fs.writeFileSync(path.join(pdir, 'home-env.md'), memoryText({ name: 'home-env', description: '環境', body: '這台電腦的 Docker 資料碟在 C 槽。' }));
      fs.writeFileSync(path.join(pdir, 'named.md'), memoryText({ name: 'named', description: '主機', body: '在 HOMEBOX 上跑 benchmark。' }));
      fs.writeFileSync(path.join(pdir, 'manual.md'), memoryText({ name: 'manual', description: '手動', body: '這台電腦的網路設定。' }));
      g(vault, 'add', '-A', '--', 'machines/home-pc0001', 'projects/demo-abcde/project.json', 'projects/demo-abcde/memory/home-env.md', 'projects/demo-abcde/memory/named.md');
      g(vault, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--no-verify', '-m', 'engram(home-pc0001): autosave +3');
      // 不是 Engram 寫的 commit：無法判斷是哪台電腦
      g(vault, 'add', '-A', '--', 'projects/demo-abcde/memory/manual.md');
      g(vault, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--no-verify', '-m', 'manual edit');
      // 這台電腦寫的記憶，內文提到另一台的主機名稱 → 以主機名稱為準
      const mine = await e.memories.create({ scope: { kind: 'project', pid: 'demo-abcde' }, name: 'mine', type: 'project', description: '這台', body: '這台電腦裝了 LibreOffice，安裝在 C:\\Tools\\LO。' });
      const other = await e.memories.create({ scope: { kind: 'project', pid: 'demo-abcde' }, name: 'about-home', type: 'project', description: '家裡', body: 'HOMEBOX 的網路設定基準在 C:\\net\\base.ps1。' });

      const h08 = (await e.health()).filter((f) => f.code === 'H08');
      const fixMid = (file) => h08.find((f) => f.refs[0].endsWith(`/${file}`))?.fix?.args?.scope?.mid;
      assert.equal(fixMid('home-env.md'), 'home-pc0001', '家裡電腦寫的 → 家裡電腦的單機範圍，不是執行檢查的這台');
      assert.equal(fixMid('named.md'), 'home-pc0001');
      assert.equal(fixMid(path.posix.basename(mine.ref)), e.machine.id, '這台寫的 → 這台');
      assert.equal(fixMid(path.posix.basename(other.ref)), 'home-pc0001', '內文提到另一台的主機名稱 → 那一台');
      const manual = h08.find((f) => f.refs[0].endsWith('/manual.md'));
      assert.ok(manual, '仍然列出建議');
      assert.equal(manual.fix, undefined, '無法判斷是哪一台時不提供一鍵修正');
      assert.match(h08.find((f) => f.refs[0].endsWith('/home-env.md')).fix.label, /家裡電腦/);
      // 這台電腦把家裡電腦寫的記憶升級為全域（搬移）：歸屬仍是家裡電腦，不算給執行搬移的這台
      const movedRef = (await e.memories.move('projects/demo-abcde/memory/home-env.md', { kind: 'global' })).ref;
      const after = (await e.health()).find((f) => f.code === 'H08' && f.refs[0] === movedRef);
      assert.equal(after?.fix?.args?.scope?.mid, 'home-pc0001');
    } finally { rmTmp(r0); }
  });

  test('另一台電腦匯入時建立的「未歸屬（X）」封存專案：同名的現存資料夾列為建議；採用後恢復為使用中並改用資料夾名稱', async () => {
    const r0 = mkTmp('engram-sw3b-');
    try {
      const cli = writeDriverCli(r0);
      const mm = machinePaths(r0, 'pc');
      await init({ ...mm, machineLabel: '測試', cli });
      const e = await open(mm);
      const ops = path.join(mm.userHome, 'Desktop', 'Ops');
      const enc = encodeProjectPath(ops);
      // 第一次匯入時資料夾不在、也沒有對話紀錄 → 封存專案「未歸屬（Ops）」
      mem(path.join(mm.claudeHome, 'projects', enc, 'memory'), 'runbook.md', { name: 'runbook', description: '值班手冊' });
      const first = await e.sweepLegacy({ dryRun: false, plan: await e.sweepLegacy({ dryRun: true }) });
      assert.equal(first.ok, true);
      const archived = (await e.projects.list()).find((p) => p.name === '未歸屬（Ops）');
      assert.ok(archived?.archived);
      // 之後資料夾出現了（例如在這台電腦），有對話紀錄與新的記憶
      fs.mkdirSync(ops, { recursive: true });
      const t = addTranscript(mm.claudeHome, ops);
      mem(path.join(t.dir, 'memory'), 'oncall.md', { name: 'oncall', description: '輪值' });
      const plan = await e.sweepLegacy({ dryRun: true });
      const s = plan.sources.find((x) => x.resolvedPath?.toLowerCase() === ops.toLowerCase());
      assert.equal(s.target.isNew, true, '只建議、不自動連結');
      assert.ok(s.suggestions.some((x) => x.kind === 'project' && x.pid === archived.pid), '建議連到同名的封存專案');
      assert.match(s.suggestions.find((x) => x.pid === archived.pid).en.reason, /^Same name as the archived project "未歸屬（Ops）"/);
      const r = await e.sweepLegacy({ dryRun: false, plan: applyEdits(plan, { targets: { [s.encoded]: { pid: archived.pid } } }) });
      assert.deepEqual(r.deferred, []);
      const p = (await e.projects.list()).find((x) => x.pid === archived.pid);
      assert.equal(p.archived, false, '接上資料夾後恢復為使用中');
      assert.equal(p.name, 'Ops', '暫定名稱換成資料夾名稱');
      assert.ok(fs.existsSync(path.join(e.paths.vault, 'projects', archived.pid, 'memory', 'oncall.md')));
    } finally { rmTmp(r0); }
  });
});

describe('收編計畫與執行', () => {
  let plan; let live; let orphanNew; let orphanOld; let tails;
  before(() => {
    // 1. 仍存在的專案（transcript 有 cwd）
    live = makeRepo(path.join(m.userHome, 'Desktop', 'Gateway'));
    const tl = addTranscript(m.claudeHome, live);
    mem(path.join(tl.dir, 'memory'), 'user-context.md', { name: 'user-context', description: '使用者背景', type: 'user' });
    mem(path.join(tl.dir, 'memory'), 'deploy.md', { name: 'deploy', description: '部署', body: '新版內容' });
    fs.writeFileSync(path.join(tl.dir, 'memory', 'deploy.md'), fs.readFileSync(path.join(tl.dir, 'memory', 'deploy.md'), 'utf8').replace('2026-10-01', '2026-10-15'));
    fs.writeFileSync(path.join(tl.dir, 'memory', 'MEMORY.md'), '- [部署](deploy.md) — 原本的提示語\n');
    // 2. 改名前的舊資料夾（已不存在）：同名較舊的 deploy → superseded；相同內容的 user-context → skip-same
    orphanOld = path.join(m.userHome, 'Desktop', 'Gateway_Old');
    const to = addTranscript(m.claudeHome, orphanOld);
    mem(path.join(to.dir, 'memory'), 'deploy.md', { name: 'deploy', description: '部署', body: '舊版內容' });
    mem(path.join(to.dir, 'memory'), 'user-context.md', { name: 'user-context', description: '使用者背景', type: 'user' });
    mem(path.join(to.dir, 'memory'), 'only-old.md', { name: 'only-old', description: '只有舊資料夾有' });
    // 3. 同名但不同層的資料夾 → 名稱自動加上上層資料夾
    orphanNew = makeRepo(path.join(m.userHome, 'Desktop', 'WP', 'Gateway'));
    const tn = addTranscript(m.claudeHome, orphanNew);
    mem(path.join(tn.dir, 'memory'), 'wp-note.md', { name: 'wp-note', description: 'WP 筆記' });
    // 4. 沒有 transcript、資料夾也不在：編碼尾段 → 建議連結（不自動）
    tails = 'C--Users-Someone-Desktop-Github---------gateway';
    mem(path.join(m.claudeHome, 'projects', tails, 'memory'), 'tail-note.md', { name: 'tail-note', description: '尾段' });
  });

  test('計畫：來源歸屬、目標、動作、建議', async () => {
    plan = await eg.sweepLegacy({ dryRun: true });
    const src = (p) => plan.sources.find((s) => s.resolvedPath && s.resolvedPath.toLowerCase() === p.toLowerCase());
    const sLive = src(live);
    assert.equal(sLive.how, 'transcript-cwd');
    assert.equal(sLive.exists, true);
    assert.equal(sLive.target.isNew, true);
    const item = (s, f) => s.items.find((i) => i.file === f);
    assert.equal(item(sLive, 'user-context.md').scope, 'global');
    assert.equal(item(sLive, 'deploy.md').action, 'copy');
    const sOld = src(orphanOld);
    assert.equal(sOld.exists, false);
    assert.equal(item(sOld, 'deploy.md').action, 'superseded', '較舊版本不複製');
    assert.equal(item(sOld, 'user-context.md').action, 'skip-same');
    assert.equal(item(sOld, 'only-old.md').action, 'copy');
    const sNew = src(orphanNew);
    assert.equal(sNew.target.name, 'Gateway（WP）', '同名專案加上上層資料夾');
    const sTail = plan.sources.find((s) => s.encoded === tails);
    assert.equal(sTail.how, 'unknown');
    assert.equal(sTail.target.archived, true);
    assert.ok(sTail.suggestions.length >= 1, '尾段比對產生建議');
    assert.ok(plan.totals.superseded >= 1);
  });

  test('執行：複製、建立 junction、原資料夾備份；H05 不再回報已收編的檔案', async () => {
    const r = await eg.sweepLegacy({ dryRun: false, plan });
    assert.equal(r.ok, true);
    assert.ok(r.copied >= 4);
    const encLive = encodeProjectPath(live);
    assert.ok(isLink(path.join(m.claudeHome, 'projects', encLive, 'memory')), '仍存在的來源換成 junction');
    const pLive = (await eg.projects.list()).find((p) => p.name === 'Gateway');
    const idx = fs.readFileSync(path.join(eg.paths.vault, 'projects', pLive.pid, 'memory', 'MEMORY.md'), 'utf8');
    assert.match(idx, /原本的提示語/);
    assert.ok(fs.existsSync(path.join(eg.paths.vault, 'global', 'user-context.md')), 'user 類型進全域');
    assert.equal(fs.existsSync(path.join(eg.paths.vault, 'projects', pLive.pid, 'memory', 'user-context.md')), false, '收編時不重複複製到專案');
    const findings = await eg.health();
    assert.equal(findings.filter((f) => f.code === 'H05').length, 0, '已收編、內容沒變的檔案不再出現 H05');
    // 孤兒來源的原檔仍在原處
    const encOld = encodeProjectPath(orphanOld);
    assert.ok(fs.existsSync(path.join(m.claudeHome, 'projects', encOld, 'memory', 'deploy.md')));
    plan.result = r;
  });

  test('一鍵還原（多個來源、sweep 與 bind commit 交錯）：原資料夾回來、導入後的新記憶不遺失', async () => {
    const encLive = encodeProjectPath(live);
    const memDir = path.join(m.claudeHome, 'projects', encLive, 'memory');
    // 導入後透過 junction 新寫一筆
    fs.writeFileSync(path.join(memDir, 'after-import.md'), memoryText({ name: 'after-import', description: '導入後才寫' }));
    const before = await eg.projects.list();
    assert.ok(before.length >= 3);
    const rb = await eg.rollbackImport(plan.result.restorePoint);
    assert.equal(rb.ok, true);
    assert.equal(isLink(memDir), false, 'junction 已換回一般資料夾');
    assert.ok(fs.existsSync(path.join(memDir, 'deploy.md')), '原本的記憶回來了');
    assert.ok(fs.existsSync(path.join(memDir, 'after-import.md')), '導入後的新記憶已複製回原資料夾');
    assert.equal(fs.existsSync(path.join(eg.paths.vault, 'global', 'user-context.md')), false, '導入的全域記憶已移除');
    const settings = path.join(m.claudeHome, 'settings.json');
    if (fs.existsSync(settings)) {
      const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
      assert.ok(!(s.permissions?.additionalDirectories ?? []).some((p) => p.toLowerCase() === memDir.toLowerCase()));
    }
    const bindings = JSON.parse(fs.readFileSync(path.join(eg.paths.vault, 'machines', eg.machine.id, 'bindings.json'), 'utf8'));
    assert.equal(Object.keys(bindings).length, 0, '匯入建立的綁定都已移除');
  });
});

describe('匯入中途失敗', () => {
  test('失敗那一步的未提交檔案被撤銷、錯誤附上還原點、還原後 vault 不留下任何匯入內容', async () => {
    const r0 = mkTmp('engram-fail-');
    try {
      const cli = writeDriverCli(r0);
      const mm = machinePaths(r0, 'pc');
      await init({ ...mm, machineLabel: '測試', cli });
      const e = await open(mm);
      const one = makeRepo(path.join(mm.userHome, 'Desktop', 'one'));
      const t1 = addTranscript(mm.claudeHome, one);
      mem(path.join(t1.dir, 'memory'), 'first.md', { name: 'first', description: '第一個來源' });
      const two = makeRepo(path.join(mm.userHome, 'Desktop', 'two'));
      const t2 = addTranscript(mm.claudeHome, two);
      mem(path.join(t2.dir, 'memory'), 'second.md', { name: 'second', description: '第二個來源' });
      mem(path.join(t2.dir, 'memory'), 'pref.md', { name: 'pref', description: '偏好', type: 'user' });
      const plan = await e.sweepLegacy({ dryRun: true });
      // vault 的 pre-commit hook：第二個來源的 sweep commit 失敗
      const hook = path.join(e.paths.vault, '.git', 'hooks', 'pre-commit');
      fs.writeFileSync(hook, '#!/bin/sh\ngit diff --cached --name-only | grep -q "second.md" && exit 1\nexit 0\n');
      fs.chmodSync(hook, 0o755);
      let err;
      try { await e.sweepLegacy({ dryRun: false, plan }); } catch (x) { err = x; }
      assert.ok(err, '應該失敗');
      assert.match(String(err.restorePoint), /^engram-import-/);
      const { git: g } = await import('./helpers.mjs');
      const dirty = g(e.paths.vault, 'status', '--porcelain', '--untracked-files=all');
      assert.doesNotMatch(dirty, /second\.md|pref\.md/, '失敗那一步寫的檔案不留在工作目錄');
      fs.rmSync(hook);
      await e.rollbackImport(err.restorePoint);
      assert.equal((await e.memories.list()).length, 0, '還原後 vault 沒有匯入的記憶');
      assert.ok(fs.existsSync(path.join(t1.dir, 'memory', 'first.md')), '第一個來源的原記憶回來了');
      assert.equal(isLink(path.join(t1.dir, 'memory')), false);
    } finally { rmTmp(r0); }
  });
});

describe('R-47／R-48：還原保留最新內容、不留足跡', () => {
  test('M6：匯入含金鑰的記憶（被扣住、沒有 commit）→ 一鍵還原後 vault 不留下複本，原記憶回到原處', async () => {
    const r0 = mkTmp('engram-held-');
    try {
      const mm = machinePaths(r0, 'pc');
      await init({ ...mm, machineLabel: '測試', cli: writeDriverCli(r0) });
      const e = await open(mm);
      const token = `ghp_${'Pq8Rs6Tu4V'.repeat(4)}`;
      const one = makeRepo(path.join(mm.userHome, 'Desktop', 'one'));
      const t1 = addTranscript(mm.claudeHome, one);
      mem(path.join(t1.dir, 'memory'), 'ci.md', { name: 'ci', description: 'CI 設定', body: `權杖：${token}` });
      mem(path.join(t1.dir, 'memory'), 'pref.md', { name: 'pref', description: '偏好', type: 'user', body: `個人權杖 ${token}` });
      mem(path.join(t1.dir, 'memory'), 'plain.md', { name: 'plain', description: '一般記憶' });
      const res = await e.sweepLegacy({ dryRun: false });
      const { git: g } = await import('./helpers.mjs');
      assert.ok(!g(e.paths.vault, 'log', '--all', '-p').includes(token), '含金鑰的檔案不進 git 歷史');
      await e.rollbackImport(res.restorePoint);
      const left = g(e.paths.vault, 'status', '--porcelain', '--untracked-files=all');
      assert.doesNotMatch(left, /ci\.md|pref\.md|plain\.md/, `還原後 vault 不留下匯入的檔案：${left}`);
      assert.equal((await e.memories.list()).length, 0);
      for (const f of ['ci.md', 'pref.md', 'plain.md']) assert.ok(fs.existsSync(path.join(t1.dir, 'memory', f)), `${f} 回到原處`);
      assert.ok(fs.readFileSync(path.join(t1.dir, 'memory', 'ci.md'), 'utf8').includes(token), '原記憶內容不變');
    } finally { rmTmp(r0); }
  });

  test('cleanupFootprint：exclude 逐位元還原、原本存在的設定檔寫回原內容', async () => {
    const r0 = mkTmp('engram-fp-');
    try {
      const repo = makeRepo(path.join(r0, 'r'));
      const ex = path.join(repo, '.git', 'info', 'exclude');
      const orig = '# 原本的內容\n*.log';
      fs.writeFileSync(ex, `${orig}\n# Engram：本機設定不進 repo\n/.claude/settings.local.json\n`);
      fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
      const settingsOrig = '{\n    "permissions": { "allow": ["Bash(ls)"] }\n}';
      fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, autoMemoryDirectory: '~/.engram/vault/projects/x/memory' }, null, 2));
      await cleanupFootprint(repo, { excludeAdded: true, excludeOriginal: orig, settingsCreated: false, settingsOriginal: settingsOrig, claudeDirCreated: false });
      assert.equal(fs.readFileSync(ex, 'utf8'), orig);
      assert.equal(fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8'), settingsOrig);
    } finally { rmTmp(r0); }
  });

  test('匯入後改過的記憶在還原後保留最新版（舊版另存 .pre-rollback）；撞名資料夾的設定檔與 exclude 行完全移除', async () => {
    const r0 = mkTmp('engram-rb-');
    try {
      const cli = writeDriverCli(r0);
      const mm = machinePaths(r0, 'pc');
      await init({ ...mm, machineLabel: '測試', cli });
      const e = await open(mm);
      // 一般 git 專案（junction）
      const app = makeRepo(path.join(mm.userHome, 'Desktop', 'shop'));
      const ta = addTranscript(mm.claudeHome, app);
      mem(path.join(ta.dir, 'memory'), 'rule.md', { name: 'rule', description: '規則', body: 'v1' });
      // 撞名的兩個資料夾（設定檔備援）；其中一個是 git repo，原本沒有 .claude
      const a = makeRepo(path.join(mm.userHome, 'Desktop', '甲方專案'));
      const b = path.join(mm.userHome, 'Desktop', '乙方專案');
      fs.mkdirSync(b, { recursive: true });
      const tA = addTranscript(mm.claudeHome, a, { sessionId: 'sa' });
      addTranscript(mm.claudeHome, b, { sessionId: 'sb' });
      mem(path.join(tA.dir, 'memory'), 'a-note.md', { name: 'a-note', description: '甲方', originSessionId: 'sa' });
      const excludeBefore = fs.readFileSync(path.join(a, '.git', 'info', 'exclude'), 'utf8');
      const plan = await e.sweepLegacy({ dryRun: true });
      const res = await e.sweepLegacy({ dryRun: false, plan });
      // 匯入後透過 junction 修改
      const memDir = path.join(ta.dir, 'memory');
      fs.writeFileSync(path.join(memDir, 'rule.md'), memoryText({ name: 'rule', description: '規則', body: 'v2' }));
      age(path.join(memDir, 'rule.md'));
      await e.sync({ network: false });
      await e.rollbackImport(res.restorePoint);
      assert.match(fs.readFileSync(path.join(memDir, 'rule.md'), 'utf8'), /v2/, '保留匯入後的修改');
      assert.match(fs.readFileSync(path.join(memDir, 'rule.md.pre-rollback'), 'utf8'), /v1/, '匯入前的版本另存');
      assert.equal(fs.existsSync(path.join(a, '.claude')), false, '甲方專案：Engram 建立的 .claude 與設定檔都移除');
      assert.equal(fs.readFileSync(path.join(a, '.git', 'info', 'exclude'), 'utf8'), excludeBefore, 'exclude 逐位元回到匯入前');
    } finally { rmTmp(r0); }
  });
});
