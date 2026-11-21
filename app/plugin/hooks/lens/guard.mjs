// 護欄（2.0.0 WP4b）：把「踩過的坑」編成規則，在 Bash／PowerShell 指令送出前比對。
// 把握高的直接擋下並附正確寫法，把握低的只在結果後附提醒。
// 純函式、不依賴 Node API：mod（hooks/guard.ts）與 Node 端（core/guardrails.mjs、engram guardrails、開場訊息）共用同一份比對。
// 原則：寧可漏擋，不可誤擋。
//
// 信任層級：
// - 內建的預設規則（以及內容與內建規則完全相同的規則）是程式碼的一部分，自己負責不卡住、不誤擋。
// - 規則檔 vault/guardrails/rules.json 會同步到每台電腦，內容可能是人或 LLM 打的：樣式用保守的規則驗證、
//   只比對指令的前面一段、單條規則比對太久就在本機停用；擋下類的規則要在這台電腦核可過才真的擋下，沒核可只當提醒。

/** 規則檔來的樣式與例外樣式的長度上限；超過就略過那一條 */
export const MAX_PATTERN_LENGTH = 300;
/** 規則檔最多載入幾條；訊息最長幾個字元 */
export const MAX_RULES = 100;
export const MAX_MESSAGE_LENGTH = 300;
/**
 * 規則檔來的樣式：{n}、{n,m} 的次數上限，以及一條樣式（pattern 與 unless 各自計算）裡最多幾個不限次數的量詞（*、+、{n,}）：
 * 能吃大範圍字元的（. 與 [\s\S]、[^…]、\S、\D、\W 這類幾乎什麼都吃的字元類）最多 1 個，其他最多 2 個。
 * 比對沒有錨點時每個起點都要重跑，n 個互相牽制的不限次數量詞是 O(n^(k+1))：兩個大範圍的量詞，對 500 字元的指令就要好幾秒。
 */
export const MAX_REPEAT = 20;
export const MAX_WIDE_UNBOUNDED = 1;
export const MAX_OTHER_UNBOUNDED = 2;
export const MAX_UNBOUNDED = MAX_WIDE_UNBOUNDED + MAX_OTHER_UNBOUNDED;
/** 有上限的可變量詞（?、{n,m}）最多幾個：每個都讓比對多一種切法 */
export const MAX_BOUNDED_VARIABLE = 4;
/** 連續（中間沒有一定要出現的字元）的可變長度量詞，到這個數量就拒絕：\s*\s*\s*x 這種寫法對一長串空白是 O(n^3) */
export const MAX_ADJACENT = 3;
/**
 * 有上限的可變量詞（?、{n,m}）的可選次數相乘的上限：a{0,20}a{0,20}a{0,20}b 有 9,261 種切法，對 2,000 字元要 70～110 毫秒。
 * 樣式裡有不限次數的量詞時更嚴：切法會再乘上整段指令的長度（.{0,20}\s*aa 對 2,000 字元要 60 毫秒）。
 */
export const MAX_CHOICES = 500;
export const MAX_CHOICES_WITH_LOOPS = 4;
/**
 * 比對前截斷指令：內建規則看前 4,000 字元，規則檔來的規則只看前 2,000 字元（樣式有「會有很多種切法」的量詞時 500，見下）。
 * 內建規則原本看前 20,000 字元，對抗輸入（<<A 加換行重複幾千次，每個 heredoc 開頭都要一路掃到結尾）最慢：
 * 規則 3 要 2,070 毫秒、規則 1 要 357 毫秒；4,000 字元最慢 89 毫秒（規則 3），都低於 200 毫秒。
 */
export const MAX_COMMAND_LENGTH = 4000;
export const MAX_UNTRUSTED_COMMAND_LENGTH = 2000;
/**
 * 規則檔來的規則，樣式裡有「會有很多種切法」的不限次數量詞（後面接的東西它也吃得到：.{2,}.\waa、git\s+push\s+.*--force）時，
 * 沒有錨點的比對每個起點都要把整段後面重跑一遍，時間隨長度的平方成長：2,000 字元的對抗輸入要 250 毫秒，500 字元只要 16 毫秒。
 * 這種規則只看指令的前 500 字元。
 * 量測基準（Node 26 / V8）：隨機樣式模糊測試，通過驗證的樣式經 evaluate 比對 2,000 字元的對抗輸入（含非 ASCII 的字元類與填充），
 * 預設的原生編譯：ASCII 樣式 3 萬條嘗試（9,798 條通過）最慢 9 毫秒；含非 ASCII 的 2 萬條嘗試（4,762 條通過）最慢 13 毫秒。
 * V8 對 1,000 字元以上的字串，正規表示式第一次執行就編成原生碼（實測：2,000 字元第一次 4 毫秒）。
 * 強制直譯（--regexp-interpret-all，比原生慢約 16 倍，只用來壓力測試）：ASCII 樣式 7,800 多條通過、沒有超過 50 毫秒，最慢 40 毫秒
 * （\s*aa[a-z] 對 2,000 個空白）；含非 ASCII 的（雙位元組字串，直譯更慢）2,848 條通過裡有 469 次超過 50 毫秒，最慢 124 毫秒
 * （[aа-я]?[aа-я]{2,}é 對 2,000 個西里爾字母）。要是 mod 的執行環境比原生慢那麼多，把 MAX_UNTRUSTED_COMMAND_LENGTH 降到 1,000 就夠（時間隨長度平方成長）。
 * 不經過 500 字元截短、直接比對 2,000 字元時，直譯模式的 \w{2,}[^a]?\wa 要 57 毫秒，所以那一段截短是必要的。
 * mod 實際跑在 Claude Code 的執行環境，這裡沒有量過它的正規表示式引擎；超過 SLOW_MS 的本機停用是最後一道防線。
 */
export const MAX_AMBIGUOUS_COMMAND_LENGTH = 500;
/** 規則檔來的規則單次比對超過這麼久（毫秒），mod 就在本機停用那條規則 */
export const SLOW_MS = 50;
/** 被誤擋而降成提醒的規則，幾天後自動恢復 */
export const FALSE_BLOCK_DAYS = 14;
/** 開場訊息的後備提示最多列幾條 */
export const SUMMARY_LIMIT = 6;
const TOOLS = ['Bash', 'PowerShell', '*'];
const ACTIONS = ['block', 'hint'];
// g、y 會讓 RegExp 帶著 lastIndex，同一條規則第二次比對結果會不一樣
// u 旗標不收：\p{L} 之類的寫法與字元類的內容在 u 旗標下意思不同，驗證用的樣本字元集會算錯
const FLAGS = /^[ims]*$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DAY_MS = 86_400_000;

export const PREFIX = '[Engram 護欄]';

