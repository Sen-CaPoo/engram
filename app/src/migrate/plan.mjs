// 匯入計畫的「使用者調整」：精靈只送出調整內容（edits），不送整份計畫。
// 這樣不論在真實環境或沙盒裡重新產生計畫，都能套用同一份調整。
//
// edits 格式：
//   { items:   { "<encoded>/<file>": { action?: 'copy'|'skip-same', scope?: 'project'|'global'|'machine' } },
//     names:   { "<encoded>|<resolvedPath>": "新專案的顯示名稱" },
//     targets: { "<encoded>|<resolvedPath>": { pid } | { sameAs: "<encoded>|<resolvedPath>" } | { path } },   採用引擎的「同一個專案」建議
//     revs:    { "<encoded>|<resolvedPath>": "<規劃時的來源指紋>" } }   SW-2：套用時比對，規劃後又有變更的來源延後
// names 與 targets 以來源為單位（同一個編碼資料夾可能拆成好幾個來源）；舊格式只寫 "<encoded>" 時套用到該編碼的所有來源。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ACTIONS = new Set(['copy', 'skip-same', 'rename', 'merge-candidate', 'superseded']);
const NO_COPY = new Set(['skip-same', 'superseded', 'skip']); // 與引擎 executeSweep 相同
const SCOPES = new Set(['project', 'global', 'machine']);

export const itemKey = (encoded, file) => `${encoded}/${file}`;

/** 驗證 edits，丟掉不認得的內容；回傳乾淨的 edits。 */
export function sanitizeEdits(edits) {
  const out = { items: {}, names: {}, targets: {}, revs: {} };
  for (const [k, v] of Object.entries(edits?.revs ?? {})) {
    if (k.includes('|') && typeof v === 'string' && /^([0-9a-f]{16}|missing)$/.test(v)) out.revs[k] = v;
  }
  for (const [k, v] of Object.entries(edits?.items ?? {})) {
    const e = {};
    if (v?.action && ACTIONS.has(v.action)) e.action = v.action;
    if (v?.scope && SCOPES.has(v.scope)) e.scope = v.scope;
    if (Object.keys(e).length) out.items[k] = e;
  }
  for (const [k, v] of Object.entries(edits?.names ?? {})) {
    const name = String(v ?? '').trim();
    if (name) out.names[k] = name.slice(0, 80);
  }
  for (const [k, v] of Object.entries(edits?.targets ?? {})) {
    if (typeof v?.pid === 'string' && /^[a-z0-9-]{3,64}$/.test(v.pid)) out.targets[k] = { pid: v.pid };
    else if (typeof v?.sameAs === 'string' && v.sameAs.includes('|')) out.targets[k] = { sameAs: v.sameAs };
    else if (typeof v?.path === 'string' && path.isAbsolute(v.path)) out.targets[k] = { path: path.normalize(v.path) };
  }
  return out;
}

/** 把調整套到計畫上（不改動原物件），並重算 totals。 */
export function applyEdits(plan, edits) {
  const e = sanitizeEdits(edits);
  const sources = plan.sources.map((s0) => {
    const k = sourceKey(s0);
    const s = retarget(s0, e.targets[k] ?? e.targets[s0.encoded]);
    const name = e.names[k] ?? e.names[s0.encoded];
    return {
      ...s,
      target: s.target.isNew && name ? { ...s.target, name } : s.target,
      items: s.items.map((it) => {
        const o = e.items[itemKey(s.encoded, it.file)];
        return o ? { ...it, ...o, edited: true } : it;
      }),
    };
  });
  return { ...plan, sources, totals: computeTotals(sources) };
}

/** 採用建議：連到既有專案（pid）、與同次匯入的另一個來源共用專案（sameAs），或改綁到找到的資料夾（path）。 */
function retarget(s, t) {
  if (!t) return s;
  if (t.pid) return { ...s, target: { ...s.target, pid: t.pid, isNew: false, archived: false, adopted: 'project' } };
  if (t.sameAs) return { ...s, target: { ...s.target, sameAs: t.sameAs, isNew: false, archived: false, adopted: 'source' } };
  return { ...s, resolvedPath: t.path, exists: true, how: 'suggested', target: { ...s.target, pid: null, name: path.basename(t.path), isNew: true, archived: false, adopted: 'path' } };
}

