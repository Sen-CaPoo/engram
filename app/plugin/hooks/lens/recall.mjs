// 情境召回（2.0.0 P3）：使用者送出訊息時，找出「和這則訊息相關、但不在這次對話已載入的索引裡」的記憶，最多 3 筆。
// 純函式、不依賴 Node API：mod（hooks/recall.ts）、指令型後備（hooks/recall-hook.mjs）與 Node 端（core/recall.mjs 建索引、
// core/search.mjs 的搜尋）共用同一份斷詞與計分，三邊的結果才會一樣。
//
// 索引 local/cache/recall.json 由常駐程式在記憶有變動時重建（core/recall.mjs）：
// { v, builtAt, mid, n, avgdl, docs: [{ ref, path, name, desc, type, pid, loaded, len }], terms: { 詞: [文件序號, 詞頻, …] }, roots: [{ path, pid }] }
// - pid：專案記憶所屬的專案；單機記憶標了 engram.project 的也算那個專案。
// - loaded：'*' 每場對話都會載入（列在全域或這台電腦的索引）；'<pid>' 只在那個專案的對話載入（MEMORY.md、開場訊息）；null 沒有列在任何索引。
// - terms：倒排表（同一詞在每份文件的加權詞頻），計分只需要查詢裡出現的詞。
// - roots：這台電腦綁定的專案資料夾（小寫、正斜線），用來從對話的 cwd 找出目前的專案。

export const RECALL_VERSION = 1;

// ───────── 斷詞（原本在 core/search.mjs，搬來這裡讓 mod 也能用；search.mjs 轉匯出同一個函式） ─────────

