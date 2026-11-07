// 讀取統計（1.4.0）：從 Claude Code 的對話紀錄（transcript）算出每筆記憶被讀了幾次、在哪些專案讀的。
// Anthropic 的記憶研究：每次都載入的那一層要小，該依實際使用決定哪些記憶值得放進去。
// - 對話紀錄只在本機讀，不同步；每個 .jsonl 記住讀到哪個位元組，之後只讀新增的部分。
// - 本機明細 local/usage/reads.json（每天、每個專案的次數，保留 180 天）。
// - 同步摘要 machines/<mid>/usage.json（近 90 天），每台只寫自己的檔，不會衝突；每天最多寫一次。
// 「一次」＝同一個對話、同一天讀了這筆記憶（重複讀不重複算）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { classify, normPath, parseCommand } from '../../plugin/hooks/lens/model.mjs';
import { readJson, readText, writeJson } from './fsx.mjs';
import { encodeProjectPath, memoryRootFor } from './paths.mjs';
import { allBindingViews, listMachineIds, machineDir, readBindings } from './vault.mjs';

export const USAGE_FILE = 'usage.json';
export const WINDOW_DAYS = 90;
const KEEP_DAYS = 180;
const DAY = 86_400_000;
const TOOL_USE = Buffer.from('"tool_use"');
const NL = 10;

/** 本地時區的 YYYY-MM-DD */
export function localDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const scanPath = (local) => path.join(local, 'usage', 'scan.json');
const readsPath = (local) => path.join(local, 'usage', 'reads.json');

/** 所有 transcript：~/.claude/projects/<編碼>/*.jsonl 與子代理的 <編碼>/<session>/subagents/*.jsonl */
export async function listTranscriptFiles(claudeHome) {
  const root = path.join(claudeHome, 'projects');
  const out = [];
  let dirs = [];
  try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.join(dir, e.name));
      else if (e.isDirectory() && e.name !== 'memory') {
        const sub = path.join(dir, e.name, 'subagents');
        let subs = [];
        try { subs = await fsp.readdir(sub, { withFileTypes: true }); } catch { continue; }
        for (const s of subs) if (s.isFile() && s.name.endsWith('.jsonl')) out.push(path.join(sub, s.name));
      }
    }
  }
  return out.sort();
}

/**
 * 路徑 → 記憶 ref（只認記憶檔，索引與核心準則不算）。
 * roots：{ home, vault, claudeHome }；encToPid：Claude Code 編碼名稱（小寫）→ 這台電腦綁定的 pid。
 */
export function refOfPath(p, roots, encToPid) {
  const c = classify(p, { ...roots, cwd: roots.cwd ?? '' });
  if (!c || !['global', 'machine', 'project'].includes(c.scope)) return null;
  const file = normPath(p).split('/').pop();
  if (/^(INDEX|MEMORY|CORE)\.md$/i.test(file)) return null;
  if (c.scope === 'global') return `global/${file}`;
  if (c.scope === 'machine') return `machines/${c.owner}/${file}`;
  const inVault = normPath(p).toLowerCase().startsWith(`${normPath(roots.vault).toLowerCase()}/`);
  const pid = inVault ? c.owner : encToPid.get(String(c.owner).toLowerCase());
  return pid ? `projects/${pid}/memory/${file}` : null;
}

