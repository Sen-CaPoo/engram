// 介面語系：正體中文（原文）與英文。
// - t('中文原文 {name}', { name })：中文原文就是鍵；英文對照在 locales/en/*.js。
//   英文值可以是字串，或依參數挑選字串的函式（例如英文的單複數），回傳的字串一樣會代入參數。
//   參數裡有 JSX 元素時回傳陣列（[字串, 元素, 字串…]），直接放進 JSX 即可。
// - N_('中文')：模組層的標籤表用它標記「顯示時會用 t() 翻譯」的字串，執行時原樣回傳。
// - 鍵一律寫成字串字面值（不能用樣板字串）；新增或修改中文後，在 locales/en/ 補上英文，i18n 測試會檢查。
// - local(obj, 'title')：常駐程式傳來的物件附有 en 欄位時，英文模式改用 obj.en.title。
// 這份檔案不能依賴瀏覽器以外的套件：app/test/ui/i18n.test.mjs 會在 Node 直接載入它。
import en from './locales/en/index.js';

export const LANGS = [
  { id: 'zh-TW', label: '中文', html: 'zh-Hant-TW', locale: 'zh-TW' },
  { id: 'en', label: 'English', html: 'en', locale: 'en-US' },
];
const DICTS = { en };
const STORE_KEY = 'engram.lang';

export function detectLang() {
  try {
    const saved = globalThis.localStorage?.getItem(STORE_KEY);
    if (LANGS.some((l) => l.id === saved)) return saved;
  } catch { /* 無法存取時依瀏覽器語言 */ }
  const nav = globalThis.navigator;
  const first = String(nav?.languages?.[0] || nav?.language || 'zh-TW').toLowerCase();
  return first.startsWith('zh') ? 'zh-TW' : 'en';
}

let current = detectLang();

export const getLang = () => current;
export const locale = () => (LANGS.find((l) => l.id === current) || LANGS[0]).locale;

/**
 * 切換語言；persist 為 true（使用者自己選的）才記在這個瀏覽器，自動偵測的不記，之後仍跟著瀏覽器語言。
 * 回傳實際採用的語言。畫面重新繪製由呼叫端（App 的 state）負責。
 */
export function setLang(id, persist = true) {
  if (!LANGS.some((l) => l.id === id)) return current;
  current = id;
  if (persist) { try { globalThis.localStorage?.setItem(STORE_KEY, id); } catch { /* 無法存取時只在這次有效 */ } }
  if (globalThis.document) globalThis.document.documentElement.lang = LANGS.find((l) => l.id === id).html;
  return current;
}

export const N_ = (s) => s;

const isPart = (v) => v !== null && typeof v === 'object';

function interpolate(s, vars) {
  if (!vars) return s;
  if (!Object.values(vars).some(isPart)) {
    return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars && vars[k] != null ? String(vars[k]) : m));
  }
  const out = [];
  let last = 0;
  for (const m of s.matchAll(/\{(\w+)\}/g)) {
    if (!(m[1] in vars)) continue;
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(vars[m[1]]);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

// 同一句中文在不同位置需要不同英文時（例如導覽的「專案」是 Projects、類型的「專案」是 Project），
// 鍵前面加情境：t('nav::專案')。中文模式顯示時去掉情境。
const CONTEXT = /^[a-z][a-z0-9-]*::/;

export function t(key, vars) {
  // 標籤表查不到時鍵會是 undefined：顯示空白，不讓整頁當掉
  if (typeof key !== 'string') return key ?? '';
  let s;
  const dict = DICTS[current];
  if (dict && Object.hasOwn(dict, key)) {
    const v = dict[key];
    s = typeof v === 'function' ? v(vars || {}) : v;
  } else {
    s = key.replace(CONTEXT, '');
  }
  return interpolate(s, vars);
}

/** 常駐程式的文字：英文模式且有 en 欄位時用英文，否則用原文 */
export function local(obj, field) {
  if (!obj) return obj;
  if (current !== 'zh-TW') {
    const v = obj.en?.[field];
    if (v != null && v !== '') return v;
  }
  return obj[field];
}

// 測試用：不經過 localStorage 直接切換
export function _setLangForTest(id) { current = id; }
