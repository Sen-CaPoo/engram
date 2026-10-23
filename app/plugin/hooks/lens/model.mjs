// 憶跡面板的純函式：判斷路徑屬於哪個範圍、解析讀取記憶的指令、計算顯示寬度。
// 不依賴 Node 或 Claude Code，面板（lens.tsx）與 node 測試共用。

/** 反斜線轉正斜線、Git Bash 的 /c/… 轉成 C:/…、去掉結尾斜線；比對時另外轉小寫（Windows 不分大小寫） */
export function normPath(p) {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/([A-Za-z])(?=\/|$)/, (_, d) => `${d.toUpperCase()}:`)
    .replace(/\/+$/, '');
}

const lower = (p) => normPath(p).toLowerCase();

/** 底下有子項目的路徑：under('C:/a', 'c:/A/b.md') → 'b.md'；不在底下時 null */
function under(root, p) {
  const r = lower(root);
  if (!r) return null;
  const n = normPath(p);
  return n.toLowerCase().startsWith(r + '/') ? n.slice(r.length + 1) : null;
}

const INDEX_FILES = /^(INDEX|MEMORY|CORE)\.md$/i;

/** 索引檔（INDEX.md、MEMORY.md）：面板會顯示裡面列了幾則記憶 */
export function isIndexFile(p) {
  return /^(INDEX|MEMORY)\.md$/i.test(normPath(p).split('/').pop());
}

/** 顯示用的短路徑：專案底下 → ./…，家目錄底下 → ~/… */
export function displayPath(p, roots) {
  const inCwd = under(roots.cwd, p);
  if (inCwd != null) return `./${inCwd}`;
  const inHome = under(roots.home, p);
  if (inHome != null) return `~/${inHome}`;
  return normPath(p);
}

/**
 * 判斷一個檔案是不是記憶或指示檔，以及屬於哪個範圍。
 * roots：{ home, vault, claudeHome, cwd }（皆為 normPath 後的絕對路徑）
 * @returns {{ scope: 'core' | 'global' | 'machine' | 'project' | 'instructions', name: string, owner?: string } | null}
 */
export function classify(p, roots) {
  const file = normPath(p).split('/').pop() ?? '';
  if (!/\.md$/i.test(file)) return null;
  const name = INDEX_FILES.test(file) ? file : file.replace(/\.md$/i, '');

  const inVault = under(roots.vault, p);
  if (inVault != null) {
    const seg = inVault.split('/');
    if (seg[0] === 'core') return { scope: 'core', name };
    if (seg[0] === 'global' && seg.length === 2) return { scope: 'global', name };
    if (seg[0] === 'machines' && seg.length === 3) return { scope: 'machine', name, owner: seg[1] };
    if (seg[0] === 'projects' && seg[2] === 'memory' && seg.length === 4) return { scope: 'project', name, owner: seg[1] };
    return null; // conflicts/、not-secrets/ 等不是記憶
  }

  // Claude Code 原生的自動記憶：~/.claude/projects/<編碼>/memory/*.md
  const inClaude = under(roots.claudeHome, p);
  if (inClaude != null) {
    const seg = inClaude.split('/');
    if (seg[0] === 'projects' && seg[2] === 'memory' && seg.length === 4) return { scope: 'project', name, owner: seg[1] };
  }

  if (/^claude(\.local)?\.md$/i.test(file) || /\/\.claude\/rules\//i.test(lower(p))) {
    return { scope: 'instructions', name: displayPath(p, roots) };
  }
  return null;
}

/** 目錄是不是記憶庫或記憶資料夾（Grep 搜尋這些地方算「搜尋記憶」） */
export function isMemoryDir(p, roots) {
  const n = lower(p);
  if (!n) return false;
  const vault = lower(roots.vault);
  if (n === vault || n.startsWith(vault + '/')) return true;
  const rel = under(roots.claudeHome, p);
  return rel != null && /^projects(\/[^/]+(\/memory(\/.*)?)?)?$/.test(rel);
}

/** 把相對路徑解析成絕對路徑（正斜線），處理 ~、. 與 .. */
export function resolvePath(dir, rel, home) {
  let p = normPath(rel);
  if (p === '~' || p.startsWith('~/')) p = normPath(home) + p.slice(1);
  else if (!/^([A-Za-z]:\/|\/)/.test(p)) p = `${normPath(dir)}/${p}`;
  const lead = p.startsWith('/') ? '/' : '';
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > (lead ? 0 : 1)) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return lead + parts.join('/');
}