const SCRIPTS = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const CJK_RUN = new RegExp(`[${SCRIPTS}ー]+`, 'u');
/** 中日韓的連續區段、或其他文字與數字的連續區段。v 旗標（集合相減）不支援時改用等價的否定前瞻寫法 */
const RUNS = (() => {
  try {
    return new RegExp(`([${SCRIPTS}ー]+)|([[\\p{L}\\p{N}]--[${SCRIPTS}]]+)`, 'gv');
  } catch {
    return new RegExp(`([${SCRIPTS}ー]+)|((?:(?![${SCRIPTS}])[\\p{L}\\p{N}])+)`, 'gu');
  }
})();
// camelCase 切點：小寫/數字→大寫、連續大寫→大寫+小寫（HTTPServer → HTTP | Server）
const CAMEL = /(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u;

/** 沒有 Intl.Segmenter 的環境只少了「三字以上的詞」這一項，雙字組照樣涵蓋 */
const segmenter = (() => {
  try {
    return typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh-TW', { granularity: 'word' }) : null;
  } catch {
    return null;
  }
})();

/** @param {string} t */
export const isCjk = (t) => CJK_RUN.test(t);

/**
 * 把文字切成檢索詞元（保留重複，供詞頻計算）。
 * - 英文與數字：轉小寫；以非字母數字切開（涵蓋 kebab-case、snake_case）；
 *   camelCase 會再切開，並保留整段小寫複合詞（QuillMate → quill、mate、quillmate）。
 * - 中日韓：每個連續區段產生字元雙字組；Intl.Segmenter 切出 3 字以上的詞另外加入；
 *   只有 1 個字的區段直接以單字加入。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (!text) return [];
  const out = [];
  const src = String(text).normalize('NFKC');
  for (const m of src.matchAll(RUNS)) {
    if (m[1]) {
      const run = m[1];
      const chars = [...run];
      if (chars.length === 1) {
        out.push(run);
        continue;
      }
      for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
      if (segmenter) {
        for (const seg of segmenter.segment(run)) {
          if (seg.isWordLike && [...seg.segment].length >= 3) out.push(seg.segment);
        }
      }
    } else {
      const run = m[2];
      const parts = run.split(CAMEL);
      for (const p of parts) out.push(p.toLowerCase());
      if (parts.length > 1) out.push(run.toLowerCase());
    }
  }
  return out;
}

// ───────── 訊息的查詢詞 ─────────
// 對話的訊息不是搜尋關鍵字：裡面有很多虛詞與口語，中文的雙字組又會跨過詞的邊界（「裡的」「有沒」）。
// 記憶少的時候這些詞的 idf 反而很高，一兩個巧合就會被帶出來，所以查詢詞要先過濾（索引那一側照 tokenize 原樣）。

/** 只當虛詞用的中文字：含這些字的雙字組不當查詢詞（刻意保守，像「會」「用」「上」都會組成實詞，不列） */
export const STOP_CHARS = new Set('的了嗎呢吧啊喔呀哦嗯我你他她它們這那把被讓就也都又很'.split(''));
/** 口語與泛用的詞：中文兩字以上、英文全部小寫 */
export const STOP_WORDS = new Set([
  '一下', '一個', '一些', '可以', '沒有', '有沒有', '什麼', '怎麼', '怎樣', '為什麼', '如何', '需要', '不要', '可能', '應該', '現在', '已經', '還是', '或是',
  '然後', '因為', '所以', '如果', '但是', '是否', '就是', '還有', '不是', '一起', '時候', '看看', '一直', '目前', '今天', '東西', '這樣', '那樣', '幫忙',
  '謝謝', '請問', '繼續', '幫我', '請幫', '看一下', '什麼時候',
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'so', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'is', 'are', 'was', 'were',
  'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'me', 'my', 'you', 'your', 'we', 'our', 'he', 'she', 'they', 'them', 'do', 'does',
  'did', 'how', 'what', 'why', 'when', 'where', 'which', 'who', 'can', 'could', 'would', 'should', 'will', 'please', 'ok', 'okay', 'yes', 'no', 'not',
  'just', 'all', 'any', 'some', 'next', 'step', 'thanks', 'thank', 'let', 'lets', 'make', 'get', 'use', 'using', 'help', 'need', 'want', 'also',
  'there', 'here', 'about', 'into', 'out', 'up', 'now', 'again', 'continue',
]);

/**
 * 訊息的查詢詞：tokenize 之後去掉重複、單一字元（「槽」「c」）、含虛詞字的中文詞（「裡的」）、口語與泛用的詞。
 * @param {string} text
 * @returns {string[]}
 */
export function queryTerms(text) {
  const out = [];
  const seen = new Set();
  for (const t of tokenize(String(text ?? '').slice(0, MAX_QUERY_CHARS))) {
    if (seen.has(t)) continue;
    seen.add(t);
    const chars = [...t];
    if (chars.length < 2 || STOP_WORDS.has(t)) continue;
    if (isCjk(t) && chars.some((c) => STOP_CHARS.has(c))) continue;
    out.push(t);
  }
  return out;
}

// ───────── 建索引與計分的常數 ─────────

/** 欄位加權：名稱出現的詞算 3 次、說明與標籤 2 次、內文 1 次（同 core/search.mjs 的 WEIGHTS） */
export const FIELD_WEIGHTS = Object.freeze({ name: 3, description: 2, tags: 2, body: 1 });
/** 內文只取前 4,000 字做斷詞 */
export const BODY_CHARS = 4000;
/** 索引檔的大小上限 */
export const MAX_INDEX_BYTES = 2 * 1024 * 1024;
/** 一則訊息最多帶出幾筆 */
export const MAX_HITS = 3;
/**
 * 分數低於這個門檻不帶。分數是 BM25 除以「只出現在一筆記憶的詞」的 idf，大約等於「命中幾個罕見的詞」，
 * 記憶多寡不影響門檻的意義。校準案例見 test/plugin/recall-fixture.mjs（虛構語料 40 筆）：該帶的最低約 3.7，閒聊與泛用的請求最高約 2.6。
 */
export const MIN_SCORE = 3;
/** 至少要命中幾個不同的詞才帶：只碰到一個詞多半是巧合 */
export const MIN_TERMS = 2;
/** 低於最高分這個比例的不帶：只留和最相關那筆差不多相關的 */
export const RELATIVE_FLOOR = 0.5;
/** 目前專案的記憶加權 */
export const PROJECT_BOOST = 1.5;
/** 出現在超過這個比例的記憶裡的詞不計分（像「設定」「使用」這種到處都有的詞）；記憶少於 COMMON_MIN_DOCS 筆時不套用 */
export const COMMON_DF = 0.4;
export const COMMON_MIN_DOCS = 10;
/** 訊息只取前 2,000 字（貼上長篇記錄時，計分時間與雜訊都有上限） */
export const MAX_QUERY_CHARS = 2000;
/** mod 的時間上限：超過就原樣送出（讀索引的工作在背景做完，下一則訊息就用得到） */
export const TIMEOUT_MS = 250;
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * 建索引（Node 端在 core/recall.mjs 收集記憶後呼叫；這裡只做斷詞、加權與大小控制）。
 * entries：[{ ref, path, name, desc, type, pid, loaded, tags, body }]，內容要先遮蔽疑似金鑰。
 * 序列化後超過 maxBytes 時，每份文件只留 tf×idf 最高的那些詞，逐步減少直到放得下（決定性的：同樣的輸入一定得到同樣的檔案）。
 * @returns {{ index: object, text: string, bytes: number, cap: number|null }}
 */
export function buildIndex(entries, { mid = null, roots = [], builtAt = null, maxBytes = MAX_INDEX_BYTES } = {}) {
  const list = [...entries].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const docs = [];
  const tfs = [];
  for (const e of list) {
    const tf = new Map();
    const add = (text, w) => {
      for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + w);
    };
    add(e.name, FIELD_WEIGHTS.name);
    add(e.desc, FIELD_WEIGHTS.description);
    add((e.tags ?? []).join(' '), FIELD_WEIGHTS.tags);
    add(String(e.body ?? '').slice(0, BODY_CHARS), FIELD_WEIGHTS.body);
    let len = 0;
    for (const v of tf.values()) len += v;
    docs.push({ ref: e.ref, path: e.path, name: e.name, desc: e.desc, type: e.type ?? '', pid: e.pid ?? null, loaded: e.loaded ?? null, len });
    tfs.push(tf);
  }
  const n = docs.length;
  const avgdl = n ? docs.reduce((s, d) => s + d.len, 0) / n : 1;
  const df = new Map();
  for (const tf of tfs) for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t) => Math.log(1 + (n - df.get(t) + 0.5) / (df.get(t) + 0.5));
  const sortedRoots = [...roots].map((r) => ({ path: normRoot(r.path), pid: r.pid })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const make = (lists, cap) => {
    const post = new Map();
    lists.forEach((terms, i) => {
      for (const [t, v] of cap === null ? terms : terms.slice(0, cap)) {
        let p = post.get(t);
        if (!p) post.set(t, (p = []));
        p.push(i, v);
      }
    });
    const keys = [...post.keys()].sort();
    const index = { v: RECALL_VERSION, builtAt, mid, n, avgdl: Math.round(avgdl * 1000) / 1000, docs, terms: Object.fromEntries(keys.map((k) => [k, post.get(k)])), roots: sortedRoots };
    const text = JSON.stringify(index);
    return { index, text, bytes: new TextEncoder().encode(text).length, cap };
  };
  const full = make(tfs.map((tf) => [...tf.entries()]), null);
  if (full.bytes <= maxBytes) return full;
  // 放不下：每份文件的詞依 tf×idf 排好（同分依詞的字典序），只留前 cap 個。
  // 先用「每一筆倒排平均幾個位元組」估一個 cap，再每次少一成直到放得下（每試一次都要序列化整個索引，所以不從頭慢慢減）
  const idfs = new Map([...df.keys()].map((t) => [t, idf(t)]));
  const ranked = tfs.map((tf) => [...tf.entries()]
    .map(([t, v]) => ({ t, v, w: v * idfs.get(t) }))
    .sort((a, b) => b.w - a.w || (a.t < b.t ? -1 : 1))
    .map(({ t, v }) => [t, v]));
  const fixed = new TextEncoder().encode(JSON.stringify(docs)).length;
  const postings = (cap) => ranked.reduce((s, r) => s + Math.min(r.length, cap), 0);
  const perPosting = Math.max(1, (full.bytes - fixed) / postings(Infinity));
  const allowed = (maxBytes * 0.95 - fixed) / perPosting;
  let lo = 1;
  let hi = Math.max(1, ...ranked.map((r) => r.length));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (postings(mid) <= allowed) lo = mid;
    else hi = mid - 1;
  }
  for (let cap = lo; ; cap = Math.max(1, Math.floor(cap * 0.9))) {
    const r = make(ranked, cap);
    if (r.bytes <= maxBytes || cap === 1) return r;
  }
}

