// 記憶的列出、讀取與修改。所有修改都在鎖內進行，並各自成為一個 commit（可復原）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { E, EngramError, invariant } from './errors.mjs';
import { engramMeta, getField, parseMemoryFile, replaceBody, setFields, stringifyFrontmatter } from './frontmatter.mjs';
import { exists, listMarkdown, mtimeMs, readText, safeWrite, sha1 } from './fsx.mjs';
import { git } from './git.mjs';
import { memoryFileName, uniqueFileName } from './ids.mjs';
import { computeIndexBudget, normalizeProjectIndex, PROJECT_INDEX, rebuildScopeIndex, SCOPE_INDEX } from './normalize.mjs';
import { fromRef, toRef } from './paths.mjs';
import { assertNoNewSecrets, assertNotHeld } from './secretallow.mjs';
import { commitPaths, machineDir, projectMemoryDir, readProject } from './vault.mjs';

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];

// ───────── 範圍 ↔ 路徑 ─────────

/** @typedef {{ kind: 'global' } | { kind: 'project', pid: string } | { kind: 'machine', mid: string }} Scope */

/** ref → 範圍；不是記憶檔路徑時回傳 null。 */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FILE_RE = /^[^/\\:*?"<>|]+\.md$/i;

export function scopeOfRef(ref) {
  const parts = String(ref).split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.includes('\\'))) return null;
  if (parts.length === 2 && parts[0] === 'global' && FILE_RE.test(parts[1])) return { kind: 'global' };
  if (parts.length === 4 && parts[0] === 'projects' && parts[2] === 'memory' && ID_RE.test(parts[1]) && FILE_RE.test(parts[3])) return { kind: 'project', pid: parts[1] };
  if (parts.length === 3 && parts[0] === 'machines' && ID_RE.test(parts[1]) && FILE_RE.test(parts[2])) return { kind: 'machine', mid: parts[1] };
  return null;
}

/** 只取出驗證過的欄位重新組成範圍物件（R-45：不直接沿用呼叫端傳來的物件）。 */
export function normalizeScope(scope, defaultMid) {
  const kind = typeof scope === 'string' ? scope : scope?.kind;
  if (kind === 'global') return { kind: 'global' };
  if (kind === 'project' && ID_RE.test(String(scope?.pid ?? ''))) return { kind: 'project', pid: scope.pid };
  if (kind === 'machine') {
    const mid = scope?.mid ?? defaultMid;
    if (ID_RE.test(String(mid ?? ''))) return { kind: 'machine', mid };
  }
  throw new EngramError(E.INVALID, `不合法的範圍：${JSON.stringify(scope).slice(0, 120)}`);
}

export function scopeDir(vaultDir, scope) {
  if (scope.kind === 'global') return path.join(vaultDir, 'global');
  if (scope.kind === 'project') return projectMemoryDir(vaultDir, scope.pid);
  if (scope.kind === 'machine') return machineDir(vaultDir, scope.mid);
  throw new EngramError(E.INVALID, `未知的範圍：${JSON.stringify(scope)}`);
}

export function indexFileFor(scope) {
  return scope.kind === 'project' ? PROJECT_INDEX : SCOPE_INDEX;
}

function isIndexFile(name) {
  return /^(MEMORY|INDEX)\.md$/i.test(name);
}

function assertMemoryRef(ref) {
  const scope = scopeOfRef(ref);
  invariant(scope && /\.md$/i.test(ref) && !isIndexFile(path.posix.basename(ref)), `不是記憶檔：${ref}`);
  return scope;
}

