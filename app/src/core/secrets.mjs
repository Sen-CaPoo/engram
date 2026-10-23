// 密鑰掃描：同步前檢查記憶內容，疑似含金鑰或密碼的檔案不會被推上遠端（H13）。
// 回報只含種類、位置與遮蔽後的預覽，絕不輸出完整值。
import { createHash } from 'node:crypto';

/** 偵測種類，依優先序排列：位置重疊時以排在前面的為準。 */
export const SECRET_KINDS = Object.freeze([
  { kind: 'private-key', label: 'PEM 私鑰區塊' },
  { kind: 'anthropic-api-key', label: 'Anthropic API 金鑰（sk-ant-…）' },
  { kind: 'openai-api-key', label: 'OpenAI 風格 API 金鑰（sk-…）' },
  { kind: 'github-token', label: 'GitHub 權杖（ghp_、gho_、ghu_、ghs_、ghr_）' },
  { kind: 'github-pat', label: 'GitHub fine-grained PAT（github_pat_…）' },
  { kind: 'slack-token', label: 'Slack 權杖（xox?-…）' },
  { kind: 'aws-access-key-id', label: 'AWS 存取金鑰 ID（AKIA…、ASIA…）' },
  { kind: 'google-api-key', label: 'Google API 金鑰（AIza…）' },
  { kind: 'jwt', label: 'JSON Web Token' },
  { kind: 'url-credentials', label: '網址內含帳號密碼（scheme://user:pass@host）' },
  { kind: 'bearer-token', label: 'Bearer 權杖' },
  { kind: 'connection-string', label: '連線字串中的密碼或金鑰（Password=、AccountKey=…）' },
  { kind: 'credential-assignment', label: '密碼、權杖、金鑰的指定值（password: …、密碼：…）' },
  { kind: 'high-entropy', label: '高亂度字串（疑似隨機金鑰）' },
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURE_HEX = /^[0-9a-f]{7,64}$/i;

/** @param {string} v */
function isPlaceholder(v) {
  return (
    /^<.*>$/.test(v) ||
    /\*{3,}/.test(v) ||
    /x{3,}/i.test(v) ||
    /\$\{.*\}/.test(v) ||
    /^\$[A-Za-z_]\w*$/.test(v) ||
    /^%[A-Za-z_]\w*%$/.test(v) ||
    /^your[-_]/i.test(v) ||
    /example|placeholder|redacted|changeme|dummy/i.test(v) ||
    /\.{3}|…/.test(v) ||
    /^(.)\1+$/.test(v) ||
    /^(password|passwd|secret|token|apikey|api_key|test|sample|null|none|undefined|true|false)$/i.test(v)
  );
}

/** @param {string} s */
function charClasses(s) {
  let n = 0;
  if (/[a-z]/.test(s)) n++;
  if (/[A-Z]/.test(s)) n++;
  if (/[0-9]/.test(s)) n++;
  if (/[^A-Za-z0-9]/.test(s)) n++;
  return n;
}

/** @param {string} s */
function entropy(s) {
  const freq = new Map();
  for (const c of s) freq.set(c, (freq.get(c) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** 隨機字串的大小寫／數字切換很頻繁；CamelCase 識別名稱則很少切換。 @param {string} s */
function transitionRatio(s) {
  const cls = (c) => (/[a-z]/.test(c) ? 0 : /[A-Z]/.test(c) ? 1 : /[0-9]/.test(c) ? 2 : 3);
  let t = 0;
  for (let i = 1; i < s.length; i++) if (cls(s[i]) !== cls(s[i - 1])) t++;
  return s.length > 1 ? t / (s.length - 1) : 0;
}

/** 看起來像隨機產生的金鑰本體（排除 slug、識別名稱、雜湊）。 @param {string} s */
function looksRandom(s) {
  if (s.length < 16 || PURE_HEX.test(s)) return false;
  return charClasses(s.replace(/[^A-Za-z0-9]/g, '')) >= 2 && entropy(s) >= 3.5 && transitionRatio(s) >= 0.3;
}

/** 指定式的值是否像真的密碼或金鑰。 @param {string} v */
function plausibleLiteral(v) {
  if (v.length < 6 || isPlaceholder(v)) return false;
  if (/^[A-Za-z]:[\\/]|^[~.]?\//.test(v)) return false; // 路徑
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false; // 網址另由 url-credentials 處理
  if (/^(process\.env|os\.environ|env\.|import\.meta)/i.test(v)) return false; // 環境變數參照
  if (/^[A-Z][A-Z0-9_]*$/.test(v)) return false; // 全大寫識別名稱，例如 LITELLM_MASTER_KEY
  if (/^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(v)) return false; // camelCase 識別名稱
  if (/^[a-z][a-z0-9]*(?:[_.\-][a-z0-9]+)*$/.test(v)) return false; // 全小寫 slug、檔名
  if (/^[\d.,:%/+\-]+[a-z]{0,3}$/i.test(v)) return false; // 數字、時間長度、版本
  if (/\]\(|`/.test(v)) return false; // Markdown 語法
  if (/[*{}]/.test(v)) return false; // 萬用字元或樣板，例如 Redis 鍵樣式 {api_key:*}
  if (UUID.test(v)) return false;
  // 明確寫成金鑰或密碼的值是 32 位以上的十六進位時照樣算（Azure OpenAI、APIM 的金鑰就是這種格式）；短的多半是 commit 或雜湊片段
  if (PURE_HEX.test(v)) return v.length >= 32;
  // 至少兩種英數字元類別（小寫、大寫、數字）
  return charClasses(v.replace(/[^A-Za-z0-9]/g, '')) >= 2;
}

/** 由英文單字組成的 PascalCase 名稱（DeptCode、UserId、Invoices2026）：每段大寫後接小寫，平均每段至少 3 個字元 */
function pascalWords(v) {
  const m = /^((?:[A-Z][a-z]+)+)[0-9]*$/.exec(v);
  if (!m) return false;
  const segs = m[1].match(/[A-Z][a-z]+/g);
  return segs.length <= 4 && m[1].length / segs.length >= 3;
}

/**
 * 「金鑰名稱」類（XXX_KEY、client_key…）的值：除了 plausibleLiteral，再排除資料庫與程式裡常見的鍵值寫法（審查 P1）——
 * PascalCase 欄位名稱、帶副檔名的相對路徑、冒號分隔的快取鍵、點分隔的識別名稱。password、密碼這類規則不套用，弱密碼才不會被放過。
 */
function plausibleKeyLiteral(v) {
  if (!plausibleLiteral(v)) return false;
  if (pascalWords(v)) return false;
  if (/^[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,5}$/.test(v)) return false; // reports/2026/Q3.pdf
  if (/^[a-z0-9]+(?::[a-z0-9]+)+$/i.test(v)) return false; // user:123:profile
  if (/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/.test(v)) return false; // Checkout.Title
  return true;
}

/**
 * @typedef {{ kind: string, re: RegExp, group?: number, validate?: (v: string) => boolean }} Detector
 * @type {Detector[]}
 */
const DETECTORS = [
  {
    kind: 'private-key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|(?![\s\S]))/dg,
  },
  {
    kind: 'anthropic-api-key',
    re: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/dg,
    validate: (v) => looksRandom(v.slice(7)),
  },
  {
    kind: 'openai-api-key',
    re: /(?<![A-Za-z0-9_-])sk-(?!ant-)[A-Za-z0-9_-]{20,}/dg,
    validate: (v) => looksRandom(v.replace(/^sk-(?:proj-|svcacct-|admin-)?/, '')),
  },
  { kind: 'github-token', re: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,}(?![A-Za-z0-9_])/dg },
  { kind: 'github-pat', re: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{40,}/dg },
  {
    kind: 'slack-token',
    re: /(?<![A-Za-z0-9-])xox[abprs]-[A-Za-z0-9-]{10,}/dg,
    validate: (v) => /\d/.test(v) && !isPlaceholder(v.slice(5)),
  },
  { kind: 'aws-access-key-id', re: /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/dg },
  { kind: 'google-api-key', re: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/dg },
  { kind: 'jwt', re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/dg },
  {
    kind: 'url-credentials',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s\/:@<>]+:([^\s\/@<>]+)@[^\s\/?#]+/dgi,
    group: 1,
    validate: (v) => v.length >= 3 && !isPlaceholder(v) && !/^(pass|pwd)$/i.test(v),
  },
  {
    kind: 'bearer-token',
    re: /\bBearer\s+([A-Za-z0-9._~+\/-]{20,}=*)/dg,
    group: 1,
    validate: (v) => !isPlaceholder(v) && charClasses(v) >= 2,
  },
  {
    kind: 'connection-string',
    re: /\b(?:Password|Pwd|AccountKey|SharedAccessKey)\s*=\s*([^;'"\s<>]+)/dgi,
    group: 1,
    validate: (v) => v.length >= 4 && !isPlaceholder(v) && !/^\$|^%|^\{/.test(v),
  },
  {
    kind: 'credential-assignment',
    // 英文關鍵字要求前後不是字母數字；中文關鍵字前面常緊接其他中文字（資料庫密碼），不設限。
    // 金鑰名稱只收明確的種類（Ocp-Apim-Subscription-Key、AWS 的 access_key、client_key…）：
    // 一般的 *_key 多半是資料庫或程式的鍵（primary_key、partition_key、cache_key），不能算（審查 P1）。
    // 不收「密碼是 X」這種說法：常見的「密碼在 1Password 裡」「金鑰存在 KeyVault」會被誤判（審查 N3）
    re: /(?:(?<![\p{L}\p{N}])(?:password|passwd|pwd|secret|token)(?![\p{L}\p{N}])|密碼|金鑰)\s*["']?\s*[:=：]\s*["']?([\x21-\x7E]{6,})/dgiu,
    group: 1,
    validate: plausibleLiteral,
  },
  {
    kind: 'credential-assignment',
    // 明確的金鑰名稱，以及服務商的金鑰（openai_key、azure_openai_key…）；值另外排除資料庫與程式常見的鍵值寫法
    re: /(?<![\p{L}\p{N}])(?:api[_-]?key|(?:subscription|access|secret|private|master|account|signing|encryption|client|app|auth|storage|admin)[_-]?key|(?:[a-z0-9]+_)*(?:openai|anthropic|stripe|sendgrid|twilio|mapbox|google)[_-]?key)(?![\p{L}\p{N}])\s*["']?\s*[:=：]\s*["']?([\x21-\x7E]{6,})/dgiu,
    group: 1,
    validate: plausibleKeyLiteral,
  },
  {
    kind: 'credential-assignment',
    // 全大寫、以 _KEY 結尾的環境變數（AZURE_OPENAI_KEY=、STRIPE_KEY=）：大小寫要完全符合，小寫的 primary_key 不算
    re: /(?<![A-Za-z0-9_])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_KEY(?![A-Za-z0-9])\s*["']?\s*[:=]\s*["']?([\x21-\x7E]{6,})/dgu,
    group: 1,
    validate: plausibleKeyLiteral,
  },
];

/** @param {string} text */
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: pos - starts[lo] + 1 };
  };
}

/**
 * 掃描文字中疑似的金鑰或密碼。
 * @param {string} text
 * @returns {{ kind: string, line: number, column: number, preview: string }[]}
 */
export function scanSecrets(text) {
  if (!text) return [];
  /** @type {{ kind: string, start: number, end: number, value: string }[]} */
  const accepted = [];
  const overlaps = (s, e) => accepted.some((a) => s < a.end && e > a.start);

  for (const det of DETECTORS) {
    det.re.lastIndex = 0;
    for (const m of text.matchAll(det.re)) {
      const g = det.group ?? 0;
      let value = m[g];
      let [start] = m.indices[g];
      if (det.kind === 'credential-assignment') {
        // 去掉值尾端的引號與標點
        value = value.replace(/["'`,;)\]}>.]+$/, '');
      }
      const end = start + value.length;
      if (!value || overlaps(start, end)) continue;
      if (det.validate && !det.validate(value)) continue;
      accepted.push({ kind: det.kind, start, end, value });
    }
  }

  // 一般高亂度字串：排除 UUID、純十六進位、路徑、slug 與識別名稱
  for (const m of text.matchAll(/[A-Za-z0-9+\/_=.\-]{32,}/g)) {
    const tok = m[0];
    const start = m.index;
    const end = start + tok.length;
    if (overlaps(start, end)) continue;
    if (UUID.test(tok) || PURE_HEX.test(tok) || /\.md$/i.test(tok)) continue;
    const longest = tok.split(/[-_.\/+=]/).reduce((a, s) => (s.length > a.length ? s : a), '');
    if (longest.length < 16 || PURE_HEX.test(longest)) continue;
    if (charClasses(tok.replace(/[^A-Za-z0-9]/g, '')) < 3) continue;
    if (entropy(tok) < 4.0 || transitionRatio(longest) < 0.35) continue;
    accepted.push({ kind: 'high-entropy', start, end, value: tok });
  }

  const at = lineIndex(text);
  return accepted
    .sort((a, b) => a.start - b.start)
    .map(({ kind, start, end, value }) => ({
      kind,
      ...at(start),
      offset: start,
      length: end - start,
      preview: `${value.slice(0, 4)}…(${value.length})`,
    }));
}