function stripBom(text) {
  const s = String(text);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// ───────── 內建的預設規則 ─────────
// 樣式一律用正規表示式字面值（取 .source）或 String.raw，不用一般字串，避免雙重跳脫寫錯。
// 規則檔 vault/guardrails/rules.json 不存在時使用這 6 條；存在時以規則檔為準（內容與內建完全相同的規則照樣視為內建）。

/** 中日韓文字：中日韓符號與假名、漢字（含擴充 A）、韓文音節、全形字元。用程式組出範圍，避免在原始碼裡放看不見的字元 */
const CJK = `[${[[0x3000, 0x9fff], [0xac00, 0xd7af], [0xff00, 0xffef]].map(([from, to]) => `\\u${from.toString(16)}-\\u${to.toString(16)}`).join('')}]`;

/** 指令位置：行首，或 ;、&（&&）、|（||、管線）、(、換行之後。引號裡提到的 python -c 之類的文字不算 */
const AT_COMMAND = String.raw`(?:^|[;&|(\n])[ \t]*`;
/**
 * 程式名稱與旗標之間最多隔 6 個參數（同一段指令，參數裡不能有引號）。
 * 一定要有上限：不限長度的「任意字元 + 惰性」遇到重複很多次 node -e 的超長指令會變成三次方的回溯。
 */
const SKIP = String.raw`(?:[ \t]+[^\s"'|;&]+){0,6}?[ \t]+`;
/** 行內腳本：node -e／-p、python -c、powershell -Command／-c，後面緊接的就是那個引號參數 */
const INLINE_HEAD = `${AT_COMMAND}${String.raw`(?:node|nodejs|python3?(?:\.\d+)?|py|powershell|pwsh)(?:\.exe)?`}${SKIP}${String.raw`-{1,2}(?:e|eval|p|print|c|command)[ \t]+`}`;
/** 雙引號參數的內容：跳脫的字元成對消耗，所以找得到真正的結束引號 */
const DQ = String.raw`(?:[^"\\]|\\[\s\S])`;
/** heredoc 的開頭行（不含 <<<），與本文：本文只到結束行（只有分隔字的那一行）為止，不會比到指令的後面 */
const HEREDOC_OPEN = String.raw`(?:^|[^<])<<-?[ \t]*(["']?)([A-Za-z_]\w*)\1[^\n]*\n`;
const HEREDOC_END = String.raw`\t*\2[ \t]*(?:\n|$)`;
const heredocBody = (x) => String.raw`(?:(?!${HEREDOC_END})[^\n]*\n)*(?!${HEREDOC_END})[^\n]*${x}`;

export const DEFAULT_RULES = [
  {
    id: 'bash-heredoc-triple-quote',
    tool: 'Bash',
    pattern: `${HEREDOC_OPEN}${heredocBody("'''")}`,
    flags: '',
    unless: '',
    action: 'hint',
    message: 'Bash 的 heredoc 內含 Python 的三個單引號（\'\'\'）會讓整個指令解析失敗，請改用寫檔工具寫成檔案再執行。這類腳本不要放在 heredoc 裡。',
    messageEn: "Python triple single quotes (''') inside a Bash heredoc make the whole command fail to parse. Write the script to a file with the file-writing tool and run that instead. Do not put such scripts in a heredoc.",
    source: 'Bash 工具對 heredoc 內三個單引號的解析限制（內建規則）',
    addedAt: '2026-11-20',
    by: 'engram',
  },
  {
    id: 'inline-script-double-backslash',
    tool: 'Bash',
    // 單引號參數裡的兩個反斜線，或雙引號參數裡的四個反斜線、兩個反斜線後面接 "、$、反引號（\x60）。
    // 雙引號裡的兩個反斜線本來就會被 bash 變成一個，收不收結果一樣，不擋
    pattern: `${INLINE_HEAD}${String.raw`(?:'[^']*\\\\|"${DQ}*(?:\\\\\\\\|\\\\["$\x60]))`}`,
    flags: 'i',
    unless: '',
    action: 'block',
    silentFailure: true,
    message: '行內腳本（node -e、python -c、powershell -Command）的單引號參數裡連續兩個反斜線，會被 Bash 工具收成一個，輸出會悄悄變錯而且結束碼仍是 0，請改用寫檔工具寫成檔案再執行。雙引號參數裡連續四個反斜線，或兩個反斜線後面接引號、$、反引號，也會被改掉。改成檔案之後用 node、python 或 powershell -File 執行即可。',
    messageEn: 'The Bash tool collapses two backslashes in a single-quoted inline script (node -e, python -c, powershell -Command) into one, so the output silently changes while the exit code stays 0. Write the script to a file with the file-writing tool and run it with node, python or powershell -File.',
    source: 'Bash 工具會把單引號參數與 heredoc 裡的雙反斜線收成一個（內建規則）',
    addedAt: '2026-11-20',
    by: 'engram',
  },
  {
    id: 'inline-script-cjk',
    tool: 'Bash',
    // 行內腳本的那個引號參數裡有中日韓文字，或 heredoc 本文有
    pattern: `${INLINE_HEAD}${String.raw`(?:'[^']*${CJK}|"${DQ}*?${CJK})`}|${HEREDOC_OPEN}${heredocBody(CJK)}`,
    flags: 'i',
    unless: '',
    action: 'hint',
    silentFailure: true,
    message: '行內腳本或 heredoc 含有中日韓文字時可能變成亂碼，請改用寫檔工具寫成檔案再執行或讀取。例如提交訊息用 git commit -F 檔案。',
    messageEn: 'Chinese, Japanese or Korean text in an inline script or heredoc may get garbled. Write it to a file with the file-writing tool and run or read that file instead, for example git commit -F <file> for a commit message.',
    source: 'Bash 工具對行內腳本與 heredoc 內中日韓文字的處理限制（內建規則）',
    addedAt: '2026-11-20',
    by: 'engram',
  },
  {
    id: 'powershell-command-shell-variable',
    tool: 'Bash',
    pattern: `${AT_COMMAND}${String.raw`(?:powershell|pwsh)(?:\.exe)?`}${SKIP}${String.raw`-(?:command|c)[ \t]+"(?:[^"\\$]|\\[\s\S]|\$(?![A-Za-z_]))*\$[A-Za-z_]`}`,
    flags: 'i',
    unless: '',
    action: 'block',
    message: 'Bash 雙引號裡的 powershell -Command 含 $_ 或 $變數會先被 bash 展開而壞掉，請改寫成 .ps1 檔再用 -File 執行。請用寫檔工具建立 .ps1 檔，執行時寫 powershell -File 檔案路徑。',
    messageEn: 'A $_ or $variable in powershell -Command inside Bash double quotes is expanded by bash first and breaks the command. Write a .ps1 file with the file-writing tool and run it with powershell -File <path>.',
    source: 'Bash 雙引號內的 $ 會先被 bash 展開（內建規則）',
    addedAt: '2026-11-20',
    by: 'engram',
  },
  {
    id: 'msys-path-conversion',
    tool: 'Bash',
    pattern: `${AT_COMMAND}${String.raw`(?:az|(?:docker(?:[ \t]+compose)?|docker-compose)[ \t]+exec|kubectl[ \t]+exec)(?=\s)[^\n|;&]*?(?:\s["']?\/[A-Za-z]|\s--[\w-]+=["']?\/[A-Za-z])`}`,
    flags: '',
    unless: /MSYS2?_(?:NO_PATHCONV|ARG_CONV_EXCL)/.source,
    action: 'hint',
    message: 'Git Bash 會把以 / 開頭的參數（如 az 的 --scope、docker exec 的路徑）改寫成 Windows 路徑，請在指令前加上 MSYS_NO_PATHCONV=1。例如 MSYS_NO_PATHCONV=1 az role assignment list --scope /subscriptions/...。',
    messageEn: 'Git Bash rewrites arguments that start with / (such as az --scope or docker exec paths) into Windows paths. Put MSYS_NO_PATHCONV=1 before the command, for example MSYS_NO_PATHCONV=1 az role assignment list --scope /subscriptions/...',
    source: 'Git Bash（MSYS）自動轉換路徑參數（內建規則）',
    addedAt: '2026-11-20',
    by: 'engram',
  },
  {
    id: 'rm-shell-variable',
    tool: 'Bash',
    pattern: /(?:^|[;&|({\n])[ \t]*(?:sudo[ \t]+)?(?:rm|rmdir)[ \t]+[^\n|;&']*\$[A-Za-z_{]/.source,
    flags: '',
    unless: '',
    action: 'hint',
    message: 'rm／rmdir 的目標含有 shell 變數時，Claude Code 的安全檢查可能拒絕執行，請改寫成字面的絕對路徑。',
    messageEn: 'When an rm or rmdir target contains a shell variable, the Claude Code safety check may refuse to run it. Write the literal absolute path instead.',
    source: 'Claude Code 對含 shell 變數的刪除目標的安全檢查（內建規則）',
    addedAt: '2026-11-20',
    by: 'engram',
  },
];

// ───────── SHA-256（純 JavaScript：mod 裡沒有 crypto；規則核可與「內容和內建規則相同」都用它比對內容） ─────────

let SHA_K = null;
let SHA_H = null;

function shaInit() {
  SHA_K = [];
  SHA_H = [];
  const frac = (x) => Math.floor((x - Math.floor(x)) * 4294967296);
  for (let n = 2; SHA_K.length < 64; n++) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
    if (!prime) continue;
    if (SHA_H.length < 8) SHA_H.push(frac(Math.sqrt(n)));
    SHA_K.push(frac(Math.pow(n, 1 / 3)));
  }
}

function utf8Bytes(text) {
  const out = [];
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** 文字（UTF-8）的 SHA-256，十六進位小寫 64 字元 */
export function sha256Hex(text) {
  if (!SHA_K) shaInit();
  const bytes = utf8Bytes(text);
  const bits = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bits / 4294967296);
  const lo = bits >>> 0;
  for (const word of [hi, lo]) bytes.push((word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const h = SHA_H.slice();
  const w = new Array(64);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = ((bytes[off + 4 * t] << 24) | (bytes[off + 4 * t + 1] << 16) | (bytes[off + 4 * t + 2] << 8) | bytes[off + 4 * t + 3]) >>> 0;
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[t] + w[t]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((v, i) => { h[i] = (h[i] + v) >>> 0; });
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('');
}

/**
 * 規則內容的雜湊（只含會影響比對與擋下行為的欄位；source、addedAt、by 這些說明欄位不算）。
 * messageEn 有寫才算進去（沒有 messageEn 的規則雜湊和之前一樣，核可紀錄照舊有效）
 */
export function ruleHash(rule) {
  return sha256Hex(JSON.stringify([rule.id, rule.tool, rule.pattern, rule.flags, rule.unless, rule.action, rule.message, rule.silentFailure === true, ...(rule.messageEn ? [rule.messageEn] : [])]));
}

// ───────── 規則樣式的保守驗證（規則檔來的樣式） ─────────

class PatternError extends Error {}

/** 多個字元的跳脫（\x 加兩位數字、\u 加四位數字、\cA、\p{L}、\k<名稱>、\1 反向參照、\0）：成員藏在跳脫裡，樣本字元看不到，直接寫字元 */
const MULTI_ESCAPE = /[xucpPk0-9]/;
const multiEscapeReason = (n) => `不支援 \\${n} 這種跳脫寫法（\\x、\\u、\\c、\\p、\\k、反向參照）：請直接寫字元`;

/** 跳過一個字元類，回傳 ] 之後的位置；字元類裡的 \x80-\xff、Ѐ-ӿ 也一樣藏著樣本字元看不到的成員，直接略過 */
function skipClass(src, i) {
  let j = i + 1;
  while (j < src.length && src[j] !== ']') {
    if (src[j] === '\\') {
      if (MULTI_ESCAPE.test(src[j + 1] ?? '')) throw new PatternError(multiEscapeReason(src[j + 1]));
      j += 2;
    } else j += 1;
  }
  return j + 1;
}

/** 兩組樣本字元（布林陣列）有沒有交集 */
function overlaps(a, b) {
  return a.some((v, k) => v && b[k]);
}

/** 這一組分支是不是都是純文字、而且沒有一個是另一個的開頭（這樣被重複也不會重疊） */
function literalPrefixFree(branches, ignoreCase) {
  if (branches.some((b) => !b.literal || b.chars.length === 0)) return false;
  // 有 i 旗標時 ab 與 AB 是同一個分支：先轉小寫再比
  const words = branches.map((b) => (ignoreCase ? b.chars.join('').toLowerCase() : b.chars.join('')));
  return words.every((a, i) => words.every((b, j) => i === j || !b.startsWith(a)));
}

/**
 * 保守的樣式檢查，回傳 null（通過）或不通過的原因。不通過的寫法：
 * - {n}、{n,m} 的次數超過 MAX_REPEAT；能吃大範圍字元的不限次數量詞（. 與 [^…]、[\s\S]、\S 加 *、+、{n,}）超過 MAX_WIDE_UNBOUNDED 個，
 *   其他的不限次數量詞超過 MAX_OTHER_UNBOUNDED 個；有上限的可變量詞（?、{n,m}）超過 MAX_BOUNDED_VARIABLE 個
 * - 三個可變長度的量詞（*、+、{n,}、{n,m}）相鄰（中間沒有一定要出現的字元），例如 \s*\s*\s*x、\w{1,20}\w{1,20}\w{1,20}x
 * - 群組裡有任何可變長度的量詞（?、{n,m}、*、+），群組又被重複，例如 (a+)+、(?:[\s\S]*,){6}、(?:\w\w?)+、(?:a{1,20}){1,20}；
 *   只有固定次數 {n} 的量詞可以放在被重複的群組裡
 * - 群組裡有可能重疊的分支，群組又被重複，例如 (?:\d|\w)+、(a|ab)+，有 i 旗標時 (?:ab|AB)+ 也是
 * - 重複的群組裡又有重複的群組
 * 寧可略過合法的規則，也不要讓比對卡住。任何無法解析的寫法都當成不通過；解析的迴圈每一圈一定往前進。
 * opts.ignoreCase：樣式帶 i 旗標（分支用小寫比較）。
 */
export function analyzePattern(source, { ignoreCase = false } = {}) {
  const src = String(source);
  let i = 0;
  let ambiguousLoops = false; // 有「會有很多種切法」的不限次數量詞：比對的指令要截得更短（MAX_AMBIGUOUS_COMMAND_LENGTH）
  let wideUnbounded = 0;
  let otherUnbounded = 0;
  let boundedVariable = 0;
  let choices = 1; // 有上限的可變量詞，每個的可選次數相乘
  const fail = (reason) => { throw new PatternError(reason); };

  // 樣本字元：可列印字元、換行、tab、一個中文字、幾個非 ASCII 的空白（\s 吃得到），加上樣式裡出現的每一種非 ASCII 字元。
  // 每個單一字元的元素（字元、跳脫、字元類）能吃哪些樣本，拿來判斷「大範圍」與「兩個元素吃得到同一個字元」。
  // 字元類的成員都是樣式裡直接寫出來的字元（多字元的跳脫已經拒絕），範圍 [α-ω] 的兩端也是樣本，
  // 所以兩個範圍只要有重疊，一定有一個樣本兩邊都吃得到；樣式裡的非 ASCII 字元太多，樣本放不下就略過整條。
  // 需要兩個字碼單元的字元（表情符號）一個字元會被拆成兩個元素，樣本也對不上，不收
  const hasSurrogate = [...src].some((ch) => { const p = ch.codePointAt(0); return p > 0xffff || (p >= 0xd800 && p <= 0xdfff); });
  const literals = [...new Set(src)].filter((ch) => ch.charCodeAt(0) > 0x7e && !PROBES.includes(ch) && !SPACE_PROBES.includes(ch));
  const probes = [...PROBES, ...SPACE_PROBES, ...literals.slice(0, MAX_NON_ASCII)];
  const bitsCache = new Map();
  const bitsOf = (atomSource) => {
    let bits = bitsCache.get(atomSource);
    if (!bits) {
      bits = probes.map(() => true); // 反向參照之類無法判斷的：當成什麼都吃
      if (!/^\\[1-9]/.test(atomSource)) {
        try {
          const re = new RegExp(`^(?:${atomSource})$`, ignoreCase ? 'i' : '');
          bits = probes.map((p) => re.test(p));
        } catch { /* 無法判斷，當成什麼都吃 */ }
      }
      bitsCache.set(atomSource, bits);
    }
    return bits;
  };
  const nothing = probes.map(() => false);
  const union = (a, b) => a.map((v, k) => v || b[k]);

  function quantifier() {
    const c = src[i];
    let q = null;
    if (c === '*') { q = { min: 0, max: Infinity }; i += 1; } else if (c === '+') { q = { min: 1, max: Infinity }; i += 1; } else if (c === '?') { q = { min: 0, max: 1 }; i += 1; } else if (c === '{') {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(src.slice(i, i + 24));
      if (m) {
        const min = Number(m[1]);
        q = { min, max: m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]) };
        i += m[0].length;
      }
    }
    if (q && src[i] === '?') i += 1; // 量詞後面的 ? 是惰性標記（?? 也是）
    if (q && ((Number.isFinite(q.max) && q.max > MAX_REPEAT) || q.min > MAX_REPEAT)) fail(`次數上限超過 ${MAX_REPEAT}`);
    return q;
  }

  /** 解析一個群組的內容（到 ) 或結尾為止，不消耗 )） */
  function alternation() {
    // set：這個群組裡所有元素吃得到的樣本字元；loops：裡面不限次數量詞的個數；sequences：每個分支的元素（依序）
    const info = { hasUnbounded: false, hasVariable: false, hasWide: false, nonLiteralAlt: false, repeatedGroup: false, set: nothing, loops: 0, sequences: [] };
    const branches = [];
    let branch = { literal: true, chars: [] };
    let seq = [];
    let run = 0; // 連續可變長度的量詞有幾個（中間沒有一定要出現的字元）
    while (i < src.length && src[i] !== ')') {
      const before = i;
      if (src[i] === '|') {
        branches.push(branch);
        info.sequences.push(seq);
        branch = { literal: true, chars: [] };
        seq = [];
        run = 0;
        i += 1;
        continue;
      }
      // 一個元素
      const atom = { kind: 'char', lit: null, info: null };
      const c = src[i];
      if (c === '\\') {
        const n = src[i + 1] ?? '';
        // 多個字元的跳脫（見 MULTI_ESCAPE）：量詞會落在錯的元素上，樣本字元集也算錯，
        // \x61*a\x61*z 會被當成兩個沒有牽制的量詞，對 2,000 字元的 a 要 1 秒。直接寫字元
        if (MULTI_ESCAPE.test(n)) fail(multiEscapeReason(n));
        i += 2;
        atom.kind = /[bB]/.test(n) ? 'zero' : 'esc';
        if (n && !/[A-Za-z0-9]/.test(n)) atom.lit = n;
        else if (/[nrt]/.test(n)) atom.lit = `\\${n}`;
      } else if (c === '[') {
        i = skipClass(src, i);
        atom.kind = 'class';
      } else if (c === '(') {
        i += 1;
        let zero = false;
        if (src[i] === '?') {
          if (src[i + 1] === ':') i += 2;
          else if (src[i + 1] === '=' || src[i + 1] === '!') { i += 2; zero = true; } else if (src[i + 1] === '<' && (src[i + 2] === '=' || src[i + 2] === '!')) { i += 3; zero = true; } else if (src[i + 1] === '<') {
            const end = src.indexOf('>', i);
            if (end < 0) fail('具名群組沒有結尾');
            i = end + 1;
          } else fail('不支援的群組寫法');
        }
        atom.info = alternation();
        if (src[i] !== ')') fail('括號不成對');
        i += 1;
        atom.kind = zero ? 'zero' : 'group';
      } else if (c === '.') {
        i += 1;
        atom.kind = 'any';
      } else if (c === '^' || c === '$') {
        i += 1;
        atom.kind = 'zero';
      } else {
        i += 1;
        atom.lit = c;
      }
      if (i > src.length) fail('樣式沒有寫完'); // 結尾的反斜線、沒有 ] 的字元類
      // 這個元素吃得到哪些樣本字元：單一字元的元素各自測；群組是裡面所有元素的聯集；錨點與 \b 不吃字元
      atom.set = atom.kind === 'zero' && !atom.info ? nothing : atom.info ? atom.info.set : bitsOf(src.slice(before, i));
      // 能吃大範圍字元的元素：. 與 [^…]、[\s\S]、\S、\D 這類幾乎什麼都吃的字元類（命中超過四分之三的樣本）；群組裡有就算群組有
      atom.wide = atom.kind === 'any' || (!atom.info && atom.kind !== 'zero' && atom.set.slice(0, PROBES.length).filter(Boolean).length >= PROBES.length * 0.75) || !!atom.info?.hasWide;
      const q = quantifier();
      const isUnbounded = !!q && !Number.isFinite(q.max);
      const isVariable = !!q && q.min < q.max; // 每次可以吃不同長度（?、{n,m}、*、+）：被重複時比對失敗要走遍所有切法
      const isMulti = isVariable && q.max > 1; // 可變長度，而且可以吃好幾個
      const repeated = !!q && q.max > 1;
      const inner = atom.info;
      if (inner && repeated) {
        if (inner.hasVariable) fail('群組裡有可變長度的量詞（?、{n,m}、*、+），群組又被重複');
        if (inner.nonLiteralAlt) fail('群組裡有可能重疊的分支，群組又被重複');
        if (inner.repeatedGroup) fail('重複的群組裡又有重複的群組');
      }
      if (isUnbounded) {
        if (atom.wide) {
          wideUnbounded += 1;
          if (wideUnbounded > MAX_WIDE_UNBOUNDED) fail(`能吃大範圍字元的不限次數量詞（. 與 [^…]、[\\s\\S]、\\S 加 *、+、{n,}）超過 ${MAX_WIDE_UNBOUNDED} 個`);
        } else {
          otherUnbounded += 1;
          if (otherUnbounded > MAX_OTHER_UNBOUNDED) fail(`其他的不限次數量詞（*、+、{n,}）超過 ${MAX_OTHER_UNBOUNDED} 個`);
        }
      } else if (isVariable) {
        boundedVariable += 1;
        if (boundedVariable > MAX_BOUNDED_VARIABLE) fail(`有上限的可變量詞（?、{n,m}）超過 ${MAX_BOUNDED_VARIABLE} 個`);
        choices *= q.max - q.min + 1; // 相乘的上限在整個樣式解析完之後才檢查（要看有沒有不限次數的量詞）
      }
      if (isMulti && run >= MAX_ADJACENT - 1) fail(`${MAX_ADJACENT} 個可變長度的量詞相鄰`);
      if (isUnbounded || inner?.hasUnbounded) info.hasUnbounded = true;
      if (isVariable || inner?.hasVariable) info.hasVariable = true;
      if (atom.wide) info.hasWide = true;
      if (inner?.nonLiteralAlt) info.nonLiteralAlt = true;
      if (inner && (repeated || inner.repeatedGroup)) info.repeatedGroup = true;
      if (isMulti) run += 1;
      else if (atom.kind === 'zero' || (q && q.min === 0)) { /* 不改變：零寬或可有可無 */ } else run = inner?.hasUnbounded ? 1 : 0;
      if (q || atom.lit === null) branch.literal = false;
      else branch.chars.push(atom.lit);
      info.set = union(info.set, atom.set);
      info.loops += (isUnbounded ? 1 : 0) + (inner ? inner.loops : 0);
      // 元素：沒有量詞的群組、只有一個分支的，直接把裡面的元素接進來（分析「後面接什麼」時才看得到）；其他群組當成一個整體
      if (inner && !q && atom.kind === 'group' && inner.sequences.length === 1) seq.push(...inner.sequences[0]);
      else seq.push({ set: atom.set, min: q ? q.min : 1, unbounded: isUnbounded, zero: atom.kind === 'zero', inner: inner ? inner.loops : 0 });
      if (i <= before) fail('無法解析'); // 保險：位置沒有前進就中止
    }
    branches.push(branch);
    info.sequences.push(seq);
    if (branches.length > 1 && !literalPrefixFree(branches, ignoreCase)) info.nonLiteralAlt = true;
    return info;
  }

  /**
   * 不限次數的量詞能不能讓比對的時間隨長度的平方以上成長。沒有錨點的比對每個起點都重跑，一個「後面接的東西它也吃得到」的量詞
   * （例如 .*a、\w*\w、[a-z]*(?:aa)）有很多種切法，後面每多一個不限次數的量詞，時間就再乘上長度：
   * 兩個互相牽制的量詞對 2,000 字元要好幾秒。所以：第一個「會有很多種切法」的量詞之後，不能再有任何不限次數的量詞
   * （前面的、各自被一個吃不到的字元隔開的量詞沒問題，例如 rm\s+-rf\s+/ 的兩個 \s+）。
   * 群組裡的不限次數量詞，後面接什麼不清楚，一律當成會有很多種切法。
   */
  /** 這個量詞前面緊接著一個一定要出現的元素，而且那個元素吃不到這個量詞吃的字元（前面有分隔字元） */
  function delimited(seq, k) {
    let p = k - 1;
    while (p >= 0 && seq[p].zero) p -= 1;
    return p >= 0 && seq[p].min >= 1 && !seq[p].unbounded && !seq[p].inner && !overlaps(seq[p].set, seq[k].set);
  }

  /**
   * 每個不限次數的量詞分成三種：
   * - 單純：後面一定要出現的下一個元素，它吃不到（結束的位置只有一個，不用回頭試）。
   * - 有分隔而且會有很多種切法：前面緊接著一個一定要出現的元素、而且那個元素吃不到這個量詞吃的字元（前面有分隔字元），
   *   所以每個起點之後的字元串彼此不重疊，所有起點加起來最多掃過整個指令一次；但它後面接的東西它也吃得到（git\s+push\s+.*--force 的第二個 \s+）。
   * - 沒有分隔而且會有很多種切法：例如開頭的 .*a、\w*\w、[a-z]*(?:aa)。每個起點都要重跑，每一種切法都要試。
   * 時間會隨長度的幾次方成長，看「會有很多種切法」的量詞有幾個：最多只能有兩個，而且只能是「有分隔的在前、沒有分隔的在後」
   * （git\s+push\s+.*--force），或只有一個；第一個「會有很多種切法」的量詞之後，其他不限次數的量詞都要是「單純而且有分隔」的
   * （curl\s+.*\|\s*sh 最後的 \s*：前面是 |）。群組裡的不限次數量詞，後面接什麼不清楚，一律當成沒有分隔、會有很多種切法。
   */
  function checkLoops(seq) {
    const loops = [];
    for (let k = 0; k < seq.length; k++) {
      const e = seq[k];
      if (!e.unbounded && !e.inner) continue;
      if (e.inner > 1) fail('一個群組裡有兩個以上不限次數的量詞');
      let ambiguous = e.inner > 0;
      if (e.unbounded && !ambiguous) {
        let follow = nothing; // 這個量詞結束之後，下一個一定要出現的元素（含中間可有可無的元素）吃得到的字元
        for (let j = k + 1; j < seq.length; j++) {
          if (seq[j].zero) continue;
          follow = union(follow, seq[j].set);
          if (seq[j].min >= 1) break;
        }
        ambiguous = overlaps(e.set, follow);
      }
      loops.push({ ambiguous, delimited: e.unbounded && delimited(seq, k) });
    }
    const first = loops.findIndex((l) => l.ambiguous);
    if (first < 0) return;
    ambiguousLoops = true;
    const kinds = loops.filter((l) => l.ambiguous);
    // 兩個「會有很多種切法」的量詞只有「有分隔的在前、沒有分隔的在後」，而且它們前面的量詞全都有分隔才放行：
    // 前面如果還有沒有分隔的量詞（開頭的 \s*），每個起點都會走到同一個地方，成本再乘上一個長度（\s*x\d+1.*z）
    const allowed = kinds.length === 1 || (kinds.length === 2 && kinds[0].delimited && !kinds[1].delimited && loops.slice(0, first).every((l) => l.delimited));
    if (!allowed) fail('不限次數的量詞（*、+、{n,}）互相牽制：前一個量詞後面接的東西它也吃得到（例如 .*a、\\w*\\w），不能有兩個以上（只有「前面有分隔字元的 \\s+ 接 .*」例外）');
    if (loops.slice(first + 1).some((l) => !l.ambiguous && !l.delimited)) fail('不限次數的量詞（*、+、{n,}）互相牽制：會有很多種切法的量詞之後，其他的不限次數量詞前面要有一個一定要出現、而且吃不到它的字元當分隔（例如 \\|\\s*sh 的 \\s*）');
  }

  try {
    if (hasSurrogate) fail('不支援表情符號這類需要兩個字碼單元的字元');
    if (literals.length > MAX_NON_ASCII) fail(`樣式裡的非 ASCII 字元超過 ${MAX_NON_ASCII} 種`);
    const top = alternation();
    if (i < src.length) fail('括號不成對');
    for (const seq of top.sequences) checkLoops(seq);
    // 有不限次數的量詞時，有上限的可變量詞（?、{n,m}）的切法會再乘上整段指令的長度：a{0,20}\s*b 對 2,000 字元要 60 毫秒
    const maxChoices = top.loops > 0 ? MAX_CHOICES_WITH_LOOPS : MAX_CHOICES;
    if (choices > maxChoices) fail(`有上限的可變量詞（?、{n,m}）的可選次數相乘超過 ${maxChoices}${top.loops > 0 ? '（樣式裡有不限次數的量詞時）' : ''}：a{0,20}a{0,20}a{0,20} 有 9,261 種切法`);
    return { reason: null, ambiguous: ambiguousLoops };
  } catch (err) {
    return { reason: err instanceof PatternError ? err.message : '無法解析', ambiguous: true };
  }
}

/** 保守的樣式檢查（見 analyzePattern），只回傳不通過的原因；通過是 null */
export function unsafePattern(source, opts) {
  return analyzePattern(source, opts).reason;
}

/** 舊名稱：樣式是否有災難性回溯的寫法 */
export function looksCatastrophic(source, opts) {
  return unsafePattern(source, opts) !== null;
}

// 太寬的樣式：能命中空字串或任何一個單一字元，或同時命中兩種以上不相干的常見指令，等於每個指令都命中
const PROBES = ['', '\n', '\t', String.fromCharCode(0x4e2d)];
for (let c = 0x20; c < 0x7f; c++) PROBES.push(String.fromCharCode(c));
/** 非 ASCII 的空白（\s 吃得到的，包含 2000-200A 這一段的兩端與中間）：字元類的範圍可能只在中間蓋到它們 */
const SPACE_PROBES = [0xa0, 0x1680, 0x2000, 0x2005, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff].map((c) => String.fromCharCode(c));
/** 樣式裡最多幾種非 ASCII 字元（每一種都是一個樣本，樣本多了驗證會變慢） */
const MAX_NON_ASCII = 32;
const COMMON_COMMANDS = ['ls', 'ls -la', 'git status', 'cd ..', 'echo hello'];

function tooWide(re) {
  try {
    return PROBES.some((p) => re.test(p)) || COMMON_COMMANDS.filter((p) => re.test(p)).length >= 2;
  } catch {
    return true;
  }
}

// ───────── 規則的驗證與載入 ─────────

function normalizeRule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '規則不是物件' };
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!ID.test(id)) return { error: 'id 不合法（只能用英數、點、底線、連字號，64 字元以內）' };
  const fail = (error) => ({ id, error });
  if (!TOOLS.includes(raw.tool)) return fail(`tool 必須是 ${TOOLS.join('、')}`);
  if (!ACTIONS.includes(raw.action)) return fail(`action 必須是 ${ACTIONS.join('、')}`);
  if (typeof raw.message !== 'string' || !raw.message.trim()) return fail('缺少 message');
  if (raw.message.trim().length > MAX_MESSAGE_LENGTH) return fail(`message 超過 ${MAX_MESSAGE_LENGTH} 字元`);
  if (typeof raw.pattern !== 'string' || !raw.pattern) return fail('缺少 pattern');
  const flags = raw.flags == null ? '' : raw.flags;
  if (typeof flags !== 'string' || !FLAGS.test(flags)) return fail('flags 只能用 i、m、s');
  const unless = raw.unless == null ? '' : raw.unless;
  if (typeof unless !== 'string') return fail('unless 必須是字串');
  // messageEn（選填，2.0.0）：英文的訊息；mod 依語言選用，沒有就用 message
  const messageEn = raw.messageEn == null || raw.messageEn === '' ? '' : raw.messageEn;
  if (typeof messageEn !== 'string') return fail('messageEn 必須是字串');
  if (messageEn.trim().length > MAX_MESSAGE_LENGTH) return fail(`messageEn 超過 ${MAX_MESSAGE_LENGTH} 字元`);
  return {
    rule: {
      id, tool: raw.tool, pattern: raw.pattern, flags, unless, action: raw.action, message: raw.message.trim(),
      ...(messageEn.trim() ? { messageEn: messageEn.trim() } : {}),
      // 這條規則要防的問題不會讓指令失敗，只會讓輸出悄悄變錯：重送成功不代表是誤擋，所以不自動降級
      silentFailure: raw.silentFailure === true,
      source: typeof raw.source === 'string' ? raw.source : '',
      addedAt: typeof raw.addedAt === 'string' ? raw.addedAt : '',
      by: typeof raw.by === 'string' ? raw.by : '',
    },
  };
}

