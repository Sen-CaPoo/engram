// /engram 技能用的 CLI（inbox、memory、core、undo）：用真引擎在暫存資料夾測試讀取、遮蔽、確認、版本比對與復原。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { main } from '../../src/cli/main.mjs';
import { quarantine } from '../../src/core/conflicts.mjs';
import { init, open } from '../../src/core/index.mjs';
import { machinePaths, makeRepo, memoryText, mkTmp, rmTmp, writeDriverCli } from '../core/helpers.mjs';
import { capture, stdinFrom } from './helpers.mjs';

// 測試用的假金鑰（格式符合 GitHub 權杖，但不是真的）
const SECRET = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

let root; let m; let eg; let pid; let prevHome;

before(async () => {
  root = mkTmp('engram-ai-cli-');
  m = machinePaths(root, 'office');
  // --file 的草稿資料夾在 ENGRAM_HOME 底下：指向暫存資料夾，不碰真正的 ~/.engram
  prevHome = process.env.ENGRAM_HOME;
  process.env.ENGRAM_HOME = m.home;
  await init({ ...m, machineLabel: '公司電腦', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
  const repo = makeRepo(path.join(root, 'demo-repo'), { remote: 'https://github.com/example/demo.git' });
  pid = (await eg.identity.bind(repo, { create: { name: '示範專案' } })).pid;
});
after(() => {
  if (prevHome === undefined) delete process.env.ENGRAM_HOME; else process.env.ENGRAM_HOME = prevHome;
  rmTmp(root);
});

// env：預設是乾淨的環境（測試本身在 Claude Code 裡執行，CLAUDECODE 會讓 engram not-secret 拒絕）
async function engram(argv, { stdin, env = {} } = {}) {
  const out = capture();
  const err = capture();
  const code = await main(argv, { loadEngine: async () => eg, stdout: out.stream, stderr: err.stream, stdin: stdin ? stdinFrom(stdin) : { isTTY: true }, cwd: root, env });
  return { code, out: out.text, err: err.text, all: out.text + err.text };
}
const json = async (argv, o) => { const r = await engram([...argv, '--json'], o); return { ...r, data: JSON.parse(r.out) }; };
const vaultFile = (ref) => path.join(eg.paths.vault, ...ref.split('/'));
/** 模擬 Claude Code 直接寫進記憶資料夾：含金鑰的記憶只會從這裡進來（引擎的寫入 API 會拒絕） */
function plant(ref, text) {
  fs.mkdirSync(path.dirname(vaultFile(ref)), { recursive: true });
  fs.writeFileSync(vaultFile(ref), text);
  return { ref };
}
const cardOf = async (code, ref) => (await json(['inbox', '--all'])).data.findings.find((f) => f.code === code && (!ref || f.refs.includes(ref)));

describe('engram inbox', () => {
  test('列出卡片；H13 的說明不帶金鑰片段；show 的內容一律遮蔽', async () => {
    const leak = plant('global/api-token-note.md', memoryText({ name: 'api-token-note', description: '測試用的權杖筆記', type: 'reference', body: `權杖：${SECRET}\n存在 Windows 認證管理員。` }));
    const list = await engram(['inbox']);
    assert.equal(list.code, 0);
    assert.match(list.out, /收件匣：衝突 0/);
    assert.match(list.out, /H13:[0-9a-f]{10}\s+「api-token-note」疑似含有金鑰或密碼/);
    assert.ok(!list.out.includes(SECRET.slice(0, 4) + '…'), '列表不可以帶出金鑰前幾個字元');
    const card = await cardOf('H13', leak.ref);
    assert.doesNotMatch(card.detail, /ghp_/);
    const shown = await engram(['inbox', 'show', card.id]);
    assert.equal(shown.code, 0);
    assert.ok(!shown.all.includes(SECRET) && !shown.all.includes('ghp_'), 'show 不可以輸出金鑰');
    assert.match(shown.out, /‹已遮蔽：github-token›/);
    assert.match(shown.out, /已遮蔽 1 處疑似金鑰/);
    const js = await json(['inbox', 'show', card.id]);
    assert.ok(!JSON.stringify(js.data).includes('ghp_'), 'JSON 也不可以輸出金鑰');
    assert.equal(js.data.fixes[0].needsYes, true);
  });

  test('M1：卡片說明裡的原文（H12 的 frontmatter 錯誤會附上那一行）也遮蔽；索引不帶金鑰；status 的遠端網址遮蔽', async () => {
    const bad = plant('global/broken-key.md', `---\nname: broken-key\ndescription: "LiteLLM 金鑰" ${SECRET}\nmetadata:\n  type: reference\n---\n\n內文\n`);
    const card = (await json(['inbox', '--all'])).data.findings.find((f) => f.code === 'H12' && f.refs.includes(bad.ref));
    assert.ok(card, '應該出現 H12');
    for (const argv of [['inbox'], ['inbox', '--json'], ['inbox', 'show', card.id], ['inbox', 'show', card.id, '--json']]) {
      const r = await engram(argv);
      assert.ok(!r.all.includes('ghp_'), `${argv.join(' ')} 不可以輸出金鑰`);
    }
    fs.rmSync(vaultFile(bad.ref));
    // 說明含金鑰的記憶（Claude Code 直接寫進來的）：產生的索引先遮蔽
    plant('global/desc-token.md', memoryText({ name: 'desc-token', type: 'reference', description: `說明裡有 ${SECRET}`, body: '內文' }));
    await eg.normalize();
    assert.ok(!fs.readFileSync(vaultFile('global/INDEX.md'), 'utf8').includes('ghp_'), '全域索引不可以帶金鑰');
    fs.rmSync(vaultFile('global/desc-token.md'));
    await eg.normalize();
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['remote', 'add', 'origin', `https://sen:${SECRET}@github.com/example/engram-vault.git`], { cwd: eg.paths.vault });
    try {
      for (const argv of [['status'], ['status', '--json']]) assert.ok(!(await engram(argv)).all.includes('ghp_'), `${argv.join(' ')} 不可以輸出網址裡的權杖`);
    } finally {
      execFileSync('git', ['remote', 'remove', 'origin'], { cwd: eg.paths.vault });
    }
  });

  test('M7：核心準則含金鑰 → 出現 H13；engram core 的輸出遮蔽；apply --yes 在本機遮蔽', async () => {
    const original = (await eg.core.read()).text;
    fs.writeFileSync(vaultFile('core/CORE.md'), `${original}\n- CI 權杖：${SECRET}\n`);
    const card = (await json(['inbox'])).data.findings.find((f) => f.code === 'H13' && f.refs.includes('core/CORE.md'));
    assert.ok(card, '核心準則也要掃描');
    assert.ok(!(await engram(['core'])).all.includes('ghp_'), 'engram core 不可以輸出金鑰');
    assert.ok(!(await engram(['inbox', 'show', card.id])).all.includes('ghp_'));
    assert.equal((await engram(['inbox', 'apply', card.id])).code, 1, '要 --yes');
    const r = await engram(['inbox', 'apply', card.id, '--yes']);
    assert.equal(r.code, 0, r.err);
    const after = fs.readFileSync(vaultFile('core/CORE.md'), 'utf8');
    assert.ok(!after.includes(SECRET) && after.includes('‹已遮蔽：github-token›'));
    await eg.core.write(original);
  });

  test('H13：沒有 --yes 不動；--yes 在本機遮蔽，檔案裡不再有金鑰', async () => {
    const card = await cardOf('H13');
    const no = await engram(['inbox', 'apply', card.id]);
    assert.equal(no.code, 1);
    assert.match(no.err, /E_CONFIRM/);
    assert.ok(fs.readFileSync(vaultFile(card.refs[0]), 'utf8').includes(SECRET));
    const yes = await engram(['inbox', 'apply', card.id, '--yes']);
    assert.equal(yes.code, 0, yes.err);
    const after = fs.readFileSync(vaultFile(card.refs[0]), 'utf8');
    assert.ok(!after.includes(SECRET));
    assert.match(after, /‹已遮蔽：github-token›/);
  });

  test('M5：寫回遮蔽後的內容會換掉金鑰 → 拒絕；remember 含金鑰 → 拒絕，使用者確認後 --not-secret 才寫入', async () => {
    const mem = plant('global/vendor-key.md', memoryText({ name: 'vendor-key', description: '廠商金鑰', type: 'reference', body: `金鑰：${SECRET}\n用在報表匯出。` }));
    const { data } = await json(['memory', 'show', mem.ref]);
    assert.match(data.text, /‹已遮蔽：github-token›/);
    const back = data.text.replace('用在報表匯出。', '用在報表匯出與對帳。');
    const r = await engram(['memory', 'write', mem.ref, '--base', data.rev], { stdin: back });
    assert.equal(r.code, 1);
    assert.match(r.err, /會把原本的疑似金鑰換掉/);
    assert.ok(fs.readFileSync(vaultFile(mem.ref), 'utf8').includes(SECRET), '被拒絕時原檔不動');
    const split = await engram(['remember', '--scope', 'global', '--name', 'vendor-key-part', '--type', 'reference', '--description', '拆分'], { stdin: '金鑰：‹已遮蔽：github-token›' });
    assert.equal(split.code, 1, '新記憶也不可以帶入遮蔽標記（拆分時金鑰會不見）');
    const held = await engram(['remember', '--scope', 'global', '--name', 'new-key', '--type', 'reference', '--description', '新的金鑰'], { stdin: `另一組：${SECRET}` });
    assert.equal(held.code, 1);
    assert.match(held.err, /疑似含有金鑰.*不會寫入（E_SECRET）/);
    assert.ok(!fs.existsSync(vaultFile('global/new-key.md')));
    const { execFileSync } = await import('node:child_process');
    assert.ok(!execFileSync('git', ['log', '--all', '-p'], { cwd: eg.paths.vault, encoding: 'utf8' }).includes(SECRET), '金鑰不可以進 git 歷史');
    // 說明裡的金鑰也一樣
    const inDesc = await engram(['remember', '--scope', 'global', '--name', 'desc-key', '--type', 'reference', '--description', `金鑰 ${SECRET}`], { stdin: '內文沒有金鑰' });
    assert.equal(inDesc.code, 1);
    // 使用者確認不是金鑰（例如文件裡的範例字串）：engram not-secret 記入清單（由使用者核准的獨立指令），再寫一次
    const SAMPLE = `ghp_${'Sa1Mp2Le3X'.repeat(4)}`;
    assert.equal((await engram(['remember', '--scope', 'global', '--name', 'sample-key', '--type', 'reference', '--description', '文件範例'], { stdin: `範例：${SAMPLE}` })).code, 1);
    assert.equal((await engram(['remember', '--scope', 'global', '--name', 'sample-key', '--type', 'reference', '--description', '文件範例', '--not-secret'], { stdin: `範例：${SAMPLE}` })).code, 2, 'remember 沒有 --not-secret 旗標');
    // 「不是金鑰」是使用者本人的確認：在 Claude Code 裡執行一律拒絕（auto、bypass 模式下 Claude Code 不一定會詢問）
    const inClaude = await engram(['not-secret', '--value', SAMPLE], { env: { CLAUDECODE: '1' } });
    assert.equal(inClaude.code, 1);
    assert.match(inClaude.err, /不能在 Claude Code 裡執行/);
    assert.equal((await engram(['not-secret', '--value', SAMPLE], { env: { CLAUDECODE: '' } })).code, 1, '設成空字串也一樣拒絕');
    assert.equal((await engram(['not-secret', '--value', 'password'])).code, 1, '不會被判定的一般單字不收');
    const ns = await engram(['not-secret', '--value', SAMPLE]);
    assert.equal(ns.code, 0, ns.err);
    assert.ok(!ns.out.includes(SAMPLE), '輸出不重複完整的值');
    const ok = await engram(['remember', '--scope', 'global', '--name', 'sample-key', '--type', 'reference', '--description', '文件範例'], { stdin: `範例：${SAMPLE}` });
    assert.equal(ok.code, 0, ok.err);
    assert.equal((await engram(['not-secret'])).code, 2, '要指定 --value 或 <ref> --line');
    // 標錯時可以撤銷：列出清單、移除後這個值重新被當成金鑰
    const listed = await json(['not-secret', '--list']);
    const entry = listed.data.find((x) => x.preview.startsWith(SAMPLE.slice(0, 4)));
    assert.ok(entry && !JSON.stringify(listed.data).includes(SAMPLE), '清單只有雜湊與預覽');
    assert.equal((await engram(['not-secret', '--remove', entry.hash])).code, 0);
    assert.equal((await engram(['remember', '--scope', 'global', '--name', 'sample-key-2', '--type', 'reference', '--description', '文件範例'], { stdin: `範例：${SAMPLE}` })).code, 1, '撤銷後重新擋下');
    // 既有檔案的某一行：engram not-secret <ref> --line（用另一組值，清單不分檔案，不要影響其他測試的假金鑰）
    const LINE_TOKEN = `ghp_${'Ln4Tk6Ex8Y'.repeat(4)}`;
    const other = plant('global/line-token.md', memoryText({ name: 'line-token', type: 'reference', description: '範例', body: `範例：${LINE_TOKEN}` }));
    const line = (await eg.memories.read(other.ref)).secretRanges[0].line;
    const byLine = await engram(['not-secret', other.ref, '--line', String(line)]);
    assert.equal(byLine.code, 0, byLine.err);
    assert.equal((await eg.memories.read(other.ref)).secretRanges.length, 0);
    await eg.memories.remove(other.ref);
    fs.rmSync(vaultFile(mem.ref));
    await eg.memories.remove('global/sample-key.md');
  });

  test('H09 升級全域：先要求確認，--yes 後移動並附復原指令；engram undo 移回原處', async () => {
    const mem = await eg.memories.create({ scope: { kind: 'project', pid }, name: 'prefers-tables', type: 'feedback', description: '回報一律用表格', body: '回報一律用表格。' });
    const card = await cardOf('H09', mem.ref);
    assert.ok(card, '應該出現 H09');
    const show = await engram(['inbox', 'show', card.id]);
    assert.match(show.out, /把 projects\/.+\/prefers-tables\.md 移到全域（所有專案都會讀到）/);
    assert.match(show.out, new RegExp(`engram inbox apply ${card.id} --yes`));
    const no = await engram(['inbox', 'apply', card.id]);
    assert.equal(no.code, 1);
    assert.ok(fs.existsSync(vaultFile(mem.ref)));
    const yes = await engram(['inbox', 'apply', card.id, '--yes']);
    assert.equal(yes.code, 0, yes.err);
    assert.ok(fs.existsSync(vaultFile('global/prefers-tables.md')));
    const sha = /engram undo ([0-9a-f]{7,})/.exec(yes.out)?.[1];
    assert.ok(sha, yes.out);
    const undo = await engram(['undo', sha]);
    assert.equal(undo.code, 0, undo.err);
    assert.ok(fs.existsSync(vaultFile(mem.ref)));
    assert.ok(!fs.existsSync(vaultFile('global/prefers-tables.md')));
  });

  test('H07 合併：apply 指出要先寫內容；memory merge 只給內文時保留 frontmatter', async () => {
    const a = await eg.memories.create({ scope: { kind: 'global' }, name: 'node-version', type: 'reference', description: '專案用 Node 22', body: '專案用 Node 22。' });
    const b = await eg.memories.create({ scope: { kind: 'global' }, name: 'node-version-2', type: 'reference', description: '專案用 Node 22', body: '專案用 Node 22，npm 10。' });
    const card = (await json(['inbox'])).data.findings.find((f) => f.code === 'H07' && f.refs.includes(a.ref) && f.refs.includes(b.ref));
    assert.ok(card, '應該出現 H07');
    const apply = await engram(['inbox', 'apply', card.id, '--yes']);
    assert.equal(apply.code, 1);
    assert.match(apply.err, /E_NEEDS_CONTENT/);
    assert.match(apply.err, /engram memory merge/);
    const show = await json(['inbox', 'show', card.id]);
    const revs = card.refs.map((r) => show.data.memories.find((x) => x.ref === r).rev);
    const bad = await engram(['memory', 'merge', ...card.refs, '--into', a.ref, '--base', revs[0]], { stdin: '專案用 Node 22，npm 10。\n' });
    assert.equal(bad.code, 2, '--base 數量不符要拒絕');
    const r = await engram(['memory', 'merge', ...card.refs, '--into', a.ref, '--base', revs.join(',')], { stdin: '專案用 Node 22，npm 10。\n' });
    assert.equal(r.code, 0, r.err);
    const merged = await eg.memories.read(a.ref);
    assert.equal(merged.frontmatter.name, 'node-version');
    assert.equal(merged.frontmatter.metadata.type, 'reference');
    assert.match(merged.body, /npm 10/);
    assert.ok(!fs.existsSync(vaultFile(b.ref)));
  });

  test('合併：--into 必須是其中一筆；以 --- 開頭卻少了結尾的內容拒絕；不能單獨復原的修正不印 engram undo', async () => {
    const a = await eg.memories.create({ scope: { kind: 'global' }, name: 'into-a', type: 'reference', description: 'A', body: 'A' });
    const b = await eg.memories.create({ scope: { kind: 'global' }, name: 'into-b', type: 'reference', description: 'B', body: 'B' });
    const c = await eg.memories.create({ scope: { kind: 'global' }, name: 'into-c', type: 'reference', description: 'C', body: 'C' });
    const outside = await engram(['memory', 'merge', a.ref, b.ref, '--into', c.ref], { stdin: '合併' });
    assert.equal(outside.code, 2);
    assert.match(fs.readFileSync(vaultFile(c.ref), 'utf8'), /\nC\n$/, '第三筆不可以被覆寫');
    const unclosed = await engram(['memory', 'merge', a.ref, b.ref], { stdin: '---\nname: into-a\ndescription: A\n\n內文' });
    assert.equal(unclosed.code, 1);
    assert.match(unclosed.err, /沒有結尾的 ---/);
    assert.ok(fs.existsSync(vaultFile(b.ref)), '被拒絕時其他筆不刪');
    // 不在索引裡的記憶（H03，自動整理）：套用後不印 engram undo（索引整理不能單獨復原）
    plant('global/unindexed.md', memoryText({ name: 'unindexed', type: 'reference', description: '不在索引', body: '內文' }));
    const h03 = (await json(['inbox', '--all'])).data.findings.find((f) => f.code === 'H03');
    assert.ok(h03);
    const r = await engram(['inbox', 'apply', h03.id]);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /engram undo/);
    for (const m of [a, b, c, { ref: 'global/unindexed.md' }]) await eg.memories.remove(m.ref);
  });

  test('dismiss --days：之後不在預設清單；--all 顯示延後到哪天', async () => {
    const mem = await eg.memories.create({ scope: { kind: 'project', pid }, name: 'likes-short-answers', type: 'user', description: '喜歡簡短回答', body: '喜歡簡短回答。' });
    const card = await cardOf('H09', mem.ref);
    const r = await engram(['inbox', 'dismiss', card.id, '--days', '7']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /7 天後再提醒/);
    assert.ok(!(await json(['inbox'])).data.findings.some((f) => f.id === card.id));
    const all = await engram(['inbox', '--all']);
    assert.match(all.out, new RegExp(`${card.id}.*（延後到 \\d{4}-\\d{2}-\\d{2}）`));
    const bad = await engram(['inbox', 'dismiss', 'H09:0000000000']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /E_NOT_FOUND/);
  });

  test('衝突：show 列出兩邊版本並遮蔽金鑰；manual 要有完整 frontmatter；處理後可以復原', async () => {
    const mem = await eg.memories.create({ scope: { kind: 'global' }, name: 'deploy-steps', type: 'project', description: '部署步驟', body: '先 build 再 deploy。' });
    const ours = fs.readFileSync(vaultFile(mem.ref), 'utf8');
    const theirs = memoryText({ name: 'deploy-steps', description: '部署步驟', body: `先 test 再 deploy。權杖 ${SECRET}` });
    const id = await quarantine(eg.paths.vault, { ref: mem.ref, ours, theirs, base: ours, summary: '兩台電腦都改了部署步驟' });
    const list = await engram(['inbox']);
    assert.match(list.out, new RegExp(`\\[衝突\\] ${id}`));
    const show = await engram(['inbox', 'show', id]);
    assert.match(show.out, /對方的版本（theirs）/);
    assert.match(show.out, /先 test 再 deploy/);
    assert.ok(!show.out.includes('ghp_'));
    assert.equal((await engram(['inbox', 'apply', id])).code, 2, '衝突不能用 apply');
    const noFm = await engram(['inbox', 'resolve', id, '--choice', 'manual'], { stdin: '只有內文\n' });
    assert.equal(noFm.code, 1);
    assert.match(noFm.err, /沒有 frontmatter/);
    const merged = memoryText({ name: 'deploy-steps', description: '部署步驟', body: '先 build、test，再 deploy。' });
    const r = await engram(['inbox', 'resolve', id, '--choice', 'manual'], { stdin: merged });
    assert.equal(r.code, 0, r.err);
    assert.match(fs.readFileSync(vaultFile(mem.ref), 'utf8'), /先 build、test，再 deploy/);
    assert.equal((await eg.conflicts.list()).length, 0);
  });

  test('沒有子指令以外的錯誤用法 → exit 2', async () => {
    assert.equal((await engram(['inbox', 'bogus'])).code, 2);
    assert.equal((await engram(['inbox', 'show'])).code, 2);
    assert.equal((await engram(['inbox', 'resolve', 'cf_x'])).code, 2);
  });
});