/** 讀進來的索引是否能用（版本、欄位的形狀）；不能用時回傳 null */
export function parseIndex(text) {
  let x;
  try {
    x = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    return null;
  }
  if (!x || x.v !== RECALL_VERSION || !Array.isArray(x.docs) || !x.terms || typeof x.terms !== 'object' || Array.isArray(x.terms)) return null;
  const n = x.docs.length;
  if (x.n !== n || (n && !(x.avgdl > 0))) return null;
  return { ...x, avgdl: n ? x.avgdl : 1, roots: Array.isArray(x.roots) ? x.roots : [] };
}

/** 反斜線轉正斜線、去掉結尾斜線、轉小寫（Windows 不分大小寫）；Git Bash 的 /c/… 轉成 c:/… */
export function normRoot(p) {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/([A-Za-z])(?=\/|$)/, (_, d) => `${d}:`)
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** 對話的 cwd 屬於哪個綁定的專案：最長的前綴相符 */
export function projectOf(index, cwd) {
  const c = normRoot(cwd);
  if (!c) return null;
  let best = null;
  for (const r of index?.roots ?? []) {
    const p = normRoot(r?.path);
    if (!p || !(c === p || c.startsWith(`${p}/`))) continue;
    if (!best || p.length > best.len) best = { len: p.length, pid: r.pid ?? null };
  }
  return best?.pid ?? null;
}