let builtinHashes = null;

/** 內建規則的內容雜湊：規則檔裡內容和內建規則完全相同的規則，視為內建（可以把預設規則整份複製進規則檔） */
function isBuiltin(hash) {
  if (!builtinHashes) {
    builtinHashes = new Set();
    for (const raw of DEFAULT_RULES) {
      const n = normalizeRule(raw);
      if (!n.rule) continue;
      builtinHashes.add(ruleHash(n.rule));
      // 加上 messageEn 之前複製進規則檔的內建規則（沒有 messageEn）照樣視為內建
      const { messageEn, ...without } = n.rule;
      builtinHashes.add(ruleHash(without));
    }
  }
  return builtinHashes.has(hash);
}

function compileOne(raw) {
  const n = normalizeRule(raw);
  if (n.error) return n;
  const { rule } = n;
  const fail = (error) => ({ id: rule.id, error });
  const hash = ruleHash(rule);
  const trusted = isBuiltin(hash);
  const sources = [['pattern', rule.pattern], ['unless', rule.unless]].filter(([, src]) => src);
  if (!trusted) {
    for (const [name, src] of sources) if (src.length > MAX_PATTERN_LENGTH) return fail(`${name} 超過 ${MAX_PATTERN_LENGTH} 字元`);
  }
  // 先編譯：無效的樣式（沒寫完的群組、括號不成對）在這裡就被擋掉，後面的檢查只會看到完整的樣式
  let re;
  let unlessRe = null;
  try {
    re = new RegExp(rule.pattern, rule.flags);
    if (rule.unless) unlessRe = new RegExp(rule.unless, rule.flags);
  } catch (err) {
    return fail(`正規表示式編譯失敗：${String(err?.message ?? err).slice(0, 80)}`);
  }
  // 比對的指令長度上限：內建規則看前 MAX_COMMAND_LENGTH 字元；規則檔來的規則看前 MAX_UNTRUSTED_COMMAND_LENGTH 字元，
  // 樣式（pattern 或 unless）有「會有很多種切法」的不限次數量詞時只看前 MAX_AMBIGUOUS_COMMAND_LENGTH 字元
  let limit = trusted ? MAX_COMMAND_LENGTH : MAX_UNTRUSTED_COMMAND_LENGTH;
  if (!trusted) {
    for (const [name, src] of sources) {
      const a = analyzePattern(src, { ignoreCase: rule.flags.includes('i') });
      if (a.reason) return fail(`${name} 有可能讓比對卡住的寫法：${a.reason}`);
      if (a.ambiguous) limit = MAX_AMBIGUOUS_COMMAND_LENGTH;
    }
  }
  if (tooWide(re)) return fail('pattern 太寬：空字串、單一字元或好幾種常見指令（ls、git status、echo hello）都會命中');
  return { entry: { rule, re, unlessRe, trusted, hash, limit } };
}

