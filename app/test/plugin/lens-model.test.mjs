// 憶跡面板（plugin/hooks/lens）的純函式：路徑分類、指令解析、匯入樹、索引截斷、顯示寬度與介面文字。
// 面板本身的行為（事件、畫面、按鈕）在 plugin/test/lens.test.tsx，用 claude plugin test 執行（npm run test:lens）。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  classify,
  countTitles,
  displayPath,
  displayWidth,
  formatTokens,
  importsOf,
  indexFacts,
  isIndexFile,
  isMemoryDir,
  levelOf,
  mergeEntry,
  segments,
  nextFilter,
  normPath,
  padEnd,
  parentsOf,
  parseCommand,
  resolvePath,
  searchHits,
  splitFrontmatter,
  stripHeredocs,
  treeOrder,
  treePrefixes,
  truncate,
} from '../../plugin/hooks/lens/model.mjs';
import { langOf, STRINGS } from '../../plugin/hooks/lens/strings.mjs';

const roots = {
  home: 'C:/Users/T',
  vault: 'C:/Users/T/.engram/vault',
  claudeHome: 'C:/Users/T/.claude',
  cwd: 'C:/proj',
};

describe('classify：哪些檔案算記憶或指示檔、屬於哪個範圍', () => {
  test('Engram 記憶庫的各範圍，反斜線與大小寫不同也認得', () => {
    assert.deepEqual(classify('C:\\Users\\T\\.engram\\vault\\core\\CORE.md', roots), { scope: 'core', name: 'CORE.md' });
    assert.deepEqual(classify('c:\\users\\t\\.engram\\vault\\global\\INDEX.md', roots), { scope: 'global', name: 'INDEX.md' });
    assert.deepEqual(classify('C:/Users/T/.engram/vault/global/brand-colors.md', roots), { scope: 'global', name: 'brand-colors' });
    assert.deepEqual(classify('C:/Users/T/.engram/vault/machines/m1/office.md', roots), { scope: 'machine', name: 'office', owner: 'm1' });
    assert.deepEqual(classify('C:/Users/T/.engram/vault/projects/p1/memory/MEMORY.md', roots), { scope: 'project', name: 'MEMORY.md', owner: 'p1' });
  });

  test('Claude Code 原生的自動記憶資料夾算專案記憶', () => {
    assert.deepEqual(classify('C:/Users/T/.claude/projects/C--proj/memory/note.md', roots), { scope: 'project', name: 'note', owner: 'C--proj' });
  });

  test('CLAUDE.md 與 .claude/rules 是指示檔，名稱用短路徑', () => {
    assert.deepEqual(classify('C:/Users/T/.claude/CLAUDE.md', roots), { scope: 'instructions', name: '~/.claude/CLAUDE.md' });
    assert.deepEqual(classify('C:\\proj\\CLAUDE.local.md', roots), { scope: 'instructions', name: './CLAUDE.local.md' });
    assert.equal(classify('C:/proj/.claude/rules/style.md', roots)?.scope, 'instructions');
  });

  test('記憶庫裡不是記憶的檔案、其他 Markdown 與非 .md 檔都不算', () => {
    assert.equal(classify('C:/Users/T/.engram/vault/conflicts/cf_1/x.md', roots), null);
    assert.equal(classify('C:/Users/T/.engram/vault/projects/p1/project.md', roots), null);
    assert.equal(classify('C:/proj/README.md', roots), null);
    assert.equal(classify('C:/Users/T/.engram/vault/global/INDEX.json', roots), null);
    assert.equal(classify('C:/Users/T/.claude/dev-mods/x/notes.md', roots), null);
  });

  test('isMemoryDir：記憶庫與 Claude Code 的 projects 資料夾', () => {
    assert.equal(isMemoryDir('C:\\Users\\T\\.engram\\vault', roots), true);
    assert.equal(isMemoryDir('C:/Users/T/.engram/vault/global', roots), true);
    assert.equal(isMemoryDir('C:/Users/T/.claude/projects/C--proj/memory', roots), true);
    assert.equal(isMemoryDir('C:/Users/T/.claude/plugins', roots), false);
    assert.equal(isMemoryDir('C:/proj', roots), false);
    assert.equal(isMemoryDir('', roots), false);
  });

  test('displayPath：專案底下用 ./、家目錄底下用 ~/', () => {
    assert.equal(displayPath('C:\\proj\\docs\\a.md', roots), './docs/a.md');
    assert.equal(displayPath('C:/Users/T/.claude/CLAUDE.md', roots), '~/.claude/CLAUDE.md');
    assert.equal(displayPath('D:/other/CLAUDE.md', roots), 'D:/other/CLAUDE.md');
  });
});