describe('engram memory', () => {
  test('list 與 show：列出 ref、類型、大小；show 附版本，一次可以多筆', async () => {
    const a = await eg.memories.create({ scope: { kind: 'project', pid }, name: 'build-cmd', type: 'project', description: '建置指令', body: 'npm run build' });
    const list = await engram(['memory', 'list', '--project', pid]);
    assert.equal(list.code, 0);
    assert.match(list.out, new RegExp(`• ${a.ref.replace(/\//g, '\\/')} · project · `));
    assert.match(list.out, /build-cmd — 建置指令/);
    const show = await engram(['memory', 'show', a.ref, 'global/node-version.md']);
    assert.match(show.out, new RegExp(`── ${a.ref}（版本 [0-9a-f]{10}）`));
    assert.match(show.out, /── global\/node-version\.md（版本/);
    assert.equal((await engram(['memory', 'show', `projects/${pid}/memory/MEMORY.md`])).code, 1, '索引不是記憶檔');
  });

  test('M5：search 與 memory list 的輸出不帶金鑰（說明與內文摘要都遮蔽）', async () => {
    const mem = plant('global/deploy-token.md', memoryText({ name: 'deploy-token', type: 'reference', description: `部署權杖 ${SECRET}`, body: `部署用：${SECRET}` }));
    for (const argv of [['search', '部署權杖'], ['search', '部署權杖', '--json'], ['memory', 'list', '--scope', 'global'], ['memory', 'list', '--scope', 'global', '--json']]) {
      const r = await engram(argv);
      assert.equal(r.code, 0, r.err);
      assert.ok(r.out.includes('deploy-token'), `${argv.join(' ')} 應該列出這筆`);
      assert.ok(!r.all.includes('ghp_'), `${argv.join(' ')} 不可以輸出金鑰`);
    }
    fs.rmSync(vaultFile(mem.ref));
  });

  test('write：--base 不符拒絕；缺欄位拒絕；成功時附復原指令', async () => {
    const ref = `projects/${pid}/memory/build-cmd.md`;
    const { data } = await json(['memory', 'show', ref]);
    const next = memoryText({ name: 'build-cmd', description: '建置與測試指令', type: 'project', body: 'npm run build && npm test' });
    const stale = await engram(['memory', 'write', ref, '--base', '0000000000'], { stdin: next });
    assert.equal(stale.code, 1);
    assert.match(stale.err, /E_CONFLICT/);
    const missing = await engram(['memory', 'write', ref, '--base', data.rev], { stdin: '---\nname: build-cmd\n---\n內文\n' });
    assert.equal(missing.code, 1);
    assert.match(missing.err, /缺少 description、metadata\.type/);
    const ok = await engram(['memory', 'write', ref, '--base', data.rev], { stdin: next });
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /已寫入/);
    assert.match(ok.out, /engram undo [0-9a-f]{7,}/);
    assert.equal((await eg.memories.read(ref)).frontmatter.description, '建置與測試指令');
  });

  test('move --to machine 與 remove；--to 看不懂時 exit 2', async () => {
    const mem = await eg.memories.create({ scope: { kind: 'global' }, name: 'local-python-path', type: 'reference', description: 'Python 路徑', body: 'C:\\Python312' });
    assert.equal((await engram(['memory', 'move', mem.ref, '--to', 'somewhere'])).code, 2);
    const mv = await engram(['memory', 'move', mem.ref, '--to', 'machine']);
    assert.equal(mv.code, 0, mv.err);
    const moved = `machines/${eg.machine.id}/local-python-path.md`;
    assert.ok(fs.existsSync(vaultFile(moved)));
    const rm = await engram(['memory', 'remove', moved]);
    assert.equal(rm.code, 0, rm.err);
    assert.ok(!fs.existsSync(vaultFile(moved)));
    assert.match(rm.out, /已封存/);
  });
});