/** 逐條驗證；壞掉的規則略過並記下原因（skipped：[{ id, reason, en: { reason } }]），id 重複時留第一條 */
export function compileRules(list) {
  const entries = [];
  const skipped = [];
  const seen = new Set();
  const skip = (id, reason) => skipped.push({ id, reason, en: { reason: reasonEn(reason) } });
  for (const raw of Array.isArray(list) ? list : []) {
    const r = compileOne(raw);
    if (r.error) skip(r.id ?? (typeof raw?.id === 'string' ? raw.id.slice(0, 64) : null), r.error);
    else if (seen.has(r.entry.rule.id)) skip(r.entry.rule.id, 'id 重複');
    else {
      seen.add(r.entry.rule.id);
      entries.push(r.entry);
    }
  }
  return { entries, skipped };
}

// 略過原因與規則檔問題的英文版（2.0.0：英文介面不再直接看到中文）。原因都由這個檔案的固定句型產生，依句型對照；
// 對照不到的（不該發生）原樣回傳
const commaList = (s) => String(s).split('、').join(', ');
const REASON_EN = [
  [/^規則不是物件$/, () => 'The rule is not an object'],
  [/^id 不合法/, () => 'Invalid id (letters, digits, dots, underscores and hyphens only, up to 64 characters)'],
  [/^tool 必須是 (.+)$/, (m) => `tool must be ${commaList(m[1])}`],
  [/^action 必須是 (.+)$/, (m) => `action must be ${commaList(m[1])}`],
  [/^缺少 (message|pattern)$/, (m) => `${m[1]} is missing`],
  [/^(message|messageEn|pattern|unless) 超過 (\d+) 字元$/, (m) => `${m[1]} is longer than ${m[2]} characters`],
  [/^flags 只能用/, () => 'flags can only use i, m and s'],
  [/^(unless|messageEn) 必須是字串$/, (m) => `${m[1]} must be a string`],
  [/^正規表示式編譯失敗：([\s\S]*)$/, (m) => `The regular expression failed to compile: ${m[1]}`],
  [/^(pattern|unless) 有可能讓比對卡住的寫法：([\s\S]*)$/, (m) => `${m[1]} could make matching hang: ${reasonEn(m[2])}`],
  [/^pattern 太寬/, () => 'pattern is too broad: an empty string, a single character or several common commands (ls, git status, echo hello) would match'],
  [/^id 重複$/, () => 'Duplicate id'],
  [/^規則超過 (\d+) 條，後面的 (\d+) 條沒有載入$/, (m) => `More than ${m[1]} rules; the last ${m[2]} were not loaded`],
  [/^不支援 (\\\S+) 這種跳脫寫法/, (m) => `Escapes like ${m[1]} (\\x, \\u, \\c, \\p, \\k, back-references) are not supported: write the character itself`],
  [/^次數上限超過 (\d+)$/, (m) => `A repeat count is above ${m[1]}`],
  [/^具名群組沒有結尾$/, () => 'A named group is not closed'],
  [/^不支援的群組寫法$/, () => 'Unsupported group syntax'],
  [/^括號不成對$/, () => 'Unbalanced parentheses'],
  [/^樣式沒有寫完$/, () => 'The pattern is incomplete'],
  [/^群組裡有可變長度的量詞/, () => 'A repeated group contains a variable-length quantifier (?, {n,m}, *, +)'],
  [/^群組裡有可能重疊的分支/, () => 'A repeated group has alternatives that can overlap'],
  [/^重複的群組裡又有重複的群組$/, () => 'A repeated group contains another repeated group'],
  [/^能吃大範圍字元的不限次數量詞.*超過 (\d+) 個$/, (m) => `More than ${m[1]} unbounded quantifiers on broad character sets (., [^…], [\\s\\S], \\S with *, +, {n,})`],
  [/^其他的不限次數量詞.*超過 (\d+) 個$/, (m) => `More than ${m[1]} other unbounded quantifiers (*, +, {n,})`],
  [/^有上限的可變量詞（\?、\{n,m\}）的可選次數相乘超過 (\d+)/, (m) => `The choices of bounded variable quantifiers (?, {n,m}) multiply to more than ${m[1]}: a{0,20}a{0,20}a{0,20} can split a text 9,261 ways`],
  [/^有上限的可變量詞（\?、\{n,m\}）超過 (\d+) 個$/, (m) => `More than ${m[1]} bounded variable quantifiers (?, {n,m})`],
  [/^(\d+) 個可變長度的量詞相鄰$/, (m) => `${m[1]} variable-length quantifiers in a row`],
  [/^無法解析$/, () => 'Could not be parsed'],
  [/^一個群組裡有兩個以上不限次數的量詞$/, () => 'A group has two or more unbounded quantifiers'],
  [/^不限次數的量詞（\*、\+、\{n,\}）互相牽制：前一個/, () => 'Unbounded quantifiers (*, +, {n,}) overlap: what follows one can also be consumed by it (for example .*a, \\w*\\w), so there cannot be two or more (the only exception is \\s+ after a delimiter followed by .*)'],
  [/^不限次數的量詞（\*、\+、\{n,\}）互相牽制：會有很多種切法/, () => 'Unbounded quantifiers (*, +, {n,}) overlap: after a quantifier that can split the text many ways, every other unbounded quantifier needs a required delimiter before it that the quantifier cannot consume (for example the \\s* in \\|\\s*sh)'],
  [/^不支援表情符號/, () => 'Characters that need two code units (such as emoji) are not supported'],
  [/^樣式裡的非 ASCII 字元超過 (\d+) 種$/, (m) => `More than ${m[1]} different non-ASCII characters in the pattern`],
  [/^規則檔不是有效的 JSON/, () => 'The rules file is not valid JSON, so the built-in default rules are used'],
  [/^規則檔的格式不對/, () => 'The rules file has the wrong format (it needs { v: 1, rules: [...] }), so the built-in default rules are used'],
];

