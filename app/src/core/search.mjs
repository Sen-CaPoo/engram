// 記憶搜尋：中英混合分詞 + 欄位加權 BM25，全部在記憶體內完成，不依賴第三方套件。

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー]+/u;
const RUNS = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー]+)|([[\p{L}\p{N}]--[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]]+)/gv;
// camelCase 切點：小寫/數字→大寫、連續大寫→大寫+小寫（HTTPServer → HTTP | Server）
const CAMEL = /(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u;

const segmenter = new Intl.Segmenter('zh-TW', { granularity: 'word' });

const FIELDS = /** @type {const} */ (['name', 'description', 'tags', 'body']);
const WEIGHTS = { name: 3, description: 2, tags: 2, body: 1 };
const K1 = 1.2;
const B = 0.75;
const EXPANSION_FACTOR = 0.8;
const MAX_EXPANSIONS = 50;

/** @param {string} t */
const isCjk = (t) => CJK_RUN.test(t);

/**
 * 把文字切成檢索詞元（保留重複，供詞頻計算）。
 * - 英文與數字：轉小寫；以非字母數字切開（涵蓋 kebab-case、snake_case）；
 *   camelCase 會再切開，並保留整段小寫複合詞（LiteLLM → lite、llm、litellm）。
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
      for (const seg of segmenter.segment(run)) {
        if (seg.isWordLike && [...seg.segment].length >= 3) out.push(seg.segment);
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

/**
 * @typedef {{ name?: string, description?: string, body?: string, tags?: string[] }} SearchDoc
 * @typedef {{ id: string, score: number, fields: string[] }} SearchHit
 */

export class SearchIndex {
  /** @type {Map<string, { len: Record<string, number>, terms: Record<string, Map<string, number>> }>} */
  #docs = new Map();
  /** @type {Record<string, Map<string, Map<string, number>>>} 欄位 → 詞 → (文件 → 詞頻) */
  #postings = { name: new Map(), description: new Map(), tags: new Map(), body: new Map() };
  /** @type {Record<string, number>} */
  #totalLen = { name: 0, description: 0, tags: 0, body: 0 };
  /** @type {Map<string, number>} 詞 → 出現在幾個（文件, 欄位）組合，供前綴展開 */
  #vocab = new Map();

  get size() {
    return this.#docs.size;
  }

  /**
   * 加入或取代一份文件。
   * @param {string} id
   * @param {SearchDoc} doc
   */
  add(id, { name = '', description = '', body = '', tags = [] } = {}) {
    if (this.#docs.has(id)) this.remove(id);
    const texts = { name, description, tags: (tags || []).join(' '), body };
    const entry = { len: {}, terms: {} };
    for (const f of FIELDS) {
      const toks = tokenize(texts[f]);
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      entry.len[f] = toks.length;
      entry.terms[f] = tf;
      this.#totalLen[f] += toks.length;
      const post = this.#postings[f];
      for (const [t, n] of tf) {
        let ids = post.get(t);
        if (!ids) post.set(t, (ids = new Map()));
        ids.set(id, n);
        this.#vocab.set(t, (this.#vocab.get(t) || 0) + 1);
      }
    }
    this.#docs.set(id, entry);
  }

  /** @param {string} id */
  remove(id) {
    const entry = this.#docs.get(id);
    if (!entry) return;
    for (const f of FIELDS) {
      this.#totalLen[f] -= entry.len[f];
      const post = this.#postings[f];
      for (const t of entry.terms[f].keys()) {
        const ids = post.get(t);
        if (ids) {
          ids.delete(id);
          if (ids.size === 0) post.delete(t);
        }
        const c = (this.#vocab.get(t) || 0) - 1;
        if (c > 0) this.#vocab.set(t, c);
        else this.#vocab.delete(t);
      }
    }
    this.#docs.delete(id);
  }

  /**
   * @param {string} query
   * @param {{ limit?: number }} [opts]
   * @returns {SearchHit[]}
   */
  search(query, { limit = 20 } = {}) {
    const N = this.#docs.size;
    if (N === 0) return [];
    const qTokens = [...new Set(tokenize(query))];
    if (qTokens.length === 0) return [];

    // 最後一個英文詞元做前綴展開；單一中文字展開成含有該字的詞
    let lastLatin = -1;
    qTokens.forEach((t, i) => { if (!isCjk(t)) lastLatin = i; });
    const groups = qTokens.map((tok, i) => {
      const terms = [{ term: tok, factor: 1 }];
      let match = null;
      if (i === lastLatin && tok.length >= 2) match = (v) => v !== tok && v.startsWith(tok);
      else if (isCjk(tok) && [...tok].length === 1) match = (v) => v !== tok && v.includes(tok);
      if (match) {
        const extra = [];
        for (const [v, c] of this.#vocab) if (match(v)) extra.push([v, c]);
        extra.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
        for (const [v] of extra.slice(0, MAX_EXPANSIONS)) terms.push({ term: v, factor: EXPANSION_FACTOR });
      }
      return terms;
    });

    /** @type {Map<string, { raw: number, fields: Set<string>, groups: Set<number> }>} */
    const acc = new Map();
    groups.forEach((terms, gi) => {
      for (const { term, factor } of terms) {
        for (const f of FIELDS) {
          const ids = this.#postings[f].get(term);
          if (!ids) continue;
          const df = ids.size;
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          const avgdl = this.#totalLen[f] / N || 1;
          for (const [id, tf] of ids) {
            const dl = this.#docs.get(id).len[f];
            const s = (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * dl) / avgdl));
            let a = acc.get(id);
            if (!a) acc.set(id, (a = { raw: 0, fields: new Set(), groups: new Set() }));
            a.raw += WEIGHTS[f] * factor * s;
            a.fields.add(f);
            a.groups.add(gi);
          }
        }
      }
    });

    // 協調係數：命中越多查詢詞，分數越高
    const hits = [];
    for (const [id, a] of acc) {
      hits.push({
        id,
        score: a.raw * (a.groups.size / groups.length),
        fields: FIELDS.filter((f) => a.fields.has(f)),
      });
    }
    hits.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    return hits.slice(0, limit);
  }
}