/**
 * 指示檔裡的 @ 匯入（程式碼區塊裡的不算），回傳解析後的絕對路徑。
 * 只認得含斜線或以 .md 結尾的，避免把 @人名 當成檔案。
 * @returns {string[]}
 */
export function importsOf(text, file, home) {
  const dir = normPath(file).split('/').slice(0, -1).join('/');
  const out = [];
  let inFence = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(/(?:^|\s)@([^\s`'"()<>@]+)/g)) {
      const raw = String(m[1]);
      if (/[\\/]/.test(raw) || /\.md$/i.test(raw)) out.push(resolvePath(dir, raw, home));
    }
  }
  return out;
}

/**
 * 從檔案內容找出誰匯入了誰，以及在上層檔案裡是第幾個匯入（樹狀排序用）。
 * @param {{ path: string, text: string }[]} files
 * @returns {{ parents: Map<string, string>, ranks: Map<string, number> }} 小寫路徑 → 匯入它的檔案（原始路徑）／匯入順序
 */
export function parentsOf(files, home) {
  const byKey = new Map(files.map((f) => [lower(f.path), f.path]));
  const parents = new Map();
  const ranks = new Map();
  for (const f of files) {
    importsOf(f.text, f.path, home).forEach((imp, i) => {
      const k = imp.toLowerCase();
      if (byKey.has(k) && k !== lower(f.path) && !parents.has(k)) {
        parents.set(k, f.path);
        ranks.set(k, i);
      }
    });
  }
  return { parents, ranks };
}

/**
 * 排成樹狀：沒有上層的照原順序，各自後面接著它匯入的檔案（有 ranks 時依匯入順序）。
 * @template {{ path: string, parent?: string }} T
 * @param {T[]} list
 * @param {Map<string, number>} [ranks]
 * @returns {T[]}
 */
export function treeOrder(list, ranks) {
  const keys = new Set(list.map((x) => lower(x.path)));
  const isRoot = (x) => !x.parent || !keys.has(lower(x.parent));
  const rank = (x) => ranks?.get(lower(x.path)) ?? 0;
  const out = [];
  const seen = new Set();
  const visit = (x) => {
    const k = lower(x.path);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(x);
    const kids = list.filter((c) => c.parent && lower(c.parent) === k).sort((a, b) => rank(a) - rank(b));
    for (const c of kids) visit(c);
  };
  for (const x of list) if (isRoot(x)) visit(x);
  for (const x of list) visit(x); // 互相匯入成環的也不漏掉
  return out;
}

/**
 * 樹狀連接線：替 treeOrder 排好的清單算出每一列名稱前的 ├ └ │ 前綴。
 * 上層不在清單裡（例如被篩選掉）的項目當成最上層。
 * @param {{ path: string, parent?: string }[]} list
 * @returns {Map<string, string>} 小寫路徑 → 前綴
 */
export function treePrefixes(list) {
  const keys = new Set(list.map((x) => lower(x.path)));
  const kids = new Map();
  const roots = [];
  for (const x of list) {
    const pk = x.parent ? lower(x.parent) : '';
    if (pk && keys.has(pk) && pk !== lower(x.path)) {
      if (!kids.has(pk)) kids.set(pk, []);
      kids.get(pk).push(x);
    } else roots.push(x);
  }
  const out = new Map();
  const walk = (x, own, above) => {
    const k = lower(x.path);
    if (out.has(k)) return;
    out.set(k, own);
    const cs = kids.get(k) ?? [];
    cs.forEach((c, i) => {
      const isLast = i === cs.length - 1;
      walk(c, above + (isLast ? '└ ' : '├ '), above + (isLast ? '  ' : '│ '));
    });
  };
  for (const r of roots) walk(r, '', '');
  for (const x of list) walk(x, '', ''); // 互相匯入成環的也不漏掉
  return out;
}

/**
 * Claude 看到多少：full 全文、titles 只有標題（開場載入的索引檔）、snippet 只有搜尋摘要
 * @param {{ path: string, how: string }} x
 * @returns {'full' | 'titles' | 'snippet'}
 */
export function levelOf(x) {
  if (x.how === 'search') return 'snippet';
  if ((x.how === 'start' || x.how === 'compact') && isIndexFile(x.path)) return 'titles';
  return 'full';
}

/** 索引檔裡列了幾則記憶（以「- [」開頭的行） */
export function countTitles(text) {
  return String(text ?? '').split(/\r?\n/).filter((l) => /^\s*[-*]\s+\[/.test(l)).length;
}

// Claude Code 只把 MEMORY.md 的前 200 行或 25KB 放進對話（Engram 健康檢查 H01 用的也是這個上限）；
// 用 @ 匯入的 INDEX.md 整份載入
export const MEMORY_INDEX_LIMIT = { lines: 200, bytes: 25 * 1024 };

/** Claude Code 實際載入的 MEMORY.md 內容：前 200 行，再截到 25KB */
function loadedPart(text) {
  const lines = String(text ?? '').split(/\r?\n/).slice(0, MEMORY_INDEX_LIMIT.lines);
  const out = [];
  let bytes = 0;
  const enc = new TextEncoder();
  for (const l of lines) {
    bytes += enc.encode(`${l}\n`).length;
    if (bytes > MEMORY_INDEX_LIMIT.bytes) break;
    out.push(l);
  }
  return out.join('\n');
}

/**
 * 索引檔的事實：列了幾則（titles），Claude 看得到幾則（visible）。
 * 只有 MEMORY.md 會被截斷；visible 小於 titles 代表後面的記憶 Claude 看不到。
 * @returns {{ titles: number, visible: number }}
 */
export function indexFacts(p, text) {
  const titles = countTitles(text);
  const isAutoIndex = /^MEMORY\.md$/i.test(normPath(p).split('/').pop() ?? '');
  return { titles, visible: isAutoIndex ? countTitles(loadedPart(text)) : titles };
}

/** 拆開記憶檔的 frontmatter：回傳 description 與正文 */
export function splitFrontmatter(text) {
  const t = String(text ?? '').replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(t);
  if (!m) return { description: '', body: t };
  const d = /^description:\s*(.*)$/m.exec(m[1]);
  const description = d ? d[1].trim().replace(/^(['"])(.*)\1$/, '$2') : '';
  return { description, body: t.slice(m[0].length) };
}

/** 把一段指令切成參數（處理單雙引號；Bash 雙引號裡的 \" 是跳脫；落單的引號當一般字元） */
function words(command, bash = true) {
  const out = [];
  const re = bash ? /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g : /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of String(command).matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** 從 from 開始找配對的引號；Bash 雙引號裡的 \ 會跳過下一個字元（PowerShell 的 \ 是路徑分隔）。找不到時回傳 -1 */
function closingQuote(s, from, q, bash) {
  for (let j = from; j < s.length; j++) {
    if (bash && q === '"' && s[j] === '\\') j += 1;
    else if (s[j] === q) return j;
  }
  return -1;
}

/**
 * 依引號外的換行、; | || && ( ) 把指令切成幾段，所以 $(cat x)、(cd a && cat b) 裡的指令也看得到。
 * 引號裡的分隔符號（例如 commit 訊息）不算；落單的引號（例如註解裡的 Pat's）當一般字元；# 之後到行尾是註解。
 * \ 只在 Bash 是跳脫字元；PowerShell 的 \ 是路徑分隔（"C:\vault\" 的結尾不是跳脫的引號）。
 * 子殼層裡的 cd 不會在 ) 之後還原，這是刻意的簡化。
 * @param {'bash' | 'powershell'} [shell]
 * @returns {string[]}
 */
export function segments(command, shell = 'bash') {
  const bash = shell !== 'powershell';
  const s = String(command ?? '');
  const out = [];
  const inner = []; // 雙引號裡的 $( ) 也會執行
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (bash && ch === '\\' && i + 1 < s.length) {
      cur += ch + s[i + 1];
      i += 1;
    } else if (ch === '"' || ch === "'") {
      const close = closingQuote(s, i + 1, ch, bash);
      if (close < 0) cur += ch;
      else {
        const quoted = s.slice(i, close + 1);
        cur += quoted;
        if (ch === '"') inner.push(...substitutions(quoted, shell));
        i = close;
      }
    } else if (ch === '#' && (i === 0 || /[\s;|&(]/.test(s[i - 1]))) {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl - 1;
    } else if (ch === '\n' || ch === ';' || ch === '|' || ch === '(' || ch === ')' || (ch === '&' && s[i + 1] === '&')) {
      out.push(cur);
      cur = '';
      if ((ch === '|' || ch === '&') && s[i + 1] === ch) i += 1; // || 與 &&
    } else cur += ch;
  }
  out.push(cur);
  return [...out, ...inner].map((x) => x.trim()).filter(Boolean);
}

/** 一段文字裡每個 $( ) 的內容，各自再切成幾段；遇到沒有配對的 $( 就停（避免反覆掃到結尾） */
function substitutions(text, shell) {
  const found = [];
  for (let i = text.indexOf('$('); i >= 0; i = text.indexOf('$(', i + 2)) {
    let depth = 0;
    let end = -1;
    for (let j = i + 1; j < text.length && end < 0; j++) {
      if (text[j] === '(') depth += 1;
      else if (text[j] === ')' && --depth === 0) end = j;
    }
    if (end < 0) break;
    found.push(...segments(text.slice(i + 2, end), shell));
  }
  return found;
}

const expandHome = (w, roots) => w.replace(/^(~|\$HOME|\$env:USERPROFILE|%USERPROFILE%)(?=[\\/])/i, roots.home);

const READERS = /^(cat|head|tail|less|more|type|sed|bat|get-content|gc)$/i;
const PREFIXES = /^(sudo|time|command|builtin|nice|exec|env|if|elif|then|else|while|until|do|!)$/i;
// engram search 會帶值的選項；其他 -- 開頭的是旗標（--json）
const SEARCH_VALUE_OPTIONS = new Set(['--limit']);

/** 一段指令的參數，去掉開頭的 {、環境變數設定與 sudo、time、if、then、do 這類前綴 */
function commandWords(segment, bash) {
  const w = words(segment.replace(/^\{\s*/, ''), bash);
  while (w.length && (PREFIXES.test(w[0]) || /^[A-Za-z_]\w*=/.test(w[0]))) w.shift();
  return w;
}

/** engram search 之後的參數裡的關鍵字：略過選項與帶值選項的值（--limit 10、--limit=10） */
function searchQuery(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (SEARCH_VALUE_OPTIONS.has(t)) i += 1;
    else if (!t.startsWith('--')) out.push(t);
  }
  return out.join(' ');
}

/** 拿掉 heredoc 的內容：那是要寫進檔案或交給程式的資料，不是讀取 */
export function stripHeredocs(command) {
  const lines = String(command ?? '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    // <<EOF、<<'EOF'、<<-"END"。排除 here-string（<<<）與算術位移（1 << n）：結束標記要加引號或全大寫，後面也真的有結束行
    const m = /(?<!<)<<(?!<)-?\s*(?:(['"])([A-Za-z_][\w-]*)\1|([A-Z_][A-Z0-9_]*)\b)/.exec(lines[i]);
    if (!m) continue;
    const end = m[2] ?? m[3];
    const close = lines.findIndex((l, j) => j > i && l.replace(/^\t+/, '') === end);
    if (close > i) i = close;
  }
  return out.join('\n');
}

/**
 * 讀檔指令的檔案參數：略過選項與輸出目標（> >>）、heredoc 標記（<<）；輸入重新導向（< file）也是讀取。
 * sed -i 是就地改寫，不算讀取。
 */
function readerArgs(w) {
  if (!w.length || !READERS.test(w[0])) return [];
  if (/^sed$/i.test(w[0]) && w.some((t) => /^-[a-zA-Z]*i|^--in-place/.test(t))) return [];
  const args = [];
  for (let i = 1; i < w.length; i++) {
    let t = w[i];
    if (t === '<') {
      if (w[i + 1]) args.push(w[i + 1]);
      i += 1;
      continue;
    }
    if (/^\d*(>>?|<<-?)&?$/.test(t)) {
      i += 1; // 運算子和目標分開寫：> file、<< EOF
      continue;
    }
    if (/^<(?!<)/.test(t)) {
      args.push(t.slice(1).replace(/^(["'])(.*)\1$/, '$2')); // <file、<"file"
      continue;
    }
    if (/^\d*[<>]/.test(t) || t.startsWith('-')) continue; // >file、<<EOF、選項
    const cut = t.search(/[<>]/); // file.md>out：取 > 之前
    if (cut > 0) t = t.slice(0, cut);
    args.push(t.replace(/\}+$/, '')); // { cat x.md}（PowerShell 的區塊結尾黏在參數上）
  }
  return args;
}

/**
 * 解析 Bash／PowerShell 指令裡讀取與搜尋記憶的動作。heredoc 內容與寫入目標不算；
 * 相對路徑以工作目錄解析，同一行裡的 cd 會跟著改變基準。同一條指令可以同時有搜尋與讀取。
 * 回傳的 paths 只是「指令提到的」，呼叫端還要確認檔案存在。
 * @param {'bash' | 'powershell'} [shell] 哪個工具的指令：PowerShell 的 \ 是路徑分隔，不是跳脫字元
 * @returns {{ search: string | null, paths: string[] } | null}
 */
export function parseCommand(command, roots, shell = 'bash') {
  const bash = shell !== 'powershell';
  let base = normPath(roots.cwd);
  let search = null;
  const paths = [];
  for (const seg of segments(bash ? stripHeredocs(command) : command, shell)) {
    const w = commandWords(seg, bash);
    if (!w.length) continue;
    if (/^(cd|pushd|set-location)$/i.test(w[0])) {
      if (w[1]) base = resolvePath(base, expandHome(w[1], roots), roots.home);
      continue;
    }
    if (/^engram(\.cmd)?$/i.test(w[0])) {
      if (w[1] === 'search' && search === null) search = searchQuery(w.slice(2));
      else if (w[1] === 'memory' && w[2] === 'show') {
        for (const ref of w.slice(3)) if (/^(global|projects|machines)\/.+\.md$/i.test(ref)) paths.push(`${normPath(roots.vault)}/${ref}`);
      }
      continue;
    }
    for (const a of readerArgs(w)) {
      if (!/\.md$/i.test(a)) continue;
      const p = resolvePath(base, expandHome(a, roots), roots.home);
      if (classify(p, roots)) paths.push(p);
    }
  }
  return search !== null || paths.length ? { search, paths: [...new Set(paths)] } : null;
}

/**
 * 從搜尋結果的文字找出記憶檔：一行一個的路徑（可以含空白，也接受 Grep 的「路徑:行號:內容」）、
 * 夾在文字中的路徑，或 --json 輸出的 "ref"。回傳正斜線路徑、不重複。
 * @returns {string[]}
 */
export function searchHits(text, roots) {
  const t = String(text ?? '');
  const found = [];
  for (const m of t.matchAll(/^[ \t•*-]*((?:[A-Za-z]:[\\/]|\/)[^\r\n"'<>|*?]*?\.md)(?::\d+(?:[:-].*)?)?[ \t]*$/gm)) found.push(m[1]);
  for (const m of t.matchAll(/(?:[A-Za-z]:[\\/]|\/)[^\s"'<>|*?]+?\.md\b/g)) found.push(m[0]);
  for (const m of t.matchAll(/"ref"\s*:\s*"([^"]+\.md)"/g)) found.push(`${normPath(roots.vault)}/${m[1]}`);
  const out = new Map();
  for (const p of found) if (classify(p, roots)) out.set(lower(p), normPath(p));
  return [...out.values()];
}

const STRONGER = { search: 0, nested: 1, read: 2 };

/**
 * 把一筆讀取加進清單：同一個檔案只留一列，次數加一。讀全文比只看到搜尋摘要強：
 * search 之後再 read 會升級成 read（回合改成讀的那一回合）；讀過之後又出現在搜尋結果，不改寫怎麼讀、第幾回合。
 */
export function mergeEntry(list, entry) {
  const i = list.findIndex((x) => x.id === entry.id);
  if (i < 0) return [...list, { ...entry, times: 1 }];
  const prev = list[i];
  const times = (prev.times ?? 1) + 1;
  const merged =
    (STRONGER[entry.how] ?? 0) >= (STRONGER[prev.how] ?? 0)
      ? { ...prev, ...entry, times, query: entry.query ?? prev.query }
      : { ...prev, times, query: prev.query ?? entry.query };
  return list.map((x, j) => (j === i ? merged : x));
}

/** @typedef {'all' | 'core' | 'global' | 'machine' | 'project' | 'instructions'} Filter */
/** @type {Filter[]} */
const FILTERS = ['all', 'core', 'global', 'machine', 'project', 'instructions'];

/**
 * @param {Filter} cur
 * @returns {Filter}
 */
export function nextFilter(cur) {
  return FILTERS[(FILTERS.indexOf(cur) + 1) % FILTERS.length] ?? 'all';
}

export function formatTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  return n < 1000 ? String(Math.round(n)) : `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
}

/** 終端機寬度：中日韓全形字與 emoji 佔兩格 */
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s ?? '')) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

/** 截到指定寬度，超過時結尾加「…」 */
export function truncate(s, max) {
  const str = String(s ?? '');
  if (displayWidth(str) <= max) return str;
  if (max <= 1) return max === 1 ? '…' : '';
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = WIDE.test(ch) ? 2 : 1;
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** 補空白到指定寬度 */
export function padEnd(s, width) {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}