/** 略過原因或規則檔問題（中文）的英文版；對照不到時原樣回傳 */
export function reasonEn(reason) {
  const text = String(reason ?? '');
  for (const [re, en] of REASON_EN) {
    const m = re.exec(text);
    if (m) return en(m);
  }
  return text;
}

/**
 * 載入規則：text 是 vault/guardrails/rules.json 的內容，檔案不存在傳 null → 內建的預設規則。
 * 檔案在、但整個壞掉（不是 JSON、版本不是 1）時也用預設規則，並用 problem 說明；檔案裡的規則清單是空的就是不比對任何規則
 * （除非檔案寫了 defaults: true：內建規則加上檔案的規則，回傳的 defaults 是 true）。
 * 檔案最多載入 MAX_RULES 條。
 */
export function loadRules(text) {
  // problem 另有英文版 en.problem（管理介面切到英文時顯示）
  const defaults = (problem) => ({ source: 'default', ...compileRules(DEFAULT_RULES), ...(problem ? { problem, en: { problem: reasonEn(problem) } } : {}) });
  if (text == null) return defaults();
  let data;
  try {
    data = JSON.parse(stripBom(text));
  } catch {
    return defaults('規則檔不是有效的 JSON，改用內建的預設規則');
  }
  if (!data || typeof data !== 'object' || data.v !== 1 || !Array.isArray(data.rules)) return defaults('規則檔的格式不對（需要 { v: 1, rules: [...] }），改用內建的預設規則');
  // defaults: true（2.0.0：記憶畢業第一次建立規則檔時寫入）：內建的預設規則照樣生效，檔案的規則另外加上去。
  // 內建的排在前面：同 id 的檔案規則被略過（不能取代或降級內建規則）；檔案的規則照樣逐條保守驗證，上限只算檔案的規則。
  // 相容性：2.0.0 之前的版本（1.6.0 以前）沒有護欄，不讀這個檔案，所以舊版電腦同步到含 defaults 的規則檔不會有影響；
  // 只有 2.0.0 開發期間、這個欄位加入之前的版本會把它當成「取代內建規則」，那些版本沒有發佈。
  const own = data.rules.slice(0, MAX_RULES);
  const result = data.defaults === true
    ? { source: 'file', defaults: true, ...compileRules([...DEFAULT_RULES, ...own]) }
    : { source: 'file', ...compileRules(own) };
  if (data.rules.length > MAX_RULES) {
    const reason = `規則超過 ${MAX_RULES} 條，後面的 ${data.rules.length - MAX_RULES} 條沒有載入`;
    result.skipped.push({ id: null, reason, en: { reason: reasonEn(reason) } });
  }
  return result;
}

