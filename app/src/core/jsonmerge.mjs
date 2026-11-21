// 2.0 新增的同步 JSON 的衝突合併（第二輪審查 R4）：兩台同時修改時，兩邊的內容都留下，不交給 LLM，也不讓輸的一邊消失。
// 做法參考 core/sync.mjs 的 release.json、settings.json 與保留區項目的合併：純函式，兩台各自合併得到同一份（順序也一樣），
// 合併後不會再產生衝突。base 是共同的舊版本（兩邊都新建的檔案沒有 base）。
// - guardrails/rules.json：以規則 id 為單位三方合併；兩邊都改了同一個 id（而且不一樣）時留 addedAt 較新的；一邊刪掉、另一邊沒動就刪，
//   一邊刪掉、另一邊改了就留改過的（不讓內容消失）。defaults 任何一邊是 true 就是 true。
// - env/profile.json：env 與 settings 逐鍵三方合併；兩邊都改而值不同時留檔案層級 updatedAt 較新的那一邊，輸的那一邊的值回報給呼叫端
//   （記進衝突隔離區給使用者看）。技能與外掛以名稱為單位，同樣三方合併有無。

const parse = (t) => { try { const j = JSON.parse(String(t).replace(/^﻿/, '')); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; } };
const canon = (v) => (v === undefined ? undefined : JSON.stringify(sortDeep(v)));
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}
const same = (a, b) => canon(a) === canon(b);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const out = (v) => `${JSON.stringify(v, null, 2)}\n`;

/**
 * 一個鍵的三方合併：{ value, conflict }。value 是 undefined 表示刪掉。conflict：兩邊都改而且不一樣（呼叫端決定留哪一邊）。
 */
function three(o, t, b) {
  if (same(o, t)) return { value: o };
  if (same(o, b)) return { value: t };
  if (same(t, b)) return { value: o };
  // 一邊刪掉、另一邊改了：留改過的，不讓內容消失
  if (o === undefined) return { value: t };
  if (t === undefined) return { value: o };
  return { conflict: true };
}

/** guardrails/rules.json 的合併；回傳合併後的原文。一邊讀不懂就留另一邊，兩邊都讀不懂回傳 null（交給一般的衝突處理） */
export function mergeRulesJson(ours, theirs, base = null) {
  return mergeRulesDetail(ours, theirs, base)?.text ?? null;
}

/**
 * 同 mergeRulesJson，另外回報輸的規則（第三輪審查 R4：記進衝突隔離區，不讓輸的一邊消失）：{ text, losers: [{ id }] }
 * （losers：兩邊都改了同一條規則而且不一樣、沒有被採用的那一邊）。一邊讀不懂就留另一邊（losers 是空的）；兩邊都讀不懂回傳 null。
 */
export function mergeRulesDetail(ours, theirs, base = null) {
  const a = parse(ours);
  const b = parse(theirs);
  if (!a || !b || !Array.isArray(a.rules) || !Array.isArray(b.rules)) {
    const text = a && Array.isArray(a.rules) ? ours : b && Array.isArray(b.rules) ? theirs : null;
    return text === null ? null : { text, losers: [] };
  }
  const c = parse(base);
  const byId = (list) => new Map((Array.isArray(list) ? list : []).filter((r) => r && typeof r.id === 'string').map((r) => [r.id, r]));
  const mo = byId(a.rules);
  const mt = byId(b.rules);
  const mb = byId(c?.rules);
  const merged = new Map();
  const losers = [];
  for (const id of new Set([...mo.keys(), ...mt.keys(), ...mb.keys()])) {
    const r = three(mo.get(id), mt.get(id), mb.get(id));
    let v = r.value;
    if (r.conflict) {
      const o = mo.get(id);
      const t = mt.get(id);
      const ka = String(o.addedAt ?? '');
      const kb = String(t.addedAt ?? '');
      v = ka !== kb ? (ka > kb ? o : t) : canon(o) >= canon(t) ? o : t;
      losers.push({ id });
    }
    if (v !== undefined) merged.set(id, v);
  }
  // 順序：共同舊版本裡的順序，之後新增的依 addedAt、id（兩台算出來一樣）
  const baseOrder = [...mb.keys()].filter((id) => merged.has(id));
  const rest = [...merged.keys()].filter((id) => !mb.has(id)).sort((x, y) => cmp(String(merged.get(x).addedAt ?? ''), String(merged.get(y).addedAt ?? '')) || cmp(x, y));
  const defaults = a.defaults === true || b.defaults === true;
  return { text: out({ v: 1, ...(defaults ? { defaults: true } : {}), rules: [...baseOrder, ...rest].map((id) => merged.get(id)) }), losers: losers.sort((x, y) => cmp(x.id, y.id)) };
}