/** 解析檔案，整理成 MemorySummary 需要的欄位。 */
export function summarize(ref, text, { mtime = 0, indexed = false } = {}) {
  const parsed = parseMemoryFile(text);
  const d = parsed.data ?? {};
  const em = engramMeta(d) ?? {};
  const modified = getField(d, 'metadata.modified');
  return {
    ref,
    scope: scopeOfRef(ref),
    name: String(d.name ?? path.posix.basename(ref, '.md')),
    description: String(d.description ?? ''),
    type: String(getField(d, 'metadata.type') ?? d.type ?? ''),
    size: Buffer.byteLength(text, 'utf8'),
    updatedAt: modified ? String(modified) : (mtime ? new Date(mtime).toISOString() : null),
    pinned: em.pinned === true || em.pinned === 'true',
    tags: Array.isArray(em.tags) ? em.tags.map(String) : [],
    project: em.project ? String(em.project) : null,
    indexed,
    findings: [],
    _parsed: parsed,
  };
}

/** 列出一個資料夾裡的記憶（含是否被索引）。 */
async function listDir(vaultDir, dir) {
  const names = await listMarkdown(dir, { exclude: [PROJECT_INDEX, SCOPE_INDEX] });
  if (!names.length) return [];
  const idxText = (await readText(path.join(dir, PROJECT_INDEX))) ?? (await readText(path.join(dir, SCOPE_INDEX))) ?? '';
  const out = [];
  for (const name of names) {
    const abs = path.join(dir, name);
    const text = await readText(abs);
    if (text === null) continue;
    const indexed = idxText.includes(`](${name})`) || idxText.includes(`/${name})`) || idxText.includes(`](./${name})`);
    out.push(summarize(toRef(vaultDir, abs), text, { mtime: mtimeMs(abs), indexed }));
  }
  return out;
}