// ───────── 設定、本機覆寫、核可 ─────────

/** 設定 guardrails 的值；看不懂的用預設 block */
export function normalizeMode(value) {
  return value === 'hint' || value === 'off' ? value : 'block';
}

/**
 * local/guardrails-overrides.json 的內容 → { <規則 id>: { action: 'hint'|'off', at?, reason?, until? } }；壞掉或看不懂的略過。
 * reason：manual（自己停用）、falseBlock（被誤擋後降級）、slow（比對太慢被停用）。until：到這個時間自動恢復（ISO）。
 */
export function parseOverrides(text) {
  const out = {};
  let data;
  try {
    data = text == null ? null : JSON.parse(stripBom(text));
  } catch {
    return out;
  }
  const rules = data && typeof data === 'object' && data.rules && typeof data.rules === 'object' && !Array.isArray(data.rules) ? data.rules : {};
  for (const [id, v] of Object.entries(rules)) {
    if (!v || (v.action !== 'hint' && v.action !== 'off')) continue;
    out[id] = {
      action: v.action,
      ...(typeof v.at === 'string' ? { at: v.at } : {}),
      ...(typeof v.reason === 'string' ? { reason: v.reason } : {}),
      ...(typeof v.until === 'string' && Number.isFinite(Date.parse(v.until)) ? { until: v.until } : {}),
    };
  }
  return out;
}