describe('@ 匯入與樹狀排列', () => {
  test('resolvePath：處理 ~、相對路徑、.. 與磁碟代號', () => {
    assert.equal(resolvePath('C:/Users/T/.claude', '~/.engram/vault/core/CORE.md', 'C:/Users/T'), 'C:/Users/T/.engram/vault/core/CORE.md');
    assert.equal(resolvePath('C:/Users/T/.engram/vault/core', '../global/INDEX.md', 'C:/Users/T'), 'C:/Users/T/.engram/vault/global/INDEX.md');
    assert.equal(resolvePath('C:/a', '../../../x.md', 'C:/Users/T'), 'C:/x.md');
    assert.equal(resolvePath('/home/t', './notes/./a.md', '/home/t'), '/home/t/notes/a.md');
  });

  test('importsOf：程式碼區塊、行內程式碼、email 與 @人名都不算匯入', () => {
    const text = [
      '@~/.engram/vault/core/CORE.md',
      '請看 @docs/guide.md 與 @README.md',
      '寄信給 someone@example.com，提到 @human',
      '`@not/an/import.md`',
      '```',
      '@../in/fence.md',
      '```',
    ].join('\n');
    assert.deepEqual(importsOf(text, 'C:/proj/CLAUDE.md', 'C:/Users/T'), [
      'C:/Users/T/.engram/vault/core/CORE.md',
      'C:/proj/docs/guide.md',
      'C:/proj/README.md',
    ]);
  });

  const files = [
    { path: 'C:\\Users\\T\\.engram\\vault\\global\\INDEX.md', text: '- [a](a.md)' },
    { path: 'C:\\Users\\T\\.engram\\vault\\machines\\m1\\INDEX.md', text: '- [b](b.md)' },
    { path: 'C:\\Users\\T\\.claude\\CLAUDE.md', text: '@~/.engram/vault/core/CORE.md\n@~/.engram/vault/machines/m1/INDEX.md' },
    { path: 'C:\\Users\\T\\.engram\\vault\\core\\CORE.md', text: '@../global/INDEX.md' },
    { path: 'C:\\Users\\T\\.engram\\vault\\projects\\p1\\memory\\MEMORY.md', text: '- [c](c.md)' },
  ];

  test('parentsOf 找出誰匯入了誰與匯入順序；treeOrder 依匯入順序排成樹', () => {
    const { parents, ranks } = parentsOf(files, 'C:/Users/T');
    assert.equal(parents.get('c:/users/t/.engram/vault/core/core.md'), files[2].path);
    assert.equal(parents.get('c:/users/t/.engram/vault/global/index.md'), files[3].path);
    assert.equal(ranks.get('c:/users/t/.engram/vault/machines/m1/index.md'), 1);
    const list = files.map((f) => ({ path: f.path, parent: parents.get(normPath(f.path).toLowerCase()) }));
    const ordered = treeOrder(list, ranks).map((x) => normPath(x.path).split('/').slice(-2).join('/'));
    assert.deepEqual(ordered, ['.claude/CLAUDE.md', 'core/CORE.md', 'global/INDEX.md', 'm1/INDEX.md', 'memory/MEMORY.md']);
  });

  test('treePrefixes 畫出 ├ └ │ 連接線；上層被篩掉的項目當成最上層', () => {
    const { parents, ranks } = parentsOf(files, 'C:/Users/T');
    const list = treeOrder(files.map((f) => ({ path: f.path, parent: parents.get(normPath(f.path).toLowerCase()) })), ranks);
    const p = treePrefixes(list);
    assert.deepEqual(list.map((x) => p.get(normPath(x.path).toLowerCase())), ['', '├ ', '│ └ ', '└ ', '']);
    const withoutClaude = list.filter((x) => !x.path.endsWith('CLAUDE.md'));
    const q = treePrefixes(withoutClaude);
    assert.deepEqual(withoutClaude.map((x) => q.get(normPath(x.path).toLowerCase())), ['', '└ ', '', '']);
  });

  test('互相匯入成環時每個檔案都還在，只出現一次', () => {
    const cyc = [
      { path: 'C:/a.md', parent: 'C:/b.md' },
      { path: 'C:/b.md', parent: 'C:/a.md' },
    ];
    assert.equal(treeOrder(cyc).length, 2);
    assert.equal(treePrefixes(cyc).size, 2);
  });
});

