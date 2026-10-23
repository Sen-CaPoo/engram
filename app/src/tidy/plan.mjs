// 整理計畫 → 整理記錄。計畫由 /engram:tidy 的 Claude 寫成 JSON（修改後的內容放在同一個資料夾的 .md 檔），
// engram tidy create 在這裡逐項驗證：記憶存在、版本相符、內容格式完整、沒有多出遮蔽標記或新的疑似金鑰、
// 同一筆記憶只由一個項目處理。全部通過才建立記錄；錯誤一次列出，方便 Claude 一次修好。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { assertNoNewRedaction, checkMemoryText, isMemoryRef, redactText, revOf } from '../cli/commands/safe.mjs';
import { CliError } from '../cli/errors.mjs';
import { parseMemoryFile } from '../core/frontmatter.mjs';
import { memoryFileName } from '../core/ids.mjs';
import { MEMORY_TYPES, scopeOfRef } from '../core/memories.mjs';
import { allowEntries, assertNoNewSecrets, loadAllow } from '../core/secretallow.mjs';
import { newId, RECORD_VERSION, writeRecord } from './store.mjs';

export const CORE_REF = 'core/CORE.md';
export const ACTIONS = ['keep', 'update', 'move', 'archive', 'merge', 'create', 'split', 'promote'];
export const OPS = ['write', 'move', 'remove', 'merge', 'create', 'core'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MAX_ITEMS = 300;
const MAX_CONTENT = 256 * 1024;
const LIMIT = { summary: 1000, request: 4000, title: 120, reason: 4000, group: 40, highlight: 300 };

/**
 * 範圍參數：global、machine、machine:<mid>、project:<pid>（或只寫 pid）、core、all、記憶 ref。
 * 回傳 { kind, pid?, mid?, ref? }；看不懂時回傳 null。
 */
export function parseScopeArg(value, thisMid) {
  const s = String(value ?? '').trim();
  if (s === 'global' || s === 'core' || s === 'all') return { kind: s };
  if (s === 'machine') return { kind: 'machine', mid: thisMid };
  if (s.startsWith('machine:') && ID_RE.test(s.slice(8))) return { kind: 'machine', mid: s.slice(8) };
  if (s.startsWith('project:') && ID_RE.test(s.slice(8))) return { kind: 'project', pid: s.slice(8) };
  if (s === CORE_REF) return { kind: 'core' };
  if (isMemoryRef(s)) return { kind: 'memory', ref: s };
  if (ID_RE.test(s)) return { kind: 'project', pid: s };
  return null;
}

/** 搬移目標：global、machine、machine:<mid>、project:<pid> → 範圍物件 */
function parseTarget(value, thisMid) {
  const s = String(value ?? '');
  if (s === 'global') return { kind: 'global' };
  if (s === 'machine') return { kind: 'machine', mid: thisMid };
  if (s.startsWith('machine:') && ID_RE.test(s.slice(8))) return { kind: 'machine', mid: s.slice(8) };
  if (s.startsWith('project:') && ID_RE.test(s.slice(8))) return { kind: 'project', pid: s.slice(8) };
  return null;
}

const scopeKey = (sc) => (sc.kind === 'project' ? `project:${sc.pid}` : sc.kind === 'machine' ? `machine:${sc.mid}` : sc.kind);
const refDir = (sc) => (sc.kind === 'global' ? 'global' : sc.kind === 'project' ? `projects/${sc.pid}/memory` : `machines/${sc.mid}`);
const str = (v) => (typeof v === 'string' ? v : '');

/** 驗證時共用的查詢：目前的內容、專案、電腦 */
async function lookups(eg) {
  const raws = new Map();
  const projects = new Set((await eg.projects.list()).map((p) => p.pid));
  return {
    mid: eg.machine.id,
    projects,
    machineExists: (mid) => mid === eg.machine.id || fs.existsSync(path.join(eg.paths.vault, 'machines', mid)),
    async raw(ref) {
      if (!raws.has(ref)) {
        if (ref === CORE_REF) raws.set(ref, (await eg.core.read()).text ?? '');
        else {
          try { raws.set(ref, (await eg.memories.read(ref)).raw); } catch (err) {
            if (err?.code !== 'E_NOT_FOUND') throw err;
            raws.set(ref, null);
          }
        }
      }
      return raws.get(ref);
    },
    /** 給介面顯示的目前內容：疑似金鑰在本機遮蔽（使用者標記「不是金鑰」的除外） */
    async shown(ref) {
      if (ref === CORE_REF) return redactText((await eg.core.read()).text ?? '', allowEntries(await loadAllow(eg.paths.local), CORE_REF));
      return (await eg.secrets.preview(ref)).after;
    },
  };
}

/**
 * 讀計畫檔、驗證、建立整理記錄。成功後，草稿資料夾（~/.engram/local/drafts）裡的計畫與內容檔刪除。
 * @returns {Promise<object>} 新建立的記錄
 */
export async function createFromPlan(eg, file, { now = new Date() } = {}) {
  const planPath = path.resolve(file);
  let text;
  try { text = await fsp.readFile(planPath, 'utf8'); } catch {
    throw new CliError('E_NOT_FOUND', `讀不到整理計畫：${planPath}`, '計畫請寫在 ~/.engram/local/drafts/ 底下，修改後的內容放在同一個資料夾');
  }
  let plan;
  try { plan = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (err) {
    throw new CliError('E_INVALID', `整理計畫不是有效的 JSON：${err.message}`, '修正 JSON 格式（字串裡的換行寫成 \\n、引號要跳脫）後再試；長內容請放在 .md 檔，用 file 指過去');
  }
  const L = await lookups(eg);
  const errs = [];
  const used = new Set([planPath]);
  const planDir = path.dirname(planPath);

  const readContent = async (rel, where) => {
    if (typeof rel !== 'string' || !rel.trim()) { errs.push(`${where}：缺少 file（修改後內容的檔名）`); return null; }
    const abs = path.resolve(planDir, rel);
    const inside = path.relative(planDir, abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) { errs.push(`${where}：file 要放在計畫檔的同一個資料夾（或子資料夾）：${rel}`); return null; }
    let body;
    try { body = await fsp.readFile(abs, 'utf8'); } catch { errs.push(`${where}：讀不到 ${rel}`); return null; }
    if (Buffer.byteLength(body) > MAX_CONTENT) { errs.push(`${where}：${rel} 超過 256 KB`); return null; }
    used.add(abs);
    return body.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  };
  const tryCheck = (fn, where) => { try { fn(); return true; } catch (err) { errs.push(`${where}：${err.message}`); return false; } };
  const tooLong = (v, max, where, field) => { if (v.length > max) errs.push(`${where}：${field} 太長（上限 ${max} 字）`); };

  // ── 最上層 ──
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new CliError('E_INVALID', '整理計畫要是一個 JSON 物件');
  const scope = parseScopeArg(plan.scope, L.mid);
  if (!scope) errs.push(`scope 看不懂：${String(plan.scope ?? '').slice(0, 80)}（可用 global、machine、project:<pid>、core、all 或記憶 ref）`);
  else if (scope.kind === 'project' && !L.projects.has(scope.pid)) errs.push(`scope 看不懂或沒有這個專案：${scope.pid}（可用 global、machine、project:<pid>、core、all 或記憶 ref；engram projects 可以列出 pid）`);
  const summary = str(plan.summary).trim();
  if (!summary) errs.push('缺少 summary（一兩句整體結論）');
  tooLong(summary, LIMIT.summary, 'summary', '內容');
  const request = str(plan.request).trim();
  tooLong(request, LIMIT.request, 'request', '內容');
  const highlights = Array.isArray(plan.highlights) ? plan.highlights.filter((h) => typeof h === 'string' && h.trim()).map((h) => h.trim()) : [];
  if (highlights.length > 8) errs.push('highlights 最多 8 點');
  highlights.forEach((h, i) => tooLong(h, LIMIT.highlight, `highlights[${i}]`, '內容'));
  if (!Array.isArray(plan.items) || !plan.items.length) errs.push('items 至少要有一項');
  if (Array.isArray(plan.items) && plan.items.length > MAX_ITEMS) errs.push(`items 最多 ${MAX_ITEMS} 項；範圍很大時只列有建議的記憶，其餘放 kept`);

  // ── 每一項 ──
  const items = [];
  const touchedBy = new Map(); // ref → 項目序號（同一筆記憶只能由一個項目修改）
  const subjects = new Map();
  for (const [i, raw] of (Array.isArray(plan.items) ? plan.items.slice(0, MAX_ITEMS) : []).entries()) {
    const n = i + 1;
    const where0 = `第 ${n} 項`;
    if (!raw || typeof raw !== 'object') { errs.push(`${where0}：要是物件`); continue; }
    const ref = raw.ref == null || raw.ref === '' ? null : String(raw.ref);
    const where = ref ? `${where0}（${ref}）` : where0;
    if (ref && ref !== CORE_REF && !isMemoryRef(ref)) { errs.push(`${where}：ref 不是記憶檔`); continue; }
    if (ref && (await L.raw(ref)) === null) { errs.push(`${where}：記憶不存在（engram memory list 可以列出所有 ref）`); continue; }
    const action = String(raw.action ?? '');
    if (!ACTIONS.includes(action)) errs.push(`${where}：action 要是 ${ACTIONS.join('、')} 其中之一`);
    const title = str(raw.title).trim();
    const reason = str(raw.reason).trim();
    const group = str(raw.group).trim();
    if (!title) errs.push(`${where}：缺少 title（一句話的建議）`);
    if (!reason) errs.push(`${where}：缺少 reason（理由）`);
    tooLong(title, LIMIT.title, where, 'title');
    tooLong(reason, LIMIT.reason, where, 'reason');
    tooLong(group, LIMIT.group, where, 'group');
    const rawOps = Array.isArray(raw.ops) ? raw.ops : [];
    if (action === 'keep' && rawOps.length) errs.push(`${where}：建議保留（keep）的項目不能有 ops`);
    if (action && action !== 'keep' && !rawOps.length) errs.push(`${where}：action 不是 keep 時要有 ops`);
    if (!ref && !rawOps.some((o) => o?.op === 'create')) errs.push(`${where}：沒有 ref 的項目只能是新增記憶（ops 裡要有 create）`);
    if (ref) {
      if (subjects.has(ref)) errs.push(`${where}：同一筆記憶出現在第 ${subjects.get(ref)} 項與第 ${n} 項，請合成一項`);
      subjects.set(ref, n);
    }

    const ops = [];
    const firstTouch = new Set();
    const gone = new Set();
    const touch = (r, opWhere) => {
      if (gone.has(r)) { errs.push(`${opWhere}：${r} 在前一個動作已被搬走或合併，不能再處理`); return false; }
      const owner = touchedBy.get(r);
      if (owner !== undefined && owner !== n) { errs.push(`${opWhere}：${r} 已經由第 ${owner} 項處理；同一筆記憶只能由一個項目修改`); return false; }
      touchedBy.set(r, n);
      const first = !firstTouch.has(r);
      firstTouch.add(r);
      return first;
    };
    /**
     * 第一次處理這筆記憶時一定要帶讀取時的版本（engram memory show 印出的），對不上就是讀取之後被改過；
     * 同一項裡之後的動作接續自己的修改，不再比對。
     */
    const baseFor = async (r, given, first, opWhere) => {
      if (!first) return undefined;
      const rev = revOf(await L.raw(r));
      if (given === undefined || given === null || given === '') errs.push(`${opWhere}：缺少 ${r} 的 base（engram memory show 印出的版本）；第一次處理一筆記憶時一定要帶`);
      else if (String(given) !== rev) errs.push(`${opWhere}：${r} 在你讀取之後被修改過（版本 ${given} → ${rev}），請重新讀取後再寫計畫`);
      return rev;
    };
    const pinned = async (r) => parseMemoryFile(await L.raw(r)).data?.metadata?.engram?.pinned === true;

    for (const [j, o] of rawOps.entries()) {
      const ow = `${where} ops[${j}]`;
      if (!o || typeof o !== 'object' || !OPS.includes(o.op)) { errs.push(`${ow}：op 要是 ${OPS.join('、')} 其中之一`); continue; }
      if (o.op === 'write') {
        const r = String(o.ref ?? '');
        if (!isMemoryRef(r) || (await L.raw(r)) === null) { errs.push(`${ow}：write 的 ref 不存在或不是記憶檔：${r}`); continue; }
        const first = touch(r, ow);
        const base = await baseFor(r, o.base, first, ow);
        const content = await readContent(o.file, ow);
        if (content === null) continue;
        const cur = await L.raw(r);
        if (!tryCheck(() => checkMemoryText(content), ow)) continue;
        const name = String(parseMemoryFile(content).data?.name ?? '');
        const curName = String(parseMemoryFile(cur).data?.name ?? '');
        if (name !== path.posix.basename(r, '.md') && name !== curName) errs.push(`${ow}：frontmatter 的 name（${name}）要與檔名 ${path.posix.basename(r, '.md')} 相同`);
        tryCheck(() => assertNoNewRedaction(content, [cur]), ow);
        if ((await pinned(r)) && parseMemoryFile(content).data?.metadata?.engram?.pinned !== true) errs.push(`${ow}：${r} 是使用者釘選的記憶，改寫時要保留 metadata.engram.pinned: true`);
        if (first && content === cur.replace(/\r\n/g, '\n')) errs.push(`${ow}：內容和目前完全相同；不用改的話，這項改成 keep`);
        await secretCheck(eg, r, content, cur, ow, errs);
        ops.push({ op: 'write', ref: r, ...(base ? { base } : {}), content });
      } else if (o.op === 'move') {
        const r = String(o.ref ?? '');
        if (!isMemoryRef(r) || (await L.raw(r)) === null) { errs.push(`${ow}：move 的 ref 不存在或不是記憶檔：${r}`); continue; }
        const to = parseTarget(o.to, L.mid);
        if (!to) { errs.push(`${ow}：to 要是 global、machine、machine:<mid> 或 project:<pid>`); continue; }
        if (to.kind === 'project' && !L.projects.has(to.pid)) { errs.push(`${ow}：沒有這個專案 ${to.pid}`); continue; }
        if (to.kind === 'machine' && !L.machineExists(to.mid)) { errs.push(`${ow}：沒有這台電腦 ${to.mid}`); continue; }
        if (scopeKey(scopeOfRef(r)) === scopeKey(to)) { errs.push(`${ow}：${r} 已經在這個範圍`); continue; }
        const dest = `${refDir(to)}/${path.posix.basename(r)}`;
        if ((await L.raw(dest)) !== null || touchedBy.has(dest)) { errs.push(`${ow}：${scopeKey(to)} 已經有同名的 ${path.posix.basename(r)}（或這份計畫要在那裡新增同名記憶），搬過去會被改名；請改用合併`); continue; }
        const first = touch(r, ow);
        const base = await baseFor(r, o.base, first, ow);
        touch(dest, ow);
        gone.add(r);
        ops.push({ op: 'move', ref: r, ...(base ? { base } : {}), to: scopeKey(to), dest });
      } else if (o.op === 'remove') {
        const r = String(o.ref ?? '');
        if (!isMemoryRef(r) || (await L.raw(r)) === null) { errs.push(`${ow}：remove 的 ref 不存在或不是記憶檔：${r}`); continue; }
        if (await pinned(r)) { errs.push(`${ow}：${r} 是使用者釘選的記憶，不要建議封存`); continue; }
        const first = touch(r, ow);
        const base = await baseFor(r, o.base, first, ow);
        gone.add(r);
        ops.push({ op: 'remove', ref: r, ...(base ? { base } : {}) });
      } else if (o.op === 'merge') {
        const refs = Array.isArray(o.refs) ? o.refs.map(String) : [];
        if (refs.length < 2 || new Set(refs).size !== refs.length) { errs.push(`${ow}：merge 的 refs 至少要兩筆不重複的記憶`); continue; }
        let ok = true;
        for (const r of refs) if (!isMemoryRef(r) || (await L.raw(r)) === null) { errs.push(`${ow}：${r} 不存在或不是記憶檔`); ok = false; }
        if (!ok) continue;
        const into = o.into == null ? refs[0] : String(o.into);
        if (!refs.includes(into)) { errs.push(`${ow}：into 要是 refs 其中一筆`); continue; }
        let pinnedOther = false;
        for (const r of refs) if (r !== into && (await pinned(r))) { errs.push(`${ow}：${r} 是使用者釘選的記憶，不要建議合併掉（可以當成 into）`); pinnedOther = true; }
        if (pinnedOther) continue;
        const given = Array.isArray(o.bases) ? o.bases : [];
        if (given.length !== refs.length) errs.push(`${ow}：bases 要依序給 ${refs.length} 個版本（engram memory show 印出的）`);
        const bases = [];
        for (const [k, r] of refs.entries()) bases.push(await baseFor(r, given[k] ?? '', touch(r, ow), ow) ?? null);
        const content = await readContent(o.file, ow);
        if (content === null) continue;
        const originals = [];
        for (const r of refs) originals.push(await L.raw(r));
        // 開頭是 --- 卻解析不出 frontmatter（例如少了結尾那行）也要擋：照寫會把半截 frontmatter 留在內文
        if (parseMemoryFile(content).hasFrontmatter || /^---\s*$/.test(content.split('\n')[0])) {
          if (!tryCheck(() => checkMemoryText(content), ow)) continue;
          const name = String(parseMemoryFile(content).data?.name ?? '');
          const intoName = String(parseMemoryFile(await L.raw(into)).data?.name ?? '');
          if (name !== path.posix.basename(into, '.md') && name !== intoName) errs.push(`${ow}：frontmatter 的 name（${name}）要與 into 的檔名 ${path.posix.basename(into, '.md')} 相同`);
          if ((await pinned(into)) && parseMemoryFile(content).data?.metadata?.engram?.pinned !== true) errs.push(`${ow}：${into} 是使用者釘選的記憶，合併後的內容要保留 metadata.engram.pinned: true`);
        }
        tryCheck(() => assertNoNewRedaction(content, originals), ow);
        await secretCheck(eg, into, content, originals.join('\n'), ow, errs);
        for (const r of refs) gone.add(r);
        ops.push({ op: 'merge', refs, into, bases, content });
      } else if (o.op === 'create') {
        const to = parseTarget(o.scope, L.mid);
        if (!to || (to.kind === 'machine' && to.mid !== L.mid)) { errs.push(`${ow}：scope 要是 global、machine（這台電腦）或 project:<pid>`); continue; }
        if (to.kind === 'project' && !L.projects.has(to.pid)) { errs.push(`${ow}：沒有這個專案 ${to.pid}`); continue; }
        const content = await readContent(o.file, ow);
        if (content === null) continue;
        if (!tryCheck(() => checkMemoryText(content), ow)) continue;
        const p = parseMemoryFile(content);
        const name = String(p.data.name ?? '');
        const type = String(p.data.metadata?.type ?? '');
        if (!NAME_RE.test(name) || memoryFileName(name) !== `${name}.md`) { errs.push(`${ow}：name 要是 kebab-case 英數（例如 client-proposal-wording）：${name}`); continue; }
        if (!MEMORY_TYPES.includes(type)) { errs.push(`${ow}：metadata.type 要是 ${MEMORY_TYPES.join('、')} 其中之一`); continue; }
        const target = `${refDir(to)}/${name}.md`;
        if ((await L.raw(target)) !== null) { errs.push(`${ow}：${target} 已經存在；要改既有的記憶請用 write`); continue; }
        if (touchedBy.has(target)) { errs.push(`${ow}：這份計畫已經要在 ${target} 新增或搬入記憶，名稱重複`); continue; }
        touch(target, ow);
        tryCheck(() => assertNoNewRedaction(content, []), ow);
        await secretCheck(eg, target, content, null, ow, errs);
        ops.push({ op: 'create', scope: scopeKey(to), ref: target, name, type, description: String(p.data.description).trim(), body: p.body.trim(), content });
      } else if (o.op === 'core') {
        const first = touch(CORE_REF, ow);
        const base = await baseFor(CORE_REF, o.base, first, ow);
        const content = await readContent(o.file, ow);
        if (content === null) continue;
        const cur = await L.raw(CORE_REF);
        tryCheck(() => assertNoNewRedaction(content, [cur]), ow);
        const env = cur.match(/<!-- engram:environments:begin -->[\s\S]*?<!-- engram:environments:end -->/);
        if (env && !content.includes(env[0])) errs.push(`${ow}：<!-- engram:environments:begin --> 到 end 的區塊由 Engram 維護，要原樣保留`);
        const imp = cur.split('\n').find((l) => /^@\S*INDEX\.md\s*$/.test(l.trim()));
        if (imp && !content.split('\n').some((l) => l.trim() === imp.trim())) errs.push(`${ow}：引用全域索引的那一行（${imp.trim()}）要保留`);
        if (content === cur.replace(/\r\n/g, '\n')) errs.push(`${ow}：內容和目前的核心準則完全相同`);
        await secretCheck(eg, CORE_REF, content, cur, ow, errs);
        ops.push({ op: 'core', ref: CORE_REF, ...(base ? { base } : {}), content });
      }
    }

    // 顯示用的名稱、範圍與類型：有對象記憶時取目前的內容；只有新增時取新內容
    const created = ops.find((o) => o.op === 'create');
    const curText = ref ? await L.raw(ref) : null;
    const fm = curText ? parseMemoryFile(curText).data ?? {} : {};
    items.push({
      id: `i${n}`,
      ref,
      name: ref === CORE_REF ? 'CORE.md' : ref ? path.posix.basename(ref, '.md') : created?.name ?? `item-${n}`,
      scope: ref === CORE_REF ? 'core' : ref ? scopeKey(scopeOfRef(ref)) : created?.scope ?? null,
      type: ref ? String(fm.metadata?.type ?? '') || null : created?.type ?? null,
      description: redactText(ref ? String(fm.description ?? '') : created?.description ?? ''),
      group: group || null,
      action,
      title,
      reason,
      base: curText !== null && curText !== undefined ? revOf(curText) : null,
      ops,
      decision: null,
      note: '',
      result: null,
    });
  }

  // 同一筆記憶不能一邊是某一項的主角、一邊被另一項修改
  for (const [ref, n] of subjects) {
    const owner = touchedBy.get(ref);
    if (owner !== undefined && owner !== n) errs.push(`第 ${n} 項（${ref}）也被第 ${owner} 項修改；請合成一項`);
  }
  const kept = [];
  for (const r of Array.isArray(plan.kept) ? plan.kept.map(String) : []) {
    if (kept.includes(r)) continue;
    if (!isMemoryRef(r) || (await L.raw(r)) === null) { errs.push(`kept：${r} 不存在或不是記憶檔`); continue; }
    if (subjects.has(r) || touchedBy.has(r)) { errs.push(`kept：${r} 已經列在 items，不用再放 kept`); continue; }
    kept.push(r);
  }

  if (errs.length) {
    const shown = errs.slice(0, 25);
    throw new CliError('E_INVALID', `整理計畫有 ${errs.length} 個問題：\n${shown.map((e) => `• ${e}`).join('\n')}${errs.length > shown.length ? `\n…另外還有 ${errs.length - shown.length} 個` : ''}`, '修正計畫檔後再執行 engram tidy create；記錄還沒有建立');
  }

  // 建議當時的內容（遮蔽後）：介面用來顯示「目前內容」與差異比對；執行之後也看得到當初比對的是什麼
  const texts = {};
  for (const ref of new Set([...subjects.keys(), ...touchedBy.keys()])) {
    if ((await L.raw(ref)) !== null) texts[ref] = await L.shown(ref);
  }

  const rec = {
    v: RECORD_VERSION,
    id: newId(now),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    machine: L.mid,
    scope: scope.kind === 'memory' ? scope.ref : scope.kind === 'core' ? 'core' : scope.kind === 'all' ? 'all' : scopeKey(scope),
    request,
    summary,
    highlights,
    status: 'pending',
    items,
    kept,
    texts,
  };
  await writeRecord(eg.paths.local, rec);

  // 草稿資料夾裡的計畫與內容檔用完即刪；其他位置的檔案不動
  const drafts = path.join(eg.paths.local, 'drafts');
  const inDrafts = (f) => { const rel = path.relative(drafts, f); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
  for (const f of used) if (inDrafts(f)) await fsp.rm(f, { force: true }).catch(() => {});
  // 計畫自己的資料夾（例如 drafts/tidy-global）清空了就一併移除；還有別的檔案就留著
  if (inDrafts(planDir)) await fsp.rmdir(planDir).catch(() => {});
  return rec;
}

/** 新的內容多出疑似金鑰：先擋下（執行時引擎也會擋，提早說比較好修） */
async function secretCheck(eg, ref, content, before, where, errs) {
  try {
    await assertNoNewSecrets(eg.paths.local, ref, content, { before, allowSecrets: false });
  } catch (err) {
    if (err?.code !== 'E_SECRET') throw err;
    errs.push(`${where}：${err.message}；記憶裡只記金鑰放在哪裡、怎麼取得`);
  }
}
