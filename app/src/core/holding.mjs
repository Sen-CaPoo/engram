// 保留區（2.0.0）：自動駕駛沒有執行的提案，連同完整的動作、內容與證據保存下來，之後由使用者採用或忽略，
// 自動駕駛也會在之後的一輪重新審核（tasks/holding.mjs）。來源：
// - rejected：審核員不同意、護欄擋下（screen 拒絕而且不是延後）
// - cross-scope：這台電腦這一輪不能處理的範圍（例如對話回顧發現別的專案的事、離線時想動共用記憶）
// - reverted：待你確認退回之前，被退回的那個版本
// 位置：一般的項目在 vault/holding/<id>.json（同步，交給既有的 commit 流程）；內容疑似含金鑰的放 local/autopilot/holding/<id>.json
// （只留在這台電腦）。同步的密鑰關卡只掃 Markdown，所以寫進 vault 之前在這裡逐欄位檢查。
// 帶對話證據的項目（對話回顧的引句與前後的對話）、以及所有來自對話回顧的項目（理由常引用對話原句）也只放本機：
// 產品決定「不同步對話原文」。
// 對外的 list／get 會在本機遮蔽疑似金鑰（CLI 的輸出可能交給 Claude）；採用與內部處理用原文。
// 保留區不是記憶：不進索引、搜尋、健康檢查，也不會被自動駕駛整理（記憶的掃描只看 global、projects、machines 的 .md）。
// 同一個提案（任務、專案、每個動作的種類、目標與內容）已經在保留中時，更新那一項、不另存一份（審查 F6）。
// 兩台同時改同一項的同步衝突由 mergeHoldingJson 決定（審查 F8：已採用或已忽略優先、同為保留中取較新的）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { E, EngramError, invariant } from './errors.mjs';
import { readJson, readText, safeWrite, writeJson } from './fsx.mjs';
import { markReviewed } from './review.mjs';
import { allowEntries, assertNoNewSecrets, loadAllow, scanWithAllow } from './secretallow.mjs';
import { redactSecrets } from './secrets.mjs';
import { commitPaths } from './vault.mjs';

export const HOLDING_DIR = 'holding';
export const HOLDING_ID_RE = /^hd-\d{8}-\d{6}-[a-z0-9]{4}$/;
export const HOLDING_KINDS = ['rejected', 'reverted', 'cross-scope'];
export const HOLDING_STATUSES = ['held', 'adopted', 'dismissed'];
// guardrail、env、graduate：記憶畢業（2.0.0 WP9）的提案；採用時交給記憶畢業的流程，不是整理計畫
const OPS = ['write', 'move', 'remove', 'merge', 'create', 'core', 'verify', 'guardrail', 'env', 'graduate'];
const GRADUATE_TO = ['core', 'guardrail', 'env', 'archive'];
const MAX_OPS = 6;
const MAX_EVIDENCE = 6;
const MAX_CONTENT = 256 * 1024;