describe('Claude 看到多少：全文、標題、摘要', () => {
  test('levelOf：開場載入的索引是標題，搜尋是摘要，其他是全文', () => {
    assert.equal(levelOf({ path: 'C:/v/global/INDEX.md', how: 'start' }), 'titles');
    assert.equal(levelOf({ path: 'C:/v/projects/p/memory/MEMORY.md', how: 'compact' }), 'titles');
    assert.equal(levelOf({ path: 'C:/v/projects/p/memory/MEMORY.md', how: 'read' }), 'full');
    assert.equal(levelOf({ path: 'C:/Users/T/.claude/CLAUDE.md', how: 'start' }), 'full');
    assert.equal(levelOf({ path: 'C:/v/global/a.md', how: 'search' }), 'snippet');
    assert.equal(levelOf({ path: 'C:/proj/sub/CLAUDE.md', how: 'nested' }), 'full');
  });

  test('isIndexFile 與 countTitles', () => {
    assert.equal(isIndexFile('C:\\v\\global\\INDEX.md'), true);
    assert.equal(isIndexFile('C:/v/projects/p/memory/MEMORY.md'), true);
    assert.equal(isIndexFile('C:/v/core/CORE.md'), false);
    assert.equal(countTitles('# 標題\n- [a](a.md) — x\n  * [b](b.md)\n- 不是連結\n'), 2);
  });

  test('indexFacts：MEMORY.md 只載入前 200 行', () => {
    const memory = ['# 記憶', ...Array.from({ length: 250 }, (_, i) => `- [m${i}](m${i}.md) — ${i}`)].join('\n');
    assert.deepEqual(indexFacts('C:/v/projects/p/memory/MEMORY.md', memory), { titles: 250, visible: 199 });
    // 用 @ 匯入的 INDEX.md 整份載入
    assert.deepEqual(indexFacts('C:/v/global/INDEX.md', memory), { titles: 250, visible: 250 });
  });

  test('indexFacts：MEMORY.md 超過 25KB 時在 25KB 截斷', () => {
    const long = '說明'.repeat(100); // 每行約 600 位元組
    const memory = Array.from({ length: 60 }, (_, i) => `- [m${i}](m${i}.md) — ${long}`).join('\n');
    const { titles, visible } = indexFacts('C:/v/projects/p/memory/MEMORY.md', memory);
    assert.equal(titles, 60);
    assert.ok(visible < 60 && visible >= 40, `visible=${visible}`);
  });

  test('splitFrontmatter：取出 description，去掉 BOM 與引號', () => {
    assert.deepEqual(splitFrontmatter('\uFEFF---\nname: x\ndescription: "一句話"\nmetadata:\n  type: user\n---\n\n內文'), { description: '一句話', body: '\n內文' });
    assert.deepEqual(splitFrontmatter('沒有 frontmatter'), { description: '', body: '沒有 frontmatter' });
  });
});