/**
 * 計分（BM25），回傳要帶出的記憶（最多 MAX_HITS 筆，分數高到低）。
 * - pid：目前的專案（加權、判斷專案的索引有沒有載入）。
 * - exclude：這場對話已經帶過的 ref，不重複。
 * 已列在這次對話載入的索引裡的不帶；分數低於門檻、命中的詞太少、遠低於最高分的不帶。
 * @returns {{ ref: string, path: string, name: string, desc: string, score: number }[]}
 */
export function score(index, query, { pid = null, exclude = new Set(), limit = MAX_HITS } = {}) {
  const N = index?.n ?? 0;
  if (!N || !query) return [];
  const q = queryTerms(query);
  /** @type {Map<number, { s: number, k: number }>} */
  const acc = new Map();
  for (const t of q) {
    if (!hasOwn(index.terms, t)) continue;
    const post = index.terms[t];
    if (!Array.isArray(post) || !post.length) continue;
    const df = post.length / 2;
    if (N >= COMMON_MIN_DOCS && df / N > COMMON_DF) continue;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (let i = 0; i + 1 < post.length; i += 2) {
      const d = post[i];
      const tf = post[i + 1];
      const doc = index.docs[d];
      if (!doc || !(tf > 0)) continue;
      const s = (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * (doc.len || 0)) / index.avgdl));
      const a = acc.get(d);
      if (a) {
        a.s += s;
        a.k++;
      } else acc.set(d, { s, k: 1 });
    }
  }
  const unit = Math.log(1 + (N - 0.5) / 1.5); // 只出現在一筆記憶的詞的 idf
  const hits = [];
  for (const [d, a] of acc) {
    const doc = index.docs[d];
    if (doc.loaded === '*' || (doc.loaded && doc.loaded === pid)) continue;
    // 別的專案的記憶不帶：不同專案可能屬於不同的客戶或工作，內容不該互相出現（全域與單機記憶沒有 pid，照常帶）
    if (doc.pid && doc.pid !== pid) continue;
    if (exclude.has(doc.ref) || a.k < MIN_TERMS) continue;
    const s = ((pid && doc.pid === pid) ? a.s * PROJECT_BOOST : a.s) / unit;
    if (s < MIN_SCORE) continue;
    hits.push({ ref: doc.ref, path: doc.path, name: doc.name, desc: doc.desc, score: Math.round(s * 100) / 100 });
  }
  hits.sort((x, y) => y.score - x.score || (x.ref < y.ref ? -1 : x.ref > y.ref ? 1 : 0));
  const best = hits[0]?.score ?? 0;
  return hits.filter((h) => h.score >= best * RELATIVE_FLOOR).slice(0, limit);
}