/**
 * 衝突紀錄裡兩邊不同的值（第三輪審查 R4，處理 env/profile.json 與 guardrails/rules.json 的衝突紀錄用）：
 * [{ kind: 'env'|'setting'|'rule', key, ours, theirs }]，ours／theirs 是紀錄裡兩個版本各自的值（undefined 表示那一邊沒有）。
 * 用同一個合併重新算出哪些鍵兩邊都改了（純函式，和同步時記下紀錄的結果一樣）。
 * 回傳 { diffs }；兩個版本有一個讀不懂時 { unreadable: true }；都讀得懂但沒有兩邊都改過的值時 { diffs: null }（第四輪審查 F-11 區分兩者）。
 */
export function jsonConflictValues(ref, ours, theirs, base = null) {
  const a = parse(ours);
  const b = parse(theirs);
  if (!a || !b) return { unreadable: true };
  if (ref === 'env/profile.json') {
    const m = mergeProfileJson(ours, theirs, base);
    if (!m?.losers.length) return { diffs: null };
    const field = (area) => (area === 'setting' ? 'settings' : 'env');
    const pick = (doc, area, key) => { const map = doc[field(area)]; return map && typeof map === 'object' && Object.hasOwn(map, key) ? map[key] : undefined; };
    return { diffs: m.losers.map((x) => ({ kind: x.area === 'setting' ? 'setting' : 'env', key: x.key, ours: pick(a, x.area, x.key), theirs: pick(b, x.area, x.key) })) };
  }
  if (ref === 'guardrails/rules.json') {
    const m = mergeRulesDetail(ours, theirs, base);
    if (!m) return { unreadable: true };
    if (!m.losers.length) return { diffs: null };
    const find = (doc, id) => (Array.isArray(doc.rules) ? doc.rules.find((r) => r && r.id === id) : undefined);
    return { diffs: m.losers.map((x) => ({ kind: 'rule', key: x.id, ours: find(a, x.id), theirs: find(b, x.id) })) };
  }
  return { unreadable: true };
}

/** 兩個值是否相同（鍵的順序不算） */
export const sameValue = (x, y) => same(x, y);

/**
 * env/profile.json 的合併：{ text, losers: [{ area, key, value }] }（losers：兩邊都改而值不同、沒有被採用的那一邊）。
 * 一邊讀不懂就留另一邊；兩邊都讀不懂回傳 null。
 */
export function mergeProfileJson(ours, theirs, base = null) {
  const a = parse(ours);
  const b = parse(theirs);
  if (!a || !b) return a ? { text: ours, losers: [] } : b ? { text: theirs, losers: [] } : null;
  const c = parse(base) ?? {};
  const ta = String(a.updatedAt ?? '');
  const tb = String(b.updatedAt ?? '');
  // 檔案層級較新的那一邊（時間相同時取內容排序較大的，兩台算出來一樣）
  const newerIsA = ta !== tb ? ta > tb : canon(a) >= canon(b);
  const losers = [];
  const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  const mergeMap = (area, field) => {
    const o = obj(a[field]);
    const t = obj(b[field]);
    const s = obj(c[field]);
    const res = {};
    for (const k of [...new Set([...Object.keys(o), ...Object.keys(t), ...Object.keys(s)])].sort(cmp)) {
      const r = three(o[k], t[k], s[k]);
      if (r.conflict) {
        res[k] = newerIsA ? o[k] : t[k];
        losers.push({ area, key: k, value: newerIsA ? t[k] : o[k] });
      } else if (r.value !== undefined) res[k] = r.value;
    }
    return res;
  };
  // 名稱清單（技能、外掛）：以名稱為單位三方合併有無
  const mergeSet = (field, keyOf) => {
    const map = (x) => new Map((Array.isArray(x) ? x : []).map((v) => [keyOf(v), v]).filter(([k]) => typeof k === 'string' && k));
    const o = map(a[field]);
    const t = map(b[field]);
    const s = map(c[field]);
    const res = [];
    for (const k of [...new Set([...o.keys(), ...t.keys(), ...s.keys()])].sort(cmp)) {
      const inO = o.has(k);
      const inT = t.has(k);
      // 兩邊都有：留；只有一邊有：舊版本裡沒有（那一邊新增的）才留，舊版本裡有（另一邊刪掉了）就刪
      const keep = (inO && inT) || (inO !== inT && !s.has(k));
      if (keep) res.push(inO ? o.get(k) : t.get(k));
    }
    return res;
  };
  const merged = {
    v: 1,
    env: mergeMap('env', 'env'),
    settings: mergeMap('setting', 'settings'),
    skills: mergeSet('skills', (v) => (typeof v === 'string' ? v : null)),
    plugins: mergeSet('plugins', (v) => (v && typeof v.name === 'string' ? `${v.name}@${v.marketplace ?? ''}` : null)),
    updatedAt: (newerIsA ? a : b).updatedAt ?? null,
    by: (newerIsA ? a : b).by ?? null,
  };
  return { text: out(merged), losers };
}