describe('--file：沒有 Bash 時用 Write 工具寫草稿，再交給 engram', () => {
  const drafts = () => path.join(m.home, 'local', 'drafts');
  test('memory write --file：讀 UTF-8（去掉 BOM），成功後刪除草稿資料夾裡的檔案', async () => {
    const ref = `projects/${pid}/memory/build-cmd.md`;
    const { data } = await json(['memory', 'show', ref]);
    fs.mkdirSync(drafts(), { recursive: true });
    const f = path.join(drafts(), 'build-cmd.md');
    fs.writeFileSync(f, `\uFEFF${memoryText({ name: 'build-cmd', description: '建置、測試與打包指令', type: 'project', body: 'npm run build && npm test && npm pack（中文內容）' })}`);
    const r = await engram(['memory', 'write', ref, '--base', data.rev, '--file', f]);
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.existsSync(f), false, '草稿用完要刪除');
    const raw = fs.readFileSync(vaultFile(ref), 'utf8');
    assert.ok(raw.startsWith('---\n'), '不可以留下 BOM');
    assert.match(raw, /npm pack（中文內容）/);
  });

  test('草稿資料夾以外的檔案不刪；寫入失敗時草稿保留', async () => {
    const outside = path.join(root, 'note.md');
    fs.writeFileSync(outside, '外面的檔案內文');
    const r = await engram(['remember', '--scope', 'global', '--name', 'outside-file', '--type', 'reference', '--description', '從外部檔案寫入', '--file', outside]);
    assert.equal(r.code, 0, r.err);
    assert.ok(fs.existsSync(outside));
    assert.match(fs.readFileSync(vaultFile('global/outside-file.md'), 'utf8'), /外面的檔案內文/);
    const f = path.join(drafts(), 'bad.md');
    fs.writeFileSync(f, '---\nname: x\n---\n沒有說明\n');
    const bad = await engram(['memory', 'write', 'global/outside-file.md', '--file', f]);
    assert.equal(bad.code, 1);
    assert.ok(fs.existsSync(f), '寫入失敗時要保留草稿，讓 Claude 修正後重試');
  });

  test('找不到檔案 → E_NOT_FOUND；--body 與 --file 不能同時用', async () => {
    const r = await engram(['memory', 'write', 'global/outside-file.md', '--file', path.join(root, 'nope.md')]);
    assert.equal(r.code, 1);
    assert.match(r.err, /E_NOT_FOUND/);
    const both = await engram(['remember', '--scope', 'global', '--name', 'x', '--type', 'user', '--description', 'x', '--body', 'a', '--file', path.join(root, 'note.md')]);
    assert.equal(both.code, 2);
  });
});

describe('engram core', () => {
  test('讀取附版本；write 的 --base 不符拒絕；寫入後可以復原', async () => {
    const { data } = await json(['core']);
    assert.match(data.rev, /^[0-9a-f]{10}$/);
    const next = `${data.text.replace(/\n$/, '')}\n\n- 測試加的一行\n`;
    assert.equal((await engram(['core', 'write', '--base', 'ffffffffff'], { stdin: next })).code, 1);
    const ok = await engram(['core', 'write', '--base', data.rev], { stdin: next });
    assert.equal(ok.code, 0, ok.err);
    assert.match((await eg.core.read()).text, /測試加的一行/);
    const sha = /engram undo ([0-9a-f]{7,})/.exec(ok.out)[1];
    assert.equal((await engram(['undo', sha])).code, 0);
    assert.doesNotMatch((await eg.core.read()).text, /測試加的一行/);
  });
});