/** 附在訊息後面、只有 Claude 看得到的文字；沒有命中時 null */
export function contextText(hits) {
  if (!hits?.length) return null;
  const lines = hits.map((h) => `- [${h.name}](${h.path})${h.desc ? ` — ${h.desc}` : ''}`);
  return `[Engram 情境召回] 這幾筆記憶可能和這則訊息有關，沒有列在這次對話已載入的索引裡；用得到時用 Read 讀取全文，用不到就忽略：\n${lines.join('\n')}`;
}

/** 帶出紀錄的一行（local/usage/recall/<日期>.jsonl）：時間、對話 id、ref、分數 */
export function usageLine({ at, session, ref, score: s }) {
  return `${JSON.stringify({ at, session, ref, score: s })}\n`;
}

/**
 * 帶出紀錄的檔名：local/usage/recall/<UTC 日期>.jsonl（指令型後備，追加寫入）或 <UTC 日期>.<程序代號>.jsonl（mod，每個程序各寫自己的檔，
 * 同時開著好幾個 Claude Code 時不會互相覆蓋）。讀的一方（統計、同場不重複）把同一天的檔都讀進來。
 */
export const USAGE_FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:\.[A-Za-z0-9_-]{1,40})?\.jsonl$/;
export const usageFileName = (day, instance = null) => (instance ? `${day}.${instance}.jsonl` : `${day}.jsonl`);
const DAY_MS = 86_400_000;

/** 同場不重複要看的紀錄檔：今天與昨天（UTC）的；names 是資料夾裡的檔名 */
export function recentUsageFiles(names, now) {
  const days = new Set([new Date(now).toISOString().slice(0, 10), new Date(now - DAY_MS).toISOString().slice(0, 10)]);
  return names.filter((n) => days.has(USAGE_FILE_RE.exec(n)?.[1] ?? '')).sort();
}

/** 從帶出紀錄找出這場對話已經帶過的 ref */
export function recalledIn(text, session) {
  const out = new Set();
  if (!text || !session) return out;
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row?.session === session && typeof row.ref === 'string') out.add(row.ref);
    } catch {
      // 壞掉的行略過
    }
  }
  return out;
}

/**
 * 實際生效的 recall：這台的設定（local/settings.json）明確寫 off 才關閉；
 * 但所有電腦共用的索引分層（vault/settings.json 的 indexLayers）是 on 時強制開啟（參考類記憶不在索引裡，只能靠召回帶出）。
 */
export function recallMode(localText, sharedText = null) {
  const parse = (text) => {
    try {
      return JSON.parse(text ?? '{}') ?? {};
    } catch {
      return {};
    }
  };
  if (parse(sharedText)?.indexLayers === 'on') return 'on';
  return parse(localText)?.recall === 'off' ? 'off' : 'on';
}