describe('從指令判斷讀取與搜尋', () => {
  const A = 'C:/Users/T/.engram/vault/global/a.md';
  const reads = (...paths) => ({ search: null, paths });
  const search = (q, ...paths) => ({ search: q, paths });

  test('engram search：取出關鍵字，略過旗標與 --limit 的值', () => {
    assert.deepEqual(parseCommand('engram search 範圍 --limit 10', roots), search('範圍'));
    assert.deepEqual(parseCommand('engram search "BOM encoding" --json', roots), search('BOM encoding'));
    assert.deepEqual(parseCommand('engram search --json 品牌', roots), search('品牌'));
    assert.deepEqual(parseCommand('engram search --limit=5 品牌', roots), search('品牌'));
    assert.deepEqual(parseCommand('engram search "foo (bar)"', roots), search('foo (bar)'));
    assert.deepEqual(parseCommand('cd x && engram.cmd search 品牌 | head', roots), search('品牌'));
  });

  test('engram memory show：ref 轉成記憶庫路徑；同一條指令可以同時搜尋與讀取', () => {
    assert.deepEqual(
      parseCommand('engram memory show global/a.md projects/p1/memory/b.md MEMORY.md', roots),
      reads(A, 'C:/Users/T/.engram/vault/projects/p1/memory/b.md'),
    );
    assert.deepEqual(parseCommand('engram search 品牌 && engram memory show global/a.md', roots), search('品牌', A));
  });

  test('cat、head、Get-Content 讀記憶檔算讀取，可以用 ~ 與引號', () => {
    assert.deepEqual(parseCommand('cat ~/.engram/vault/global/a.md | head -5', roots), reads(A));
    assert.deepEqual(parseCommand('Get-Content "C:\\Users\\T\\.engram\\vault\\global\\a.md"', roots), reads(A));
    assert.equal(parseCommand('cat README.md', roots), null);
  });

  test('Git Bash 的 /c/ 路徑、前綴（sudo、time、env、then、do、環境變數）、括號與 $( ) 都認得', () => {
    for (const cmd of [
      'cat /c/Users/T/.engram/vault/global/a.md',
      'FOO=1 sudo time cat ~/.engram/vault/global/a.md',
      'env X=1 cat ~/.engram/vault/global/a.md',
      'if true; then cat ~/.engram/vault/global/a.md; fi',
      'for f in x; do cat ~/.engram/vault/global/a.md; done',
      '( cat ~/.engram/vault/global/a.md )',
      'echo "$(cat ~/.engram/vault/global/a.md)"',
      'x=$(cat ~/.engram/vault/global/a.md)',
      '{ head -3 ~/.engram/vault/global/a.md; }',
      'cat < ~/.engram/vault/global/a.md',
      'cat ~/.engram/vault/global/a.md>out.txt',
    ]) assert.deepEqual(parseCommand(cmd, roots), reads(A), cmd);
  });

  test('相對路徑以工作目錄解析；同一行的 cd 會改變基準', () => {
    assert.deepEqual(parseCommand('cat CLAUDE.md', roots), reads('C:/proj/CLAUDE.md'));
    assert.deepEqual(parseCommand('cd ~/.engram/vault && cat global/a.md', roots), reads(A));
    assert.deepEqual(parseCommand('cd /c/Users/T/.engram/vault/global; cat ../core/CORE.md', roots), reads('C:/Users/T/.engram/vault/core/CORE.md'));
  });

  test('sed -i 是改寫、引號裡的 engram search 不是搜尋、here-string 與位移不是 heredoc', () => {
    assert.equal(parseCommand("sed -i 's/a/b/' ~/.engram/vault/global/a.md", roots), null);
    assert.equal(parseCommand("sed -ni.bak 's/a/b/p' ~/.engram/vault/global/a.md", roots), null);
    assert.deepEqual(parseCommand("sed -n '1,5p' ~/.engram/vault/global/a.md", roots), reads(A));
    assert.equal(parseCommand('git commit -m "fix; engram search 品牌"', roots), null);
    // <<< 與 1 << n 不會把後面的指令當成 heredoc 吃掉
    assert.deepEqual(parseCommand('cat <<< "hi"\ncat ~/.engram/vault/global/a.md', roots), reads(A));
    assert.deepEqual(parseCommand('echo $((1 << n))\ncat ~/.engram/vault/global/a.md', roots), reads(A));
    // 找不到結束行就不是 heredoc
    assert.deepEqual(parseCommand('python x.py <<EOF\ncat ~/.engram/vault/global/a.md', roots), reads(A));
  });

  test('回歸（2026-10-24 第二輪審查）：落單的撇號、註解、跳脫的引號不會吞掉或製造讀取', () => {
    assert.deepEqual(parseCommand("# Pat's note\ncat ~/.engram/vault/global/a.md", roots), reads(A));
    assert.deepEqual(parseCommand("echo don't; cat ~/.engram/vault/global/a.md", roots), reads(A));
    assert.equal(parseCommand('echo "a \\" ; cat ~/.engram/vault/global/a.md \\" b"', roots), null);
    assert.equal(parseCommand('echo hi # cat ~/.engram/vault/global/a.md', roots), null);
  });

  test('回歸（2026-10-24 第三輪審查）：PowerShell 的 \\ 是路徑分隔，不是跳脫字元', () => {
    const ps = (cmd) => parseCommand(cmd, roots, 'powershell');
    assert.deepEqual(ps('Get-ChildItem "C:\\Users\\T\\.engram\\vault\\"; Get-Content "~/.engram/vault/core/CORE.md"'), reads('C:/Users/T/.engram/vault/core/CORE.md'));
    assert.deepEqual(ps('Set-Location C:\\Users\\T\\.engram\\vault\\; Get-Content core\\CORE.md'), reads('C:/Users/T/.engram/vault/core/CORE.md'));
    assert.deepEqual(ps('cd C:\\Users\\T\\.engram\\vault\\\nGet-Content core/CORE.md'), reads('C:/Users/T/.engram/vault/core/CORE.md'));
    assert.deepEqual(ps('{ Get-Content ~/.engram/vault/global/a.md}'), reads(A));
  });

  test('回歸（2026-10-24 第三輪審查）：if／while 前綴、<"檔案"、;# 註解；不成對的 $( 不會拖慢', () => {
    assert.deepEqual(parseCommand('if cat ~/.engram/vault/global/a.md; then echo ok; fi', roots), reads(A));
    assert.deepEqual(parseCommand('while cat ~/.engram/vault/global/a.md; do break; done', roots), reads(A));
    assert.deepEqual(parseCommand('cat <"~/.engram/vault/global/a.md"', roots), reads(A));
    assert.equal(parseCommand('echo hi;# cat ~/.engram/vault/global/a.md', roots), null);
    const t0 = Date.now();
    parseCommand(`echo "${'$('.repeat(30000)}"`, roots);
    assert.ok(Date.now() - t0 < 500, `${Date.now() - t0}ms`);
  });

  test('segments：只在引號外的換行、; | || && ( ) 切開', () => {
    assert.deepEqual(segments('a && b || c; d | e\nf'), ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.deepEqual(segments('git commit -m "x; y | z" && ls'), ['git commit -m "x; y | z"', 'ls']);
    assert.deepEqual(segments('x=$(cat a) && (cd b; ls)'), ['x=$', 'cat a', 'cd b', 'ls']);
  });

  test('回歸（2026-10-23）：heredoc 寫檔的內容與重新導向目標不算讀取', () => {
    const write = "cat >> tests/x.test.tsx <<'EOF'\nfiles = [{ path: 'C:/proj/sub/CLAUDE.md' }]\nkey: 'R:c:/proj/sub/claude.md'\nEOF\nclaude plugin test .";
    assert.equal(parseCommand(write, roots), null);
    assert.equal(parseCommand('cat > ~/.engram/vault/global/new.md', roots), null);
    assert.deepEqual(parseCommand('cat ~/.engram/vault/global/a.md > /tmp/copy.md', roots), reads(A));
    // heredoc 裡提到 engram search 也不算搜尋
    assert.equal(parseCommand("node - <<'EOF'\n// engram search 範圍\nEOF", roots), null);
  });

  test('stripHeredocs：去掉 heredoc 內容，結尾標記之後的指令保留', () => {
    assert.equal(stripHeredocs("cat <<-EOF > a\n\tbody\n\tEOF\necho done"), 'cat <<-EOF > a\necho done');
    assert.equal(stripHeredocs('echo hi'), 'echo hi');
  });

  test('searchHits：輸出裡的記憶檔路徑與 --json 的 ref；不是記憶的路徑不算；回傳正斜線、不重複', () => {
    const text = '• a — x\n  C:\\Users\\T\\.engram\\vault\\projects\\p1\\memory\\a.md\n  C:\\proj\\README.md\n';
    assert.deepEqual(searchHits(text, roots), ['C:/Users/T/.engram/vault/projects/p1/memory/a.md']);
    assert.deepEqual(searchHits('[{"ref": "global/b.md"}]', roots), ['C:/Users/T/.engram/vault/global/b.md']);
  });

  test('searchHits：家目錄含空白時，一行一個的路徑與 Grep 的「路徑:行號:內容」也找得到', () => {
    const spaced = { ...roots, home: 'C:/Users/Demo User', vault: 'C:/Users/Demo User/.engram/vault', claudeHome: 'C:/Users/Demo User/.claude' };
    const text = '• a — x\n  C:\\Users\\Demo User\\.engram\\vault\\global\\a.md\nC:/Users/Demo User/.engram/vault/global/b.md:12:內容\n';
    assert.deepEqual(searchHits(text, spaced), ['C:/Users/Demo User/.engram/vault/global/a.md', 'C:/Users/Demo User/.engram/vault/global/b.md']);
  });

  test('mergeEntry：同一個檔案只留一列、次數累加；先搜尋後讀取升級成讀取，讀過之後再被搜尋到不改寫回合', () => {
    let list = mergeEntry([], { id: 'R:a', how: 'search', turn: 1, query: '品牌' });
    list = mergeEntry(list, { id: 'R:a', how: 'read', turn: 3 });
    assert.deepEqual(list, [{ id: 'R:a', how: 'read', turn: 3, times: 2, query: '品牌' }]);
    list = mergeEntry(list, { id: 'R:a', how: 'search', turn: 4, query: '發版' });
    assert.deepEqual(list, [{ id: 'R:a', how: 'read', turn: 3, times: 3, query: '品牌' }]);
    list = mergeEntry(list, { id: 'R:a', how: 'read', turn: 5 });
    assert.equal(list[0].turn, 5);
  });

  test('normPath：反斜線、Git Bash 的 /c/ 與結尾斜線', () => {
    assert.equal(normPath('C:\\a\\b\\'), 'C:/a/b');
    assert.equal(normPath('/c/Users/T'), 'C:/Users/T');
    assert.equal(normPath('/home/t'), '/home/t');
  });
});

describe('顯示與介面文字', () => {
  test('displayWidth、truncate、padEnd：中日韓字元算兩格', () => {
    assert.equal(displayWidth('全域 abc'), 8);
    assert.equal(truncate('windows-az-cli-workarounds', 12), 'windows-az-…');
    assert.equal(truncate('撞名資料夾改名計畫', 9), '撞名資料…');
    assert.equal(truncate('短', 4), '短');
    assert.equal(padEnd('全域', 6), '全域  ');
  });

  test('formatTokens 與 nextFilter', () => {
    assert.equal(formatTokens(850), '850');
    assert.equal(formatTokens(6234), '6.2k');
    assert.equal(formatTokens(3000), '3k');
    assert.equal(formatTokens(undefined), '');
    const seen = [];
    let f = 'all';
    for (let i = 0; i < 6; i++) seen.push((f = nextFilter(f)));
    assert.deepEqual(seen, ['core', 'global', 'machine', 'project', 'instructions', 'all']);
  });

  test('langOf：zh 開頭或含「中文」用中文，其他（包括沒設定）用英文', () => {
    assert.equal(langOf('zh-TW, 正體中文'), 'zh');
    assert.equal(langOf('繁體中文'), 'zh');
    assert.equal(langOf('English'), 'en');
    assert.equal(langOf(undefined), 'en');
  });

  test('中英文的文字鍵與參數一致，英文不含中文', () => {
    const keysOf = (o, prefix = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keysOf(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
    assert.deepEqual(keysOf(STRINGS.en).sort(), keysOf(STRINGS.zh).sort());
    const valueOf = (o, key) => key.split('.').reduce((x, k) => x[k], o);
    for (const key of keysOf(STRINGS.zh)) {
      const zh = valueOf(STRINGS.zh, key);
      const en = valueOf(STRINGS.en, key);
      assert.equal(typeof en, typeof zh, key);
      if (typeof zh === 'function') assert.equal(en.length, zh.length, `${key} 的參數個數`);
      const sample = typeof en === 'function' ? en(1, 2) : en;
      // 語言切換鈕在英文介面顯示「中文」，是刻意的
      if (key !== 'otherLang') assert.doesNotMatch(sample, /[\u4e00-\u9fff]/, `${key} 的英文含中文`);
    }
  });
});