/** 設定或移除（entry 為 null）一條規則的本機覆寫，回傳新的覆寫物件 */
export function withOverride(overrides, id, entry) {
  const next = { ...overrides };
  if (entry) next[id] = entry;
  else delete next[id];
  return next;
}

export function stringifyOverrides(overrides) {
  return `${JSON.stringify({ v: 1, rules: overrides }, null, 2)}\n`;
}

/** 這條規則目前有效的覆寫；有 until 而且已經到期的當作沒有 */
export function activeOverride(overrides, id, now) {
  const o = overrides?.[id];
  if (!o) return null;
  if (o.until) {
    const t = Date.parse(o.until);
    if (Number.isFinite(t) && t <= (now ?? Date.now())) return null;
  }
  return o;
}

/** 被誤擋而降成提醒的規則，到這個時間自動恢復 */
export function falseBlockUntil(at) {
  return new Date(Date.parse(at) + FALSE_BLOCK_DAYS * DAY_MS).toISOString();
}

/** local/guardrails-approved.json 的內容 → { <規則 id>: { hash, at? } }：規則檔來的 block 規則，在這台電腦核可過的內容雜湊 */
export function parseApprovals(text) {
  const out = {};
  let data;
  try {
    data = text == null ? null : JSON.parse(stripBom(text));
  } catch {
    return out;
  }
  const rules = data && typeof data === 'object' && data.rules && typeof data.rules === 'object' && !Array.isArray(data.rules) ? data.rules : {};
  for (const [id, v] of Object.entries(rules)) {
    if (v && typeof v.hash === 'string' && /^[0-9a-f]{64}$/.test(v.hash)) out[id] = { hash: v.hash, ...(typeof v.at === 'string' ? { at: v.at } : {}) };
  }
  return out;
}

export function withApproval(approvals, id, entry) {
  const next = { ...approvals };
  if (entry) next[id] = entry;
  else delete next[id];
  return next;
}

export function stringifyApprovals(approvals) {
  return `${JSON.stringify({ v: 1, rules: approvals }, null, 2)}\n`;
}

/**
 * 這條規則的核可狀態：builtin（內建，不需要核可）、approved（規則檔來的 block 規則，這台電腦核可過這份內容）、
 * pending（規則檔來的 block 規則，還沒核可或內容改過：只當提醒）、not-needed（提醒類的規則不需要核可）
 */