/** vault 裡現有的記憶檔：小寫 ref → 實際的 ref（用來排除不存在的檔名、萬用字元，並對到正確的大小寫） */
export async function existingRefs(vaultDir) {
  const out = new Map();
  const add = async (dir, prefix) => {
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return; }
    for (const n of names) if (/\.md$/i.test(n) && !/^(INDEX|MEMORY)\.md$/i.test(n)) out.set(`${prefix}/${n}`.toLowerCase(), `${prefix}/${n}`);
  };
  await add(path.join(vaultDir, 'global'), 'global');
  for (const sub of ['projects', 'machines']) {
    let ids = [];
    try { ids = (await fsp.readdir(path.join(vaultDir, sub), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
    for (const id of ids) await add(sub === 'projects' ? path.join(vaultDir, sub, id, 'memory') : path.join(vaultDir, sub, id), sub === 'projects' ? `projects/${id}/memory` : `machines/${id}`);
  }
  return out;
}

/** 一筆 assistant 紀錄裡讀到的記憶 ref（Read 工具、Bash／PowerShell 的讀檔與 engram memory show）。 */
export function readsInRecord(o, roots, encToPid) {
  const content = o?.message?.content;
  if (o?.type !== 'assistant' || !Array.isArray(content)) return [];
  const r = { ...roots, cwd: normPath(o.cwd ?? '') };
  const out = new Set();
  for (const b of content) {
    if (b?.type !== 'tool_use' || !b.input) continue;
    const paths = [];
    if (b.name === 'Read' && typeof b.input.file_path === 'string') paths.push(b.input.file_path);
    else if ((b.name === 'Bash' || b.name === 'PowerShell') && typeof b.input.command === 'string') {
      try { paths.push(...(parseCommand(b.input.command, r, b.name === 'PowerShell' ? 'powershell' : 'bash')?.paths ?? [])); } catch { /* 看不懂的指令略過 */ }
    }
    for (const p of paths) {
      const ref = refOfPath(p, r, encToPid);
      if (ref) out.add(ref);
    }
  }
  return [...out];
}

/** 從 start 開始讀完整的行（最後沒有換行的那一段不算），只解碼含 "tool_use" 的行；回傳讀到的位置。 */
async function eachToolLine(file, start, onLine) {
  let pos = start;
  let rest = null;
  let base = start;
  const stream = fs.createReadStream(file, { start });
  for await (const chunk of stream) {
    const buf = rest && rest.length ? Buffer.concat([rest, chunk]) : chunk;
    let from = 0;
    let i;
    while ((i = buf.indexOf(NL, from)) !== -1) {
      const t = buf.indexOf(TOOL_USE, from);
      if (t !== -1 && t < i) onLine(buf.toString('utf8', from, i));
      from = i + 1;
      pos = base + from;
    }
    rest = buf.subarray(from);
    base += from;
  }
  return pos;
}

/** 這台電腦的綁定：編碼名稱（小寫）→ pid，與「cwd → pid」的查詢 */
async function bindingLookups(ctx) {
  const views = allBindingViews(await readBindings(ctx.vault, ctx.mid));
  const encToPid = new Map();
  for (const v of views) if (v.encoded && v.pid) encToPid.set(v.encoded.toLowerCase(), v.pid);
  const pidOfCwd = (cwd) => {
    if (!cwd) return null;
    const enc = encodeProjectPath(memoryRootFor(cwd).root);
    return enc ? encToPid.get(enc.toLowerCase()) ?? null : null;
  };
  return { encToPid, pidOfCwd };
}

/**
 * 增量掃描這台電腦的 transcript，更新本機明細。回傳 { files, scannedBytes, since }。
 * @param {{ now?: number }} [o]
 */
export async function scanUsage(ctx, { now = Date.now() } = {}) {
  const scan = (await readJson(scanPath(ctx.local), null)) ?? { v: 1, since: null, files: {} };
  const reads = (await readJson(readsPath(ctx.local), null)) ?? { v: 1, refs: {}, seen: {} };
  if (!scan.files || typeof scan.files !== 'object') scan.files = {};
  if (!reads.refs || typeof reads.refs !== 'object') reads.refs = {};
  if (!reads.seen || typeof reads.seen !== 'object') reads.seen = {};
  const exist = await existingRefs(ctx.vault);
  const roots = { home: normPath(ctx.homes.userHome), vault: normPath(ctx.vault), claudeHome: normPath(ctx.homes.claudeHome) };
  const { encToPid, pidOfCwd } = await bindingLookups(ctx);
  const files = await listTranscriptFiles(ctx.homes.claudeHome);
  const present = new Set(files);
  let scannedBytes = 0;
  let earliest = null;
  for (const file of files) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    const prev = scan.files[file];
    let start = prev && prev.offset <= st.size ? prev.offset : 0;
    if (prev && start === st.size) continue;
    const sid = path.basename(file, '.jsonl');
    const end = await eachToolLine(file, start, (line) => {
      let o;
      try { o = JSON.parse(line); } catch { return; }
      const refs = readsInRecord(o, roots, encToPid).map((r) => exist.get(r.toLowerCase())).filter(Boolean);
      if (!refs.length) return;
      const at = Date.parse(o.timestamp ?? '') || st.mtimeMs;
      if (now - at > KEEP_DAYS * DAY) return;
      if (earliest === null || at < earliest) earliest = at;
      const day = localDate(at);
      const session = o.sessionId ?? sid;
      const pid = pidOfCwd(o.cwd);
      for (const ref of refs) {
        const seenKey = `${session}\u0000${ref}`;
        const seen = (reads.seen[day] ??= []);
        if (seen.includes(seenKey)) continue;
        seen.push(seenKey);
        const e = (reads.refs[ref] ??= { days: {} });
        const d = (e.days[day] ??= { n: 0, p: {} });
        d.n++;
        if (pid) d.p[pid] = (d.p[pid] ?? 0) + 1;
      }
    }).catch(() => start);
    scannedBytes += end - start;
    scan.files[file] = { offset: end, size: st.size };
  }
  // 已被 Claude Code 清除的 transcript 不再追蹤（統計已經記在明細裡）
  for (const f of Object.keys(scan.files)) if (!present.has(f)) delete scan.files[f];
  // 統計起始日：第一次掃描時以最早的一筆讀取（或今天）為準，之後只會往前
  const first = earliest ?? now;
  if (!scan.since || localDate(first) < scan.since) scan.since = localDate(Math.min(first, now));
  pruneReads(reads, now);
  await fsp.mkdir(path.dirname(scanPath(ctx.local)), { recursive: true });
  await writeJson(readsPath(ctx.local), reads);
  await writeJson(scanPath(ctx.local), scan);
  return { files: files.length, scannedBytes, since: scan.since };
}

/** 超過保留天數的明細刪掉 */
function pruneReads(reads, now) {
  const cut = localDate(now - KEEP_DAYS * DAY);
  for (const day of Object.keys(reads.seen)) if (day < cut) delete reads.seen[day];
  for (const [ref, e] of Object.entries(reads.refs)) {
    for (const day of Object.keys(e.days)) if (day < cut) delete e.days[day];
    if (!Object.keys(e.days).length) delete reads.refs[ref];
  }
}

/** 這台電腦的同步摘要內容：近 WINDOW_DAYS 天的次數、天數、最後讀取日與各專案次數（鍵排序，兩次結果一字不差）。 */
export async function summaryFor(ctx, { now = Date.now() } = {}) {
  const scan = (await readJson(scanPath(ctx.local), null)) ?? {};
  const reads = (await readJson(readsPath(ctx.local), null)) ?? { refs: {} };
  const cut = localDate(now - WINDOW_DAYS * DAY);
  const refs = {};
  for (const ref of Object.keys(reads.refs ?? {}).sort()) {
    const e = reads.refs[ref];
    const days = Object.keys(e.days ?? {}).filter((d) => d >= cut).sort();
    if (!days.length) continue;
    let n = 0;
    const per = {};
    for (const d of days) {
      const v = e.days[d];
      n += typeof v === 'number' ? v : Number(v?.n) || 0;
      for (const [pid, k] of Object.entries(v?.p ?? {})) per[pid] = (per[pid] ?? 0) + k;
    }
    const projects = {};
    for (const pid of Object.keys(per).sort()) projects[pid] = per[pid];
    refs[ref] = { reads: n, days: days.length, last: days[days.length - 1], projects };
  }
  return { v: 1, since: scan.since ?? localDate(now), window: WINDOW_DAYS, refs };
}

/** 這台電腦單一記憶的明細（介面用）：近 WINDOW_DAYS 天每天的次數 */
export async function localDetail(ctx, ref, { now = Date.now() } = {}) {
  const reads = (await readJson(readsPath(ctx.local), null)) ?? { refs: {} };
  const e = reads.refs?.[ref];
  if (!e) return [];
  const cut = localDate(now - WINDOW_DAYS * DAY);
  return Object.keys(e.days ?? {}).filter((d) => d >= cut).sort().map((d) => ({ date: d, reads: typeof e.days[d] === 'number' ? e.days[d] : Number(e.days[d]?.n) || 0 }));
}

/**
 * 寫入這台電腦的同步摘要：今天寫過就不再寫（updated 是日期），內容沒變也不寫。回傳要 commit 的 ref 或 null。
 * @param {{ now?: number, force?: boolean }} [o]
 */
export async function writeUsageSummary(ctx, { now = Date.now(), force = false } = {}) {
  const rel = `machines/${ctx.mid}/${USAGE_FILE}`;
  const abs = path.join(machineDir(ctx.vault, ctx.mid), USAGE_FILE);
  const cur = await readJson(abs, null);
  const today = localDate(now);
  if (!force && cur?.updated === today) return null;
  const next = { ...(await summaryFor(ctx, { now })), updated: today };
  const same = cur && JSON.stringify({ ...cur, updated: null }) === JSON.stringify({ ...next, updated: null });
  if (same && !force) return null;
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await writeJson(abs, next);
  return rel;
}

/**
 * 所有電腦的摘要合計：ref → { reads, days, last, projects }；since 取最早的起始日，machines 是有摘要的電腦數。
 * days 是各台天數相加（同一天兩台都讀時會多算，只用來判斷「是不是只有一天」）。
 */
export async function loadUsage(vaultDir) {
  const refs = new Map();
  let since = null;
  let machines = 0;
  const perMachine = new Map();
  for (const mid of await listMachineIds(vaultDir).catch(() => [])) {
    const text = await readText(path.join(machineDir(vaultDir, mid), USAGE_FILE)).catch(() => null);
    if (!text) continue;
    let u;
    try { u = JSON.parse(text); } catch { continue; }
    if (!u || typeof u !== 'object' || Array.isArray(u)) continue;
    machines++;
    const ms = typeof u.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(u.since) ? u.since : null;
    perMachine.set(mid, ms);
    if (ms && (!since || ms < since)) since = ms;
    const list = u.refs && typeof u.refs === 'object' && !Array.isArray(u.refs) ? u.refs : {};
    for (const [ref, e] of Object.entries(list)) {
      if (!e || typeof e !== 'object') continue;
      const cur = refs.get(ref) ?? { reads: 0, days: 0, last: null, projects: {}, byMachine: {} };
      cur.reads += Number(e.reads) || 0;
      cur.days += Number(e.days) || 0;
      if (e.last && (!cur.last || e.last > cur.last)) cur.last = e.last;
      for (const [pid, n] of Object.entries(e.projects && typeof e.projects === 'object' ? e.projects : {})) cur.projects[pid] = (cur.projects[pid] ?? 0) + (Number(n) || 0);
      cur.byMachine[mid] = Number(e.reads) || 0;
      refs.set(ref, cur);
    }
  }
  return { refs, since, machines, perMachine };
}

/**
 * 給索引挑選用：檔名 → 近 90 天讀取次數（所有電腦合計）。scopeRef 是那個範圍的 ref 前綴（global／machines/<mid>）。
 * 只用同步的摘要，兩台電腦算出來一樣。
 */
export async function readsForScope(vaultDir, scopeRef, now = Date.now()) {
  try {
    for (const mid of await listMachineIds(vaultDir)) {
      const m = await readJson(path.join(machineDir(vaultDir, mid), 'machine.json'), null).catch(() => null);
      // 30 天沒開的電腦（例如已經不用的舊電腦）不會改寫索引，不必等它升級（同 coverageDays 的 30 天；但看不出最後出現時間時，這裡當成還在用）
      // 沒有 lastSeenAt（看不出來）時當成還在用，照樣檢查版本
      const seen = Date.parse(m?.lastSeenAt ?? '');
      if (Number.isFinite(seen) && now - seen > 30 * DAY) continue;
      if (!versionAtLeast(m?.engramVersion, '1.4.0')) return undefined;
    }
    const { refs } = await loadUsage(vaultDir);
    return (file) => refs.get(`${scopeRef}/${file}`)?.reads ?? 0;
  } catch {
    return undefined; // 讀取統計是輔助資訊：任何問題都當作沒有統計，不擋住寫入與同步
  }
}

/** '1.4.0-abc1234' 這類版本字串是否 ≥ want */
export function versionAtLeast(v, want) {
  const a = String(v ?? '').split('-')[0].split('.').map(Number);
  const b = want.split('.').map(Number);
  if (a.length < 3 || a.some((x) => !Number.isFinite(x))) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/**
 * 統計涵蓋了幾天：最近 30 天有活動的每一台電腦都要有摘要，取涵蓋最短的那台（沒有統計的電腦、剛升級的電腦會讓結果是 0，
 * 「所有電腦都沒讀過」才說得準）。沒有任何摘要時 0。
 */
export async function coverageDays(vaultDir, usage, now = Date.now()) {
  if (!usage?.machines) return 0;
  let min = Infinity;
  for (const mid of await listMachineIds(vaultDir)) {
    const m = await readJson(path.join(machineDir(vaultDir, mid), 'machine.json'), null).catch(() => null);
    const seen = Date.parse(m?.lastSeenAt ?? '') || 0;
    if (now - seen > 30 * DAY) continue; // 很久沒開的電腦不算
    const since = usage.perMachine?.get(mid);
    if (!since) return 0;
    min = Math.min(min, Math.floor((now - Date.parse(`${since}T00:00:00`)) / DAY));
  }
  return Number.isFinite(min) ? Math.max(0, min) : 0;
}