const pad = (n) => String(n).padStart(2, '0');
export function newHoldingId(now = new Date()) {
  const d = now;
  const tail = [...randomBytes(4)].map((b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  return `hd-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${tail}`;
}

const rel = (id) => `${HOLDING_DIR}/${id}.json`;
const vaultFile = (ctx, id) => path.join(ctx.vault, HOLDING_DIR, `${id}.json`);
const localFile = (ctx, id) => path.join(ctx.local, 'autopilot', HOLDING_DIR, `${id}.json`);

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const optStr = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);

function normalizeOp(o) {
  if (!o || typeof o !== 'object' || !OPS.includes(o.op)) return null;
  const out = { op: o.op };
  for (const k of ['ref', 'scope', 'to', 'into']) if (typeof o[k] === 'string' && o[k]) out[k] = o[k].slice(0, 300);
  if (typeof o.base === 'string' && o.base) out.base = o.base.slice(0, 40);
  if (Array.isArray(o.refs)) out.refs = o.refs.filter((r) => typeof r === 'string').map((r) => r.slice(0, 300)).slice(0, 10);
  if (Array.isArray(o.bases)) out.bases = o.bases.map((b) => (typeof b === 'string' && b ? b.slice(0, 40) : null)).slice(0, 10);
  if (typeof o.content === 'string') out.content = o.content.slice(0, MAX_CONTENT);
  return out;
}

function normalizeEvidence(e) {
  const quote = str(e?.quote, 600).trim();
  if (!quote) return null;
  return { quote, ...(optStr(e.session, 80) ? { session: optStr(e.session, 80) } : {}), ...(optStr(e.date, 10) ? { date: optStr(e.date, 10) } : {}), fromUser: e.fromUser === true, ...(optStr(e.context, 4000) ? { context: optStr(e.context, 4000) } : {}) };
}

/**
 * 記憶畢業的提案（2.0.0 WP9）：{ to, ref, sha, title?, line?（核心準則的一行）, rule?（護欄規則）, env?（{ area, key, value }）}。
 * 格式不對時整個不留（採用時就不會照它執行）。
 */
function normalizeGraduate(g) {
  if (!g || typeof g !== 'object' || !GRADUATE_TO.includes(g.to) || typeof g.ref !== 'string' || !g.ref) return null;
  const out = { to: g.to, ref: g.ref.slice(0, 300), ...(optStr(g.sha, 40) ? { sha: optStr(g.sha, 40) } : {}), ...(optStr(g.title, 120) ? { title: optStr(g.title, 120) } : {}) };
  // 第四輪審查 F-03：核心準則的那一行要是一行（同步來的保留區檔可能被改成多行，會在 CORE.md 插入匯入或標題）
  // 第五輪審查 N-4：句子中間的 @路徑 在 CORE.md 裡也是匯入語法，一樣不收
  if (g.to === 'core') { if (!optStr(g.line, 300) || /[\r\n]/.test(g.line) || /(^|\s)@\S/.test(g.line)) return null; out.line = optStr(g.line, 300); }
  if (g.to === 'guardrail') {
    const r = g.rule;
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || typeof r.pattern !== 'string' || typeof r.message !== 'string') return null;
    out.rule = Object.fromEntries(['id', 'tool', 'pattern', 'flags', 'unless', 'message', 'source', 'addedAt', 'by'].map((k) => [k, str(r[k], 400)]));
    out.rule.action = 'hint';
  }
  if (g.to === 'env') {
    const e = g.env;
    if (!e || typeof e !== 'object' || !['env', 'setting'].includes(e.area) || typeof e.key !== 'string') return null;
    out.env = { area: e.area, key: e.key.slice(0, 128), value: typeof e.value === 'number' ? e.value : str(e.value, 2000) };
  }
  return out;
}

/** 只留認得的欄位、限制長度（同步來的檔案也一樣處理） */
function normalize(x) {
  const at = typeof x.at === 'string' && Number.isFinite(Date.parse(x.at)) ? x.at : new Date().toISOString();
  return {
    v: 1,
    id: x.id,
    at,
    machine: str(x.machine, 64),
    ...(optStr(x.run, 40) ? { run: optStr(x.run, 40) } : {}),
    task: str(x.task, 20),
    pid: optStr(x.pid, 64),
    kind: HOLDING_KINDS.includes(x.kind) ? x.kind : 'rejected',
    ref: optStr(x.ref, 300),
    title: str(x.title, 120) || '（沒有標題）',
    reason: str(x.reason, 4000),
    why: str(x.why, 1000),
    action: str(x.action, 20) || 'update',
    category: str(x.category, 40),
    risk: str(x.risk, 10),
    scope: optStr(x.scope, 80),
    flags: Array.isArray(x.flags) ? x.flags.filter((f) => typeof f === 'string').map((f) => f.slice(0, 60)).slice(0, 10) : [],
    // 2.0.0 Q4：審核員認為核心事實有依據、細節沒有依據（trim）；keep 是有依據的部分
    ...(x.grounded === true ? { grounded: true, keep: Array.isArray(x.keep) ? x.keep.filter((k) => typeof k === 'string').map((k) => k.slice(0, 300)).slice(0, 10) : [] } : {}),
    ...(normalizeGraduate(x.graduate) ? { graduate: normalizeGraduate(x.graduate) } : {}),
    ops: (Array.isArray(x.ops) ? x.ops : []).map(normalizeOp).filter(Boolean).slice(0, MAX_OPS),
    evidence: (Array.isArray(x.evidence) ? x.evidence : []).map(normalizeEvidence).filter(Boolean).slice(0, MAX_EVIDENCE),
    attempts: Number.isInteger(x.attempts) && x.attempts > 0 ? Math.min(x.attempts, 99) : 0,
    // 重審時審核連續幾輪沒有完成（2.0.0；到上限就不再自動重審）
    ...(Number.isInteger(x.incomplete) && x.incomplete > 0 ? { incomplete: Math.min(x.incomplete, 99) } : {}),
    status: HOLDING_STATUSES.includes(x.status) ? x.status : 'held',
    lastReviewAt: optStr(x.lastReviewAt, 40),
    ...(optStr(x.record, 40) ? { record: optStr(x.record, 40) } : {}),
    // 自動駕駛重審時建立的整理記錄裡，對應這一項的項目編號（中斷後下一輪認得是自己寫入的）
    ...(optStr(x.recordItem, 40) ? { recordItem: optStr(x.recordItem, 40) } : {}),
    ...(optStr(x.adoptedAt, 40) ? { adoptedAt: optStr(x.adoptedAt, 40) } : {}),
    ...(optStr(x.dismissedAt, 40) ? { dismissedAt: optStr(x.dismissedAt, 40) } : {}),
  };
}