export function computeTotals(sources) {
  const t = { sources: sources.length, memories: 0, copy: 0, skip: 0, superseded: 0, global: 0, machine: 0, archived: 0, unknown: 0 };
  for (const s of sources) {
    // 與引擎相同：沒有任何記憶留在專案範圍的孤兒來源不會建立封存專案
    if (s.target.archived && s.items.some((it) => !NO_COPY.has(it.action) && (it.scope ?? 'project') === 'project')) t.archived++;
    if (s.how === 'unknown') t.unknown++;
    for (const it of s.items) {
      t.memories++;
      if (it.action === 'superseded') t.superseded++;
      if (it.action === 'skip-same' || it.action === 'superseded') { t.skip++; continue; }
      t.copy++;
      if (it.scope === 'global') t.global++;
      if (it.scope === 'machine') t.machine++;
    }
  }
  return t;
}

/** 對外顯示用：拿掉引擎內部欄位（例如 _srcDirs 含有本機路徑對照），並附上每個來源的指紋。 */
export function publicPlan(plan) {
  const { _srcDirs, ...rest } = plan;
  const revs = sourceRevs(plan);
  return { ...rest, sources: rest.sources.map((s) => ({ ...s, rev: revs[sourceKey(s)] })) };
}

// 與引擎的來源鍵相同（sweep.mjs）：同一個編碼資料夾可能對應多個來源（撞名）
const sourceKey = (s) => `${s.encoded}|${s.resolvedPath ?? ''}`;

/** 來源資料夾目前內容的指紋（不含 MEMORY.md 索引）：任何記憶新增、刪除或修改都會改變。 */
function dirRev(dir) {
  let names;
  try { names = fs.readdirSync(dir).filter((n) => /\.md$/i.test(n) && n.toUpperCase() !== 'MEMORY.MD').sort(); } catch { return 'missing'; }
  const h = createHash('sha1');
  for (const n of names) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, n), 'utf8'); } catch { /* 讀不到的檔案視為空內容，一樣會讓指紋改變 */ }
    h.update(`${n.toLowerCase()}\0${createHash('sha1').update(text).digest('hex')}\n`);
  }
  return h.digest('hex').slice(0, 16);
}

/** 引擎計畫（含 _srcDirs）中每個來源的指紋。 */
export function sourceRevs(plan) {
  const out = {};
  for (const s of plan.sources) {
    const dir = plan._srcDirs?.[sourceKey(s)];
    if (dir) out[sourceKey(s)] = dirRev(dir);
  }
  return out;
}

/**
 * SW-2：使用者審閱的是規劃當時的內容。套用時重新產生的計畫裡，指紋不同或規劃時不存在的來源，
 * 以及跟這些來源共用專案（sameAs）的來源，這次都不套用，列為 changed-since-plan，請使用者重新規劃。
 * 沒有 revs（例如 CLI 直接套用目前的計畫）時不比對。
 * @param raw 引擎剛產生的計畫；planned 套用 edits 後的計畫（與 raw.sources 一一對應）
 */
export function holdChanged(raw, planned, revs) {
  if (!revs || !Object.keys(revs).length) return { plan: planned, held: [] };
  const now = sourceRevs(raw);
  const heldKeys = new Set(raw.sources.map(sourceKey).filter((k) => !revs[k] || revs[k] !== now[k]));
  const held = new Set();
  planned.sources.forEach((s, i) => {
    if (heldKeys.has(sourceKey(raw.sources[i])) || heldKeys.has(s.target?.sameAs)) held.add(i);
  });
  const sources = planned.sources.filter((_, i) => !held.has(i));
  return {
    plan: { ...planned, sources, totals: computeTotals(sources) },
    held: [...held].map((i) => ({ path: raw.sources[i].resolvedPath ?? raw.sources[i].encoded, reason: 'changed-since-plan' })),
  };
}