/** 掃描整個 vault 的記憶。 */
export async function scanAllMemories(vaultDir) {
  const all = [];
  all.push(...await listDir(vaultDir, path.join(vaultDir, 'global')));
  let pids = [];
  try { pids = (await fsp.readdir(path.join(vaultDir, 'projects'), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* 空 */ }
  for (const pid of pids.sort()) all.push(...await listDir(vaultDir, projectMemoryDir(vaultDir, pid)));
  let mids = [];
  try { mids = (await fsp.readdir(path.join(vaultDir, 'machines'), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* 空 */ }
  for (const mid of mids.sort()) all.push(...await listDir(vaultDir, machineDir(vaultDir, mid)));
  return all;
}

/** 對外的 MemorySummary（拿掉內部欄位）。 */
export function publicSummary(s) {
  const { _parsed, ...rest } = s;
  return rest;
}

// ───────── 讀取 ─────────

export async function readMemory(ctx, ref, { withHistory = false } = {}) {
  assertMemoryRef(ref);
  const abs = fromRef(ctx.vault, ref);
  const raw = await readText(abs);
  if (raw === null) throw new EngramError(E.NOT_FOUND, `找不到記憶：${ref}`);
  const parsed = parseMemoryFile(raw);
  const s = summarize(ref, raw, { mtime: mtimeMs(abs) });
  const mem = { ref, scope: s.scope, frontmatter: parsed.data, body: parsed.body, raw, path: abs, updatedAt: s.updatedAt };
  if (withHistory) mem.history = await ctx.history({ ref, limit: 20 });
  return mem;
}

// ───────── 修改（呼叫端負責持鎖） ─────────

/** 修改後更新該範圍的索引；回傳需要 commit 的 ref 清單。 */
export async function refreshIndex(ctx, scope) {
  const dir = scopeDir(ctx.vault, scope);
  if (scope.kind === 'project') {
    // M9：該專案有進行中的對話時只附加、不刪不排，且不碰 10 秒內被 Claude 改過的索引（R-08）
    const { activeProjects } = await import('./sync.mjs');
    const appendOnly = (await activeProjects(ctx)).has(scope.pid);
    const r = await normalizeProjectIndex(dir, { appendOnly, skipRecentMs: appendOnly ? 10_000 : 0 });
    return r.changed ? [toRef(ctx.vault, path.join(dir, PROJECT_INDEX))] : [];
  }
  const projectNames = await ctx.projectNames();
  const label = scope.kind === 'machine' ? (await ctx.machineLabel(scope.mid)) : undefined;
  const budget = (await computeIndexBudget(ctx.vault))[scope.kind];
  const r = await rebuildScopeIndex({ kind: scope.kind, dir, userHome: ctx.homes.userHome, label, projectNames, budget });
  return r.changed ? [toRef(ctx.vault, path.join(dir, SCOPE_INDEX))] : [];
}

async function ensureScopeExists(ctx, scope) {
  if (scope.kind === 'project') {
    const p = await readProject(ctx.vault, scope.pid);
    if (!p) throw new EngramError(E.NOT_FOUND, `找不到專案：${scope.pid}`);
  }
  if (scope.kind === 'machine' && !exists(machineDir(ctx.vault, scope.mid))) {
    throw new EngramError(E.NOT_FOUND, `找不到電腦：${scope.mid}`);
  }
  await fsp.mkdir(scopeDir(ctx.vault, scope), { recursive: true });
}

function result(commit) {
  return { ok: true, commit: commit ?? undefined, undo: commit ? { sha: commit.sha } : undefined };
}

/** HEAD 裡這個檔案的內容（沒有進過 git 時為 null） */
async function headText(ctx, ref) {
  const r = await git(['show', `HEAD:${ref}`], { cwd: ctx.vault, allowFail: true });
  return r.code === 0 ? r.stdout : null;
}

/** 新增一筆記憶（engram remember 的實作，R-05）。 */
export async function createMemory(ctx, { scope, name, type, description, body = '', project, allowSecrets = false }) {
  invariant(scope && ['global', 'project', 'machine'].includes(scope.kind), '請指定範圍：global、project 或 machine');
  invariant(name && String(name).trim(), '請提供 name');
  invariant(MEMORY_TYPES.includes(type), `type 必須是 ${MEMORY_TYPES.join('、')} 之一`);
  invariant(description && String(description).trim(), '請提供 description（一行摘要）');
  if (project !== undefined && project !== null) invariant(ID_RE.test(String(project)), '不合法的專案 id');
  const sc = normalizeScope(scope, ctx.mid);
  return ctx.locked('memories.create', async () => {
    await ensureScopeExists(ctx, sc);
    const dir = scopeDir(ctx.vault, sc);
    const file = uniqueFileName(memoryFileName(name), (f) => exists(path.join(dir, f)));
    const metadata = { type };
    if (project && sc.kind !== 'project') metadata.engram = { project };
    const fm = stringifyFrontmatter({ name: file.replace(/\.md$/i, ''), description: String(description).trim(), metadata });
    const text = `${fm}\n${String(body).replace(/\r\n/g, '\n').trim()}\n`;
    const abs = path.join(dir, file);
    const ref = toRef(ctx.vault, abs);
    const allowed = await assertNoNewSecrets(ctx.local, ref, text, { allowSecrets });
    await safeWrite(abs, text, { expectHash: null });
    const idx = await refreshIndex(ctx, sc);
    const commit = await commitPaths(ctx.vault, [ref, ...idx, ...allowed], `remember ${ref}`, { action: 'create', refs: [ref], mid: ctx.mid });
    return { ...result(commit), ref };
  });
}

/** 寫入既有記憶：{ text } 取代整檔；或 { frontmatter: {鍵: 值}, body } 精準修改。 */
export async function writeMemory(ctx, ref, input) {
  const scope = assertMemoryRef(ref);
  return ctx.locked('memories.write', async () => {
    const abs = fromRef(ctx.vault, ref);
    const cur = await readText(abs);
    if (cur === null) throw new EngramError(E.NOT_FOUND, `找不到記憶：${ref}`);
    let next;
    if (typeof input?.text === 'string') next = input.text;
    else {
      next = cur;
      if (input?.frontmatter && Object.keys(input.frontmatter).length) {
        try { next = setFields(next, input.frontmatter); } catch (err) {
          throw new EngramError(E.INVALID, '這筆記憶的 frontmatter 格式有誤，無法只修改欄位', '請改用原始碼模式編輯整份內容（frontmatter 修正後即可）', { cause: err.message });
        }
      }
      if (typeof input?.body === 'string') {
        const p = parseMemoryFile(next);
        const head = p.hasFrontmatter ? next.slice(0, next.length - p.body.length) : '';
        next = `${head}${input.body.replace(/\r\n/g, '\n').replace(/\n*$/, '\n')}`;
      }
    }
    if (next === cur) return { ok: true };
    const allowed = await assertNoNewSecrets(ctx.local, ref, next, { before: cur, allowSecrets: !!input?.allowSecrets });
    const ok = await safeWrite(abs, next, { expectHash: sha1(cur) });
    if (!ok) throw new EngramError(E.CONFLICT, '這筆記憶剛被其他程式修改，已放棄這次寫入', '重新讀取後再試一次');
    const idx = await refreshIndex(ctx, scope);
    const commit = await commitPaths(ctx.vault, [ref, ...idx, ...allowed], `edit ${ref}`, { action: 'edit', refs: [ref], mid: ctx.mid });
    return result(commit);
  });
}

/** 移動到其他範圍。 */
export async function moveMemory(ctx, ref, toScope) {
  const from = assertMemoryRef(ref);
  const to = normalizeScope(toScope, ctx.mid);
  return ctx.locked('memories.move', async () => {
    await ensureScopeExists(ctx, to);
    const src = fromRef(ctx.vault, ref);
    if (!exists(src)) throw new EngramError(E.NOT_FOUND, `找不到記憶：${ref}`);
    await assertNotHeld(ctx.local, ref, await readText(src), '移動', { removable: false });
    const destDir = scopeDir(ctx.vault, to);
    const file = uniqueFileName(path.basename(src), (f) => exists(path.join(destDir, f)));
    const dest = path.join(destDir, file);
    await fsp.rename(src, dest);
    const destRef = toRef(ctx.vault, dest);
    const idx = [...await refreshIndex(ctx, from), ...await refreshIndex(ctx, to)];
    const label = to.kind === 'global' ? 'global' : to.kind === 'project' ? `projects/${to.pid}` : `machines/${to.mid}`;
    const commit = await commitPaths(ctx.vault, [ref, destRef, ...idx], `move ${label} ← ${ref}`, { action: 'move', refs: [ref, destRef], mid: ctx.mid });
    return { ...result(commit), ref: destRef };
  });
}

/**
 * 合併多筆記憶：into（其中一筆或既有記憶）寫入 text，其他刪除。
 * text 沒有 frontmatter 時（介面的合併對話框只送內文）沿用目標檔的 frontmatter，只換內文。
 */
export async function mergeMemories(ctx, refs, { into, text }) {
  invariant(Array.isArray(refs) && refs.length >= 2, '至少要兩筆記憶才能合併');
  invariant(typeof text === 'string' && text.trim(), '請提供合併後的內容');
  const target = into ?? refs[0];
  assertMemoryRef(target);
  refs.forEach(assertMemoryRef);
  return ctx.locked('memories.merge', async () => {
    const others = refs.filter((r) => r !== target);
    const targetAbs = fromRef(ctx.vault, target);
    for (const r of new Set([target, ...refs])) await assertNotHeld(ctx.local, r, await readText(fromRef(ctx.vault, r)), '合併', { headRaw: await headText(ctx, r) });
    let full = text;
    if (!parseMemoryFile(text).hasFrontmatter) {
      const cur = await readText(targetAbs);
      if (cur === null) throw new EngramError(E.INVALID, '合併後的內容沒有 frontmatter，目標記憶也不存在', '請提供含 name、description、metadata.type 的完整內容，或合併到其中一筆既有的記憶');
      full = replaceBody(cur, text.replace(/\r\n/g, '\n').replace(/\n*$/, '\n'));
    }
    await fsp.mkdir(path.dirname(targetAbs), { recursive: true });
    let merged;
    try { merged = setFields(full, { 'metadata.engram.supersedes': others }); } catch (err) {
      throw new EngramError(E.INVALID, '合併後內容的 frontmatter 格式有誤', '請修正 frontmatter 後再合併', { cause: err.message });
    }
    await assertNoNewSecrets(ctx.local, target, merged, { what: '合併後的內容' });
    // 目標寫入失敗（檔案被占用、剛被改過）時不可以刪掉其他筆
    if (!(await safeWrite(targetAbs, merged))) throw new EngramError(E.CONFLICT, `無法寫入 ${target}，合併已取消`, '檔案可能被其他程式占用或剛被修改；稍後再試一次');
    for (const r of others) await fsp.rm(fromRef(ctx.vault, r), { force: true });
    const scopes = new Map();
    for (const r of [target, ...others]) { const s = scopeOfRef(r); scopes.set(JSON.stringify(s), s); }
    const idx = [];
    for (const s of scopes.values()) idx.push(...await refreshIndex(ctx, s));
    const commit = await commitPaths(ctx.vault, [target, ...others, ...idx], `merge ${refs.length} → ${target}`, { action: 'merge', refs: [target, ...others], mid: ctx.mid });
    return { ...result(commit), ref: target };
  });
}

/** 刪除（git 歷史可還原）。 */
export async function removeMemory(ctx, ref) {
  const scope = assertMemoryRef(ref);
  return ctx.locked('memories.remove', async () => {
    const abs = fromRef(ctx.vault, ref);
    if (!exists(abs)) throw new EngramError(E.NOT_FOUND, `找不到記憶：${ref}`);
    await assertNotHeld(ctx.local, ref, await readText(abs), '封存', { headRaw: await headText(ctx, ref) });
    await fsp.rm(abs, { force: true });
    const idx = await refreshIndex(ctx, scope);
    const commit = await commitPaths(ctx.vault, [ref, ...idx], `remove ${ref}`, { action: 'remove', refs: [ref], mid: ctx.mid });
    return result(commit);
  });
}

/** 從歷史還原；rev 省略時取「最後一次刪除它之前」的版本。 */
export async function restoreMemory(ctx, ref, { rev } = {}) {
  const scope = assertMemoryRef(ref);
  // R-45：rev 會交給 git，只接受 commit sha（可加 ^ 或 ~N），避免被當成選項
  if (rev !== undefined && rev !== null) invariant(/^[0-9a-f]{7,40}(\^+|~\d{1,4})?$/i.test(String(rev)), `不合法的版本：${String(rev).slice(0, 60)}`);
  return ctx.locked('memories.restore', async () => {
    let at = rev;
    if (!at) {
      const r = await git(['log', '-1', '--format=%H', '--diff-filter=D', '--', ref], { cwd: ctx.vault });
      const sha = r.stdout.trim();
      if (!sha) throw new EngramError(E.NOT_FOUND, `歷史中找不到被刪除的 ${ref}`);
      at = `${sha}^`;
    }
    const show = await git(['show', `${at}:${ref}`], { cwd: ctx.vault, allowFail: true });
    if (show.code !== 0) throw new EngramError(E.NOT_FOUND, `版本 ${at} 中沒有 ${ref}`);
    const abs = fromRef(ctx.vault, ref);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await safeWrite(abs, show.stdout);
    const idx = await refreshIndex(ctx, scope);
    const commit = await commitPaths(ctx.vault, [ref, ...idx], `restore ${ref} @${String(at).slice(0, 7)}`, { action: 'restore', refs: [ref], mid: ctx.mid });
    return result(commit);
  });
}

export { fs as _fs };