/** 「不是金鑰」清單用：值的 sha256 前 32 碼（清單只存雜湊，不存值） */
export function secretHash(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 32);
}

/**
 * 偵測結果是否在「不是金鑰」清單裡。有 hash 的項目只比對值的雜湊，所以同一個檔案裡另一組前綴與長度相同的真金鑰不會被放行；
 * 沒有 hash 的舊項目照舊以 kind＋preview（可能帶 line）比對。text 是 hit 所在的整份文字。
 */
export function isAllowedHit(hit, entries, text) {
  if (!entries?.length) return false;
  const h = secretHash(String(text).slice(hit.offset, hit.offset + hit.length));
  return entries.some((a) => (a.hash ? a.hash === h : a.preview === hit.preview && (a.kind ? a.kind === hit.kind : true) && (a.line == null || a.line === hit.line)));
}

/**
 * 本機遮蔽（不經過模型）：把每個疑似金鑰換成「‹已遮蔽：kind›」。allowed 為這個檔案在「不是金鑰」清單裡的項目。
 * @returns {{ text: string, matches: { line, kind, preview }[] }}
 */
export function redactSecrets(text, allowed = []) {
  const hits = scanSecrets(text).filter((h) => !isAllowedHit(h, allowed, text));
  let out = text;
  for (const h of [...hits].sort((a, b) => b.offset - a.offset)) {
    out = `${out.slice(0, h.offset)}‹已遮蔽：${h.kind}›${out.slice(h.offset + h.length)}`;
  }
  return { text: out, matches: hits.map(({ line, kind, preview }) => ({ line, kind, preview })) };
}