/** 項目裡所有的文字（內容、證據與上下文、標題、理由…）有沒有疑似金鑰。逐欄位掃，不掃 JSON 字串（跳脫後的換行會讓多行的金鑰認不出來） */
async function hasSecrets(ctx, item) {
  const allow = await loadAllow(ctx.local);
  const texts = [];
  const walk = (v) => { if (typeof v === 'string') texts.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(item);
  return texts.some((t) => scanWithAllow(t, null, allow).length > 0);
}

/**
 * 存檔：沒有疑似金鑰、沒有對話證據、也不是對話回顧的提案 → vault（commit）；否則 → local（vault 裡原本有就刪掉並 commit）。
 * 對話證據是對話原文（引句與前後的對話）：依產品決定不同步。對話回顧的提案即使沒有證據，理由也常引用對話原句（審查 F5）。
 * 重審只由建立它的電腦做，所以只留在本機不影響重審
 */
async function save(ctx, item, subject) {
  const local = item.task === 'dream' || item.evidence.length > 0 || (await hasSecrets(ctx, item));
  return ctx.locked('holding', async () => {
    const vf = vaultFile(ctx, item.id);
    const lf = localFile(ctx, item.id);
    if (local) {
      await fsp.mkdir(path.dirname(lf), { recursive: true });
      await writeJson(lf, item);
      if (fs.existsSync(vf)) {
        await fsp.rm(vf, { force: true });
        await commitPaths(ctx.vault, [rel(item.id)], `${subject}（移到本機）`, { action: 'autopilot', mid: ctx.mid }).catch(() => null);
      }
    } else {
      await fsp.mkdir(path.dirname(vf), { recursive: true });
      await writeJson(vf, item);
      await commitPaths(ctx.vault, [rel(item.id)], subject, { action: 'autopilot', mid: ctx.mid }).catch(() => null);
      if (fs.existsSync(lf)) await fsp.rm(lf, { force: true });
    }
    return { local };
  });
}

/** 對外顯示用：疑似金鑰在本機遮蔽（「不是金鑰」清單的不遮），另外標出有沒有疑似金鑰（secret） */
async function shown(ctx, items) {
  const allow = await loadAllow(ctx.local);
  const ok = allowEntries(allow, null);
  const red = (t) => (typeof t === 'string' ? redactSecrets(t, ok).text : t);
  const out = [];
  for (const x of items) {
    out.push({
      ...x,
      title: red(x.title), reason: red(x.reason), why: red(x.why),
      ops: x.ops.map((o) => (typeof o.content === 'string' ? { ...o, content: red(o.content) } : o)),
      evidence: x.evidence.map((e) => ({ ...e, quote: red(e.quote), ...(e.context ? { context: red(e.context) } : {}) })),
      ...(x.graduate ? { graduate: { ...x.graduate, ...(x.graduate.line ? { line: red(x.graduate.line) } : {}), ...(x.graduate.rule ? { rule: Object.fromEntries(Object.entries(x.graduate.rule).map(([k, v]) => [k, red(v)])) } : {}), ...(x.graduate.env ? { env: { ...x.graduate.env, value: red(x.graduate.env.value) } } : {}) } } : {}),
      secret: await hasSecrets(ctx, x),
    });
  }
  return out;
}

function notFound(id) {
  return new EngramError(E.NOT_FOUND, `保留區沒有這一項：${String(id).slice(0, 60)}`, 'engram holding list 可以列出保留區的項目').withEn(`No such item in the holding area: ${String(id).slice(0, 60)}`, 'engram holding list lists the items in the holding area');
}

/**
 * 記憶庫裡（同步來的）的項目：證據一律當成沒有使用者原話、不帶對話脈絡（第四輪審查 F-09）。
 * fromUser、context 是這台的程式比對對話得出、只存在本機檔的；同步檔裡的這兩個欄位任何一台都能寫，不能當成程式驗證過的事實。
 */
const fromVault = (item) => ({ ...item, evidence: item.evidence.map(({ context, ...e }) => ({ ...e, fromUser: false })) });

/** 讀一項（本機的優先）：{ ...item, local } */
async function load(ctx, id) {
  if (!HOLDING_ID_RE.test(String(id ?? ''))) throw notFound(id);
  const l = await readJson(localFile(ctx, id), null);
  if (l && typeof l === 'object') return { ...normalize({ ...l, id }), local: true };
  const v = await readJson(vaultFile(ctx, id), null);
  if (v && typeof v === 'object') return { ...fromVault(normalize({ ...v, id })), local: false };
  throw notFound(id);
}

const sha1 = (t) => createHash('sha1').update(String(t)).digest('hex');

/**
 * 提案內容的指紋（2.0.0 第二輪審查 R6）：每個動作的種類、目標與內容雜湊，不看任務、專案與版本。
 * 用來認出使用者標成「不需要」的同一個提案（不論之後由哪個任務再提出）。ops 是自動駕駛的動作或保留區項目的動作：
 * 新增到「這台電腦」（scope: machine）換成 machine:<mid>、合併的目標省略時是第一筆，內容統一換行與結尾。
 */
export function opsFingerprint(ops, mid = '') {
  const content = (c) => (typeof c === 'string' ? sha1(c.replace(/\r\n/g, '\n').replace(/\n*$/, '\n')) : null);
  return sha1(JSON.stringify((Array.isArray(ops) ? ops : []).map((o) => [
    o.op, o.ref ?? null, o.scope === 'machine' ? `machine:${mid}` : o.scope ?? null, o.to ?? null,
    o.op === 'merge' ? o.into ?? o.refs?.[0] ?? null : o.into ?? null, o.refs ?? null, content(o.content),
  ])));
}

/** 使用者標成「不需要」的提案在這麼多天內再被提出時略過（第二輪審查 R6） */
export const DISMISSED_DAYS = 90;
const recentlyDismissed = (x, now) => x.status === 'dismissed' && now - (Date.parse(x.dismissedAt ?? x.at) || 0) <= DISMISSED_DAYS * 86_400_000;

/** 90 天內使用者標成「不需要」的提案指紋（opsFingerprint） */
export async function dismissedFingerprints(ctx, { now = Date.now() } = {}) {
  return new Set((await listRaw(ctx, { status: 'dismissed' })).filter((x) => recentlyDismissed(x, now)).map((x) => opsFingerprint(x.ops, x.machine)));
}

/** 提案的指紋（審查 F6）：任務、專案，以及每個動作的種類、目標與內容雜湊（不含版本：記憶之後變了，同一個提案也還是同一個） */
function fingerprint(x) {
  return sha1(JSON.stringify([x.task, x.pid ?? null, x.ops.map((o) => [o.op, o.ref ?? null, o.scope ?? null, o.to ?? null, o.into ?? null, o.refs ?? null, typeof o.content === 'string' ? sha1(o.content.replace(/\r\n/g, '\n')) : null])]));
}

/**
 * 存進保留區。input：{ task, pid?, kind, run?, ref?, title, reason, why, action, category, risk, scope, flags?, ops, evidence? }。
 * 同一個提案已經在保留中（例如範圍被延後、下一輪又提出一次）：更新那一項（理由、原因、這一輪、版本、證據），不另存一份；
 * 重審的次數照舊累計。回傳的 merged 是 true。
 * @returns {Promise<{ id: string, local: boolean, item: object, merged?: true }>}
 */
export async function addHolding(ctx, input = {}, { now = new Date() } = {}) {
  const item = normalize({ ...input, id: newHoldingId(now), at: now.toISOString(), machine: ctx.mid, attempts: 0, status: 'held', lastReviewAt: null });
  invariant(item.ops.length > 0, '保留區的項目要有動作', undefined, { message: 'An item in the holding area needs at least one action' });
  return ctx.locked('holding', async () => {
    // 第二輪審查 R6：使用者 90 天內標成「不需要」的同一個提案：不新增，回傳那一項（仍是已忽略）
    const ofp = opsFingerprint(item.ops, ctx.mid);
    const gone = (await listRaw(ctx, { status: 'dismissed' })).find((x) => recentlyDismissed(x, now.getTime()) && opsFingerprint(x.ops, x.machine) === ofp);
    if (gone) { const { local: wasLocal, ...g } = gone; return { id: gone.id, local: wasLocal, item: { ...g, local: wasLocal }, dismissed: true }; }
    const fp = fingerprint(item);
    const same = (await listRaw(ctx, { status: 'held' })).find((x) => x.machine === ctx.mid && fingerprint(x) === fp);
    if (same) {
      const { local: _l, ...cur } = same;
      const merged = normalize({
        ...cur, kind: item.kind, reason: item.reason, why: item.why, run: item.run ?? cur.run, ops: item.ops, flags: item.flags,
        evidence: item.evidence.length ? item.evidence : cur.evidence,
        ...(item.grounded ? { grounded: true, keep: item.keep } : {}),
      });
      const r = await save(ctx, merged, `holding again ${same.id}`);
      return { id: same.id, local: r.local, item: { ...merged, local: r.local }, merged: true };
    }
    const r = await save(ctx, item, `holding add ${item.id}`);
    return { id: item.id, local: r.local, item: { ...item, local: r.local } };
  });
}

/**
 * 保留區項目的同步衝突（審查 F8）：兩台同時改同一項時，已採用優先於已忽略、已忽略優先於保留中；
 * 狀態相同時取時間較新的（採用或忽略的時間、最後重審的時間、建立時間）；再相同時取文字較大的那一份。
 * 兩台各自合併得到同一份，不會留下衝突。回傳贏的那一份原文；一邊讀不懂就留另一邊，兩邊都讀不懂回傳 null（交給一般的衝突處理）。
 */
export function mergeHoldingJson(ours, theirs) {
  const read = (t) => { try { const j = JSON.parse(t); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; } };
  const a = read(ours);
  const b = read(theirs);
  if (!a || !b) return a ? ours : b ? theirs : null;
  const rank = (x) => ({ adopted: 2, dismissed: 1 })[x.status] ?? 0;
  const time = (x) => String(x.adoptedAt ?? x.dismissedAt ?? x.lastReviewAt ?? x.at ?? '');
  if (rank(a) !== rank(b)) return rank(a) > rank(b) ? ours : theirs;
  if (time(a) !== time(b)) return time(a) > time(b) ? ours : theirs;
  return String(ours) >= String(theirs) ? ours : theirs;
}

/** 保留區的所有項目（新的在前）；status 只列這個狀態的。疑似金鑰已遮蔽，secret 標出有沒有疑似金鑰 */
export async function listHolding(ctx, o = {}) {
  return shown(ctx, await listRaw(ctx, o));
}

async function listRaw(ctx, { status } = {}) {
  const out = new Map();
  for (const [dir, local] of [[path.join(ctx.vault, HOLDING_DIR), false], [path.join(ctx.local, 'autopilot', HOLDING_DIR), true]]) {
    for (const n of (await fsp.readdir(dir).catch(() => [])).filter((x) => x.endsWith('.json') && HOLDING_ID_RE.test(x.slice(0, -5)))) {
      const id = n.slice(0, -5);
      const j = await readJson(path.join(dir, n), null).catch(() => null);
      if (!j || typeof j !== 'object') continue;
      if (local || !out.has(id)) out.set(id, { ...(local ? normalize({ ...j, id }) : fromVault(normalize({ ...j, id }))), local });
    }
  }
  return [...out.values()].filter((x) => !status || x.status === status).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
}

/** 讀一項（疑似金鑰已遮蔽） */
export async function getHolding(ctx, id) {
  return (await shown(ctx, [await load(ctx, id)]))[0];
}

/** 更新一項（attempts、status、lastReviewAt、why、record、ops…）；ops 改了會重新檢查金鑰、必要時換位置 */
export async function updateHolding(ctx, id, patch = {}) {
  const cur = await load(ctx, id);
  const allowed = ['status', 'attempts', 'incomplete', 'lastReviewAt', 'why', 'record', 'recordItem', 'adoptedAt', 'dismissedAt', 'ops', 'grounded', 'keep'];
  const next = { ...cur };
  for (const k of allowed) if (patch[k] !== undefined) next[k] = patch[k];
  const { local, ...item } = normalize(next);
  invariant(item.ops.length > 0, '保留區的項目要有動作', undefined, { message: 'An item in the holding area needs at least one action' });
  const r = await save(ctx, item, `holding ${item.status} ${id}`);
  return { ...item, local: r.local };
}

/** 忽略：不再重審，留著當紀錄 */
export async function dismissHolding(ctx, id) {
  const cur = await load(ctx, id);
  invariant(cur.status === 'held', `這一項已經${cur.status === 'adopted' ? '採用' : '忽略'}過了`, undefined, { message: `This item has already been ${cur.status}` });
  const item = await updateHolding(ctx, id, { status: 'dismissed', dismissedAt: new Date().toISOString() });
  return { ok: true, item };
}

/** 已採用或已忽略的項目保留幾天（之後刪除；保留中的不刪） */
export const HOLDING_KEEP_DAYS = 90;

/**
 * 清理：已採用或已忽略、而且超過 90 天（從採用或忽略的時間算起）的項目刪掉，本機與 vault 都刪；
 * vault 的刪除一次 commit（另一台同步後也就不見了）。保留中的項目不刪。
 * @returns {Promise<{ removed: number }>}
 */
export async function pruneHolding(ctx, { now = Date.now() } = {}) {
  const old = (await listRaw(ctx)).filter((x) => x.status !== 'held' && now - (Date.parse(x.adoptedAt ?? x.dismissedAt ?? x.at) || now) > HOLDING_KEEP_DAYS * 86_400_000);
  if (!old.length) return { removed: 0 };
  return ctx.locked('holding', async () => {
    const rels = [];
    for (const x of old) {
      await fsp.rm(localFile(ctx, x.id), { force: true });
      if (fs.existsSync(vaultFile(ctx, x.id))) { await fsp.rm(vaultFile(ctx, x.id), { force: true }); rels.push(rel(x.id)); }
    }
    if (rels.length) await commitPaths(ctx.vault, rels, `holding prune ${rels.length}`, { action: 'autopilot', mid: ctx.mid }).catch(() => null);
    return { removed: old.length };
  });
}

/** 核心準則的附加規則（不是記憶檔，整理計畫流程不收） */
const CORE_RULE_RE = /^core\/rules\/[^/\\:*?"<>|]+\.md$/;
const revOf = (text) => createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 10);

/**
 * 採用退回的核心準則附加規則（core/rules/*.md，待你確認退回時存的版本）：照 eg.review.revert 對這類檔案的寫法直接寫回，
 * 先比對版本（之後被改過就不覆蓋）、檢查疑似金鑰，記為確認過（來源 by），一個 commit（可以用 engram undo 復原）。
 */
async function adoptCoreRules(ctx, h, id, by) {
  const undo = await ctx.locked('holding.adopt', async () => {
    const shas = [];
    for (const o of h.ops) {
      const abs = path.join(ctx.vault, ...o.ref.split('/'));
      const cur = await readText(abs);
      if (cur === null) {
        throw new EngramError(E.CONFLICT, `「${h.title}」的 ${o.ref} 已經不在了，沒有採用；這一項留在保留區`, '需要的話把保留區裡的內容手動寫回，或忽略這一項')
          .withEn(`${o.ref} behind "${h.title}" no longer exists, so it was not adopted; it stays in the holding area`, 'Copy the held content back by hand if you still want it, or dismiss the item');
      }
      // 第五輪審查 N-3：記憶庫裡同步來的項目沒有記下當時的版本就無從比對，不採用（本機存的項目照舊）
      if (!o.base && h.local !== true) {
        throw new EngramError(E.INVALID, `「${h.title}」沒有記下 ${o.ref} 當時的版本，無法確認它是針對目前的內容，沒有採用；這一項留在保留區`, '看過目前的內容後，需要的話把保留區裡的內容手動寫進去，或忽略這一項')
          .withEn(`"${h.title}" does not record which version of ${o.ref} it was made for, so it was not adopted; it stays in the holding area`, 'Check the current content, copy the held content in by hand if you still want it, or dismiss the item');
      }
      if (o.base && revOf(cur) !== o.base) {
        throw new EngramError(E.CONFLICT, `「${h.title}」的 ${o.ref} 在存進保留區之後被修改過（版本 ${o.base} → ${revOf(cur)}），沒有採用；這一項留在保留區`, '看過目前的內容後，需要的話把保留區裡的內容手動寫進去，或忽略這一項')
          .withEn(`${o.ref} behind "${h.title}" changed after it was held (version ${o.base} → ${revOf(cur)}), so it was not adopted; it stays in the holding area`, 'Check the current content, copy the held content in by hand if you still want it, or dismiss the item');
      }
      const text = String(o.content ?? '').replace(/\r\n/g, '\n');
      const allowed = await assertNoNewSecrets(ctx.local, o.ref, text, { before: cur, what: '核心準則' });
      await safeWrite(abs, text);
      // 第五輪審查 N-3：附加規則和 CORE.md 一樣每次對話都會載入。在 Claude Code 裡採用時照寫但不記確認，讓它留在「待你確認」
      const rv = by === 'claude' ? [] : await markReviewed(ctx, [o.ref], { by });
      const c = await commitPaths(ctx.vault, [o.ref, ...allowed, ...rv], `edit ${o.ref}`, { action: 'edit', refs: [o.ref], mid: ctx.mid });
      if (c?.sha) shas.push(c.sha);
    }
    return shas;
  });
  await updateHolding(ctx, id, { status: 'adopted', adoptedAt: new Date().toISOString() });
  return { ok: true, id, record: null, item: null, undo, ...(by === 'claude' ? { coreUnconfirmed: true } : {}) };
}

const PLAN_ACTIONS = ['update', 'move', 'archive', 'merge', 'create', 'split', 'promote', 'verify'];
// createFromPlan 的錯誤裡代表「記憶在存進保留區之後變了」的說法
const STALE_RE = /讀取之後被修改過|記憶不存在|不存在或不是記憶檔|已經存在|已經有同名/;

/**
 * 使用者採用一項：交給既有的整理計畫流程（createFromPlan 驗證金鑰、版本、格式、同名 → 自動採用 → applyRecord 備份並逐步執行）。
 * 寫進每次都會載入的範圍時記為確認過，來源是 by：管理介面（使用者親自採用）是 user；CLI 在 Claude Code 裡執行時是 claude
 * （第三輪審查 A：不算使用者本人確認，不進自動駕駛的偏好區塊）。記憶後來被改過（版本不合）時回報清楚的錯誤、項目留著。
 * @returns {Promise<{ ok: true, id, record, item, undo: string[] }>}
 */
export async function adoptHolding(eg, ctx, id, { by = 'user' } = {}) {
  invariant(['user', 'claude'].includes(by), `不認得的採用來源：${String(by).slice(0, 20)}`, undefined, { message: `Unknown adoption source: ${String(by).slice(0, 20)}` });
  // 整個採用在引擎的寫入鎖裡做（可重入）：同時按兩次採用時，第二次等第一次做完，再看到「已經採用過」（審查：冪等與重入）
  return ctx.locked('holding.adopt', () => adoptLocked(eg, ctx, id, by));
}

async function adoptLocked(eg, ctx, id, by) {
  const h = await load(ctx, id);
  invariant(h.status === 'held', `這一項已經${h.status === 'adopted' ? '採用' : '忽略'}過了`, undefined, { message: `This item has already been ${h.status}` });
  // 2.0.0 WP9：記憶畢業的提案交給記憶畢業的流程（核心準則記為 by 確認；護欄規則仍是提醒；環境設定仍要在每台核可）
  if (h.task === 'graduate' || h.ops.some((o) => ['guardrail', 'env', 'graduate'].includes(o.op))) {
    if (!h.graduate) {
      throw new EngramError(E.INVALID, `「${h.title}」是記憶畢業的提案，但缺少要寫進去的內容，不能直接採用；這一項留在保留區`, '可以忽略這一項，等下一次記憶畢業重新提出').withEn(`"${h.title}" is a graduation proposal without its content, so it cannot be adopted; it stays in the holding area`, 'Dismiss it; the next graduation run can propose it again');
    }
    const { applyGraduation } = await import('../autopilot/tasks/graduate.mjs');
    const r = await applyGraduation(eg, h.graduate, { by });
    await updateHolding(ctx, id, { status: 'adopted', adoptedAt: new Date().toISOString() });
    return { ok: true, id, record: null, item: null, undo: [], graduate: r, ...(r.coreUnconfirmed ? { coreUnconfirmed: true } : {}) };
  }
  // 核心準則的附加規則（core/rules/*.md）不是記憶檔：整項都是改寫這類檔案時直接寫回，混著其他動作的回報原因
  if (h.ops.some((o) => CORE_RULE_RE.test(String(o.ref ?? '')))) {
    if (h.ops.every((o) => o.op === 'write' && CORE_RULE_RE.test(String(o.ref ?? '')) && typeof o.content === 'string')) return adoptCoreRules(ctx, h, id, by);
    throw new EngramError(E.INVALID, `「${h.title}」動到核心準則的附加規則（core/rules/），又有其他動作，不能直接採用；這一項留在保留區`, '可以手動把內容寫進去，或忽略這一項')
      .withEn(`"${h.title}" touches the extra core rules (core/rules/) along with other actions, so it cannot be adopted as is; it stays in the holding area`, 'Copy the content in by hand, or dismiss the item');
  }
  // 整理流程在 tidy/（依賴 cli 的工具），用到時才載入
  const { createFromPlan, CORE_REF } = await import('../tidy/plan.mjs');
  const { applyRecord } = await import('../tidy/apply.mjs');
  const { markReady, setDecisions } = await import('../tidy/store.mjs');
  const dir = path.join(ctx.local, 'drafts', `holding-${id}`);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  try {
    const ops = [];
    for (const [k, o] of h.ops.entries()) {
      const op = { op: o.op };
      if (o.ref) op.ref = o.ref;
      if (o.op === 'core') op.ref = CORE_REF;
      if (o.op === 'move') op.to = o.to;
      if (o.op === 'create') op.scope = o.scope;
      if (o.op === 'merge') { op.refs = o.refs; op.into = o.into ?? o.refs?.[0]; op.bases = o.bases ?? []; } else if (o.base) op.base = o.base;
      if (typeof o.content === 'string' && ['write', 'merge', 'create', 'core'].includes(o.op)) {
        const f = `op${k + 1}.md`;
        await fsp.writeFile(path.join(dir, f), o.content, 'utf8');
        op.file = f;
      }
      ops.push(op);
    }
    const creates = ops.every((o) => o.op === 'create');
    const action = h.action === 'core' ? 'update' : PLAN_ACTIONS.includes(h.action) ? h.action : 'update';
    const plan = {
      scope: 'all',
      summary: `採用保留區的項目：${h.title}`.slice(0, 1000),
      items: [{
        ...(!creates && h.ref ? { ref: h.ref } : {}),
        action, title: h.title, reason: h.reason || h.why || '使用者從保留區採用',
        ...(h.evidence.length ? { evidence: h.evidence.map((e) => ({ quote: e.quote, ...(e.session ? { session: e.session } : {}), ...(e.date ? { date: e.date } : {}) })) } : {}),
        ops,
      }],
    };
    const file = path.join(dir, 'plan.json');
    await fsp.writeFile(file, JSON.stringify(plan, null, 1), 'utf8');
    let rec;
    try {
      rec = await createFromPlan(eg, file);
    } catch (err) {
      if (err?.code !== 'E_INVALID' || !Array.isArray(err.details)) throw err;
      const detail = err.details.slice(0, 3).join('；');
      if (err.details.some((e) => STALE_RE.test(e))) {
        throw new EngramError(E.CONFLICT, `「${h.title}」相關的記憶在存進保留區之後被修改過（或已經不在、已經有同名的），沒有採用；這一項留在保留區：${detail}`.slice(0, 1000), '看過目前的記憶後，需要的話把保留區裡的內容手動寫進去，或忽略這一項', { details: err.details })
          .withEn(`The memories behind "${h.title}" changed after it was held (or were removed, or a memory with that name now exists), so it was not adopted; it stays in the holding area`, 'Check the current memory, copy the held content in by hand if you still want it, or dismiss the item');
      }
      throw new EngramError(E.INVALID, `「${h.title}」不能直接採用：${detail}`.slice(0, 1000), '這一項留在保留區；可以手動把內容寫進記憶，或忽略這一項', { details: err.details })
        .withEn(`"${h.title}" cannot be adopted as is`, 'It stays in the holding area; copy the content in by hand or dismiss it');
    }
    await setDecisions(ctx.local, rec.id, Object.fromEntries(rec.items.map((x) => [x.id, { decision: 'accept' }])));
    await markReady(ctx.local, rec.id);
    // 第四輪審查 F-04：在 Claude Code 裡採用會寫 core/CORE.md 的項目：照寫，但核心準則不記確認（留在待你確認，和 engram core write 一致）；
    // 同一項的其他動作照舊記為 claude。這裡只看 CORE.md；core/rules/*.md 走 adoptCoreRules，同樣不記確認（第五輪審查 N-3）
    const touchesCore = ops.some((o) => o.op === 'core');
    const res = await applyRecord(eg, rec.id, { reviewed: by, ...(by === 'claude' ? { coreReviewed: false } : {}) });
    const x = res.record.items[0];
    if (x?.result?.status !== 'done') {
      const code = Object.values(E).includes(x?.result?.error?.code) ? x.result.error.code : E.CONFLICT;
      throw new EngramError(code, `「${h.title}」沒有採用：${x?.result?.message ?? '執行失敗'}；這一項留在保留區`.slice(0, 1000), '看過目前的記憶後再試，或忽略這一項')
        .withEn(`"${h.title}" was not adopted: ${x?.result?.error?.en?.message ?? x?.result?.message ?? 'it failed'}; it stays in the holding area`, 'Check the current memory and try again, or dismiss the item');
    }
    await updateHolding(ctx, id, { status: 'adopted', adoptedAt: new Date().toISOString(), record: rec.id });
    return { ok: true, id, record: rec.id, item: x.id, undo: x.result.undo ?? [], ...(by === 'claude' && touchesCore ? { coreUnconfirmed: true } : {}) };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