export function approvalState(entry, approvals) {
  if (entry.trusted) return 'builtin';
  if (entry.rule.action !== 'block') return 'not-needed';
  return approvals?.[entry.rule.id]?.hash === entry.hash ? 'approved' : 'pending';
}

/**
 * 一條規則目前實際的動作：'block'｜'hint'｜'off'。
 * 設定 off → 全部不比對；hint → 全部只提醒；本機覆寫只能把規則降成 hint 或停用，不能升級（到期的覆寫不算）。
 * unapproved：規則檔來的 block 規則還沒核可，只當提醒。demote：這一次比對要降成提醒的規則 id（被擋下的指令原封不動再送一次）。
 */
export function effectiveAction(rule, { mode = 'block', overrides = {}, demote, unapproved = false, now } = {}) {
  if (mode === 'off') return 'off';
  const override = activeOverride(overrides, rule.id, now)?.action;
  if (override === 'off') return 'off';
  let action = rule.action;
  if (action === 'block' && (override === 'hint' || unapproved || demote?.has(rule.id) || mode === 'hint')) action = 'hint';
  return action;
}

// ───────── 比對 ─────────

function defaultClock() {
  return typeof Date === 'function' && typeof Date.now === 'function' ? () => Date.now() : null;
}

/**
 * 比對指令，回傳命中的規則（依規則順序）：{ id, action（實際）, declared（規則本來的動作）, message, silentFailure }。
 * opts：mode、overrides、approvals（核可紀錄）、demote、now（毫秒，判斷覆寫是否到期）。
 * 任何一條規則比對時出錯都當成沒命中。規則檔來的規則只比對指令的前 MAX_UNTRUSTED_COMMAND_LENGTH 字元，
 * 而且量每次比對花的時間：超過 opts.slowMs（預設 SLOW_MS）就呼叫 opts.onSlow(規則 id, 毫秒)，由 mod 在本機停用那條規則。
 */
export function evaluate(entries, tool, command, opts = {}) {
  if (typeof command !== 'string' || !command || opts.mode === 'off') return [];
  const clock = opts.clock ?? defaultClock();
  const slowMs = opts.slowMs ?? SLOW_MS;
  const hits = [];
  for (const entry of entries) {
    const { rule, re, unlessRe, trusted } = entry;
    if (rule.tool !== '*' && rule.tool !== tool) continue;
    const unapproved = !trusted && rule.action === 'block' && opts.approvals?.[rule.id]?.hash !== entry.hash;
    const action = effectiveAction(rule, { ...opts, unapproved });
    if (action === 'off') continue;
    const limit = entry.limit ?? (trusted ? MAX_COMMAND_LENGTH : MAX_UNTRUSTED_COMMAND_LENGTH);
    const text = command.length > limit ? command.slice(0, limit) : command;
    const timed = !trusted && clock !== null;
    const started = timed ? clock() : 0;
    let matched = false;
    try {
      matched = re.test(text) && !unlessRe?.test(text);
    } catch {
      matched = false;
    }
    if (timed) {
      const ms = clock() - started;
      if (ms > slowMs) opts.onSlow?.(rule.id, ms);
    }
    if (matched) hits.push({ id: rule.id, action, declared: rule.action, message: rule.message, ...(rule.messageEn ? { messageEn: rule.messageEn } : {}), silentFailure: rule.silentFailure === true });
  }
  return hits;
}

/**
 * 擋下時給模型的說明：只列擋下的規則，並告訴它確定沒問題時原封不動再送一次會放行。
 * 會讓指令失敗的規則，重送成功才會在這台電腦暫時降成提醒；「失敗不會報錯」的規則不會自動降級，由使用者決定。
 */
export function denyText(hits, { lang = 'zh' } = {}) {
  const blocking = hits.filter((h) => h.action === 'block');
  const silent = blocking.filter((h) => h.silentFailure).length;
  if (lang === 'en') {
    const days = `restored automatically after ${FALSE_BLOCK_DAYS} days`;
    const tail = silent === 0
      ? `if it then succeeds, this rule is downgraded to a reminder on this computer (${days}).`
      : silent === blocking.length
        ? 'the problem this rule guards against does not make the command fail, so resending does not downgrade it automatically; the user decides whether to change it.'
        : `if it then succeeds, only the rules whose problem makes the command fail are downgraded to reminders on this computer (${days}); the user decides about the others.`;
    return `${PREFIX_EN} This command was not run:\n${blocking.map((h) => `- ${ruleMessage(h, lang)}`).join('\n')}\nIf you are sure the command is fine, send it again unchanged and it will run; ${tail}`;
  }
  const days = `${FALSE_BLOCK_DAYS} 天後自動恢復`;
  const tail = silent === 0
    ? `重送後成功，這條規則才會在這台電腦降成提醒（${days}）。`
    : silent === blocking.length
      ? '這條規則防的問題不會讓指令失敗，所以不會因為重送而自動降級，是否調整由使用者決定。'
      : `重送後成功，只有會讓指令失敗的規則才會在這台電腦降成提醒（${days}），其餘的規則由使用者決定。`;
  return `${PREFIX} 這個指令先不執行：\n${blocking.map((h) => `- ${h.message}`).join('\n')}\n如果你確定這個指令沒有問題，原封不動再送一次會放行；${tail}`;
}

/** 英文的開頭 */
export const PREFIX_EN = '[Engram guardrail]';

/** 規則（或命中）的訊息：lang 是 en 而且有 messageEn 時用英文，否則用 message */
export function ruleMessage(r, lang = 'zh') {
  return lang === 'en' && r?.messageEn ? r.messageEn : r?.message;
}

/** 附在結果後面的提醒（只有模型讀得到），一條規則一則 */
export function hintTexts(hits, { lang = 'zh' } = {}) {
  return hits.filter((h) => h.action === 'hint').map((h) => `${lang === 'en' ? PREFIX_EN : PREFIX} ${ruleMessage(h, lang)}`);
}

/** 訊息的第一句（到第一個全形句號，或英文句點加空白為止），後備提示只放這一句 */
export function firstSentence(message) {
  const text = String(message ?? '').trim();
  const zh = text.indexOf('。');
  const en = text.search(/\.\s/);
  const at = [zh, en].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  return at === undefined ? text : text.slice(0, at + 1);
}

/** 開場訊息後備提示的內文：這台電腦目前生效的規則（略過停用的），最多 SUMMARY_LIMIT 條，每條一句（opts.lang 是 en 時用 messageEn） */
export function summaryLines(entries, opts = {}) {
  const lines = [];
  for (const { rule } of entries) {
    if (effectiveAction(rule, opts) === 'off') continue;
    lines.push(`  - ${firstSentence(ruleMessage(rule, opts.lang))}`);
    if (lines.length >= SUMMARY_LIMIT) break;
  }
  return lines;
}

// ───────── 誤擋的自我修正 ─────────

/**
 * 同一場對話裡被擋下的指令。同一個指令原封不動再送一次，take 會回傳上次擋下它的規則 id（只能取一次）。
 * 只記最近的幾筆，記憶體不會一直長大；對話 id 不同就是不同場，/clear 之後自然不會互相影響。
 */
export function createBlockLog(limit = 30) {
  const log = new Map();
  const keyOf = (sessionId, command) => `${sessionId}${String.fromCharCode(0)}${command}`;
  return {
    get size() { return log.size; },
    remember(sessionId, command, ids) {
      const key = keyOf(sessionId, command);
      log.delete(key);
      log.set(key, [...ids]);
      while (log.size > limit) log.delete(log.keys().next().value);
    },
    take(sessionId, command) {
      const key = keyOf(sessionId, command);
      const ids = log.get(key) ?? null;
      log.delete(key);
      return ids;
    },
  };
}

/** 命中紀錄的一行（local/usage/guardrails/<日期>.jsonl）：不存指令原文，只存規則 id、種類、時間與對話 id */
export function usageLine({ at, session, rule, kind }) {
  return `${JSON.stringify({ at, session, rule, kind })}\n`;
}
