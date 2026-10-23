// 專案身分解析與綁定。規則見 40 號文件 §08。
// 混合綁定（R-52）：每個綁定都在專案根目錄寫 .claude/settings.local.json 的 autoMemoryDirectory，
// 從根目錄啟動時直接指向 vault，不經過 junction，所以不受權限模式影響。
// 預設權限模式是 auto／bypassPermissions 時，另外把 ~/.claude/projects/<編碼>/memory 做成 junction，
// 補足「從 git 子資料夾啟動」；其他模式透過 junction 讀寫會被 Claude Code 擋下，不建立。
// 碰撞資料夾（同一個編碼對應多個實際根目錄）只用設定檔。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { E, EngramError } from './errors.mjs';
import { parseMemoryFile, semanticKey } from './frontmatter.mjs';
import {
  createJunction, exists, isEmptyDir, isLink, linkTarget, listMarkdown, readJson, readJsonSync, readText, safeWrite, sha1, stableJson,
} from './fsx.mjs';
import { git } from './git.mjs';
import { makePid, randomBase32, uniqueFileName } from './ids.mjs';
import { normalizeProjectIndex, PROJECT_INDEX } from './normalize.mjs';
import {
  encodeProjectPath, memoryRootFor, normalizeFsPath, normalizeRemote, readGitRemotes, samePath, toRef, toTildePath,
} from './paths.mjs';
import { allowJunctionRead, defaultPermissionMode, isJunctionReadAllowed, revokeJunctionRead } from './claudesettings.mjs';
import { hasActiveSession, scanEncodedDir } from './transcripts.mjs';
import {
  allBindingViews, bindingKey, commitPaths, findBindingByEncoded, findBindingByPath, listProjectIds, projectDir, projectMemoryDir, readBindings,
  readProject, writeBindings, writeProject,
} from './vault.mjs';

const readJsonSyncSafe = (p) => readJsonSync(p, null);
const MARKER = path.join('.claude', 'engram.json');
const SETTINGS_LOCAL = path.join('.claude', 'settings.local.json');

// 透過 junction 讀寫記憶不會被擋的預設權限模式（R-52；claude-25、claude-57 在 2.1.306 實測）
export const JUNCTION_MODES = new Set(['auto', 'bypassPermissions']);

/** 現在適不適合建 junction：預設權限模式允許（給 root 時含專案層設定），而且相容性探測沒有暫停 junction。 */
export async function junctionAllowed(ctx, root) {
  const paused = (await readJson(path.join(ctx.local, 'paused.json'), null)) ?? {};
  if (paused.junction) return false;
  return JUNCTION_MODES.has(await defaultPermissionMode(ctx.homes, root));
}

// ───────── git 身分 ─────────

/** 取得 remote（正規化）與 root commit。root commit 需要啟動 git，只在綁定與解析時使用。 */
export async function gitIdentity(gitInfo, { withRootCommits = true } = {}) {
  if (!gitInfo) return { remotes: [], rootCommits: [] };
  const remotes = [...new Set(readGitRemotes(gitInfo.commonDir).map(normalizeRemote).filter(Boolean))].sort();
  let rootCommits = [];
  if (withRootCommits) {
    const r = await git(['rev-list', '--max-parents=0', 'HEAD'], { cwd: gitInfo.root, allowFail: true, timeoutMs: 5_000 });
    if (r.code === 0) rootCommits = r.stdout.split(/\s+/).filter((s) => /^[0-9a-f]{40}$/.test(s)).sort();
  }
  return { remotes, rootCommits };
}

/** 讀出資料夾第一層的檔名（給非 git 資料夾做相似度）。 */
function topEntries(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.') && n !== 'node_modules').sort().slice(0, 200);
  } catch { return []; }
}

function jaccard(a, b) {
  const A = new Set(a.map((s) => s.toLowerCase()));
  const B = new Set(b.map((s) => s.toLowerCase()));
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 讀 settings.local.json 的 autoMemoryDirectory，回傳指向的 pid（若在 vault 內）。 */
function settingsPid(root, homes) {
  const s = readJsonSyncSafe(path.join(root, SETTINGS_LOCAL));
  const dir = s?.autoMemoryDirectory;
  if (typeof dir !== 'string') return null;
  const abs = normalizeFsPath(dir.startsWith('~/') ? path.join(homes.userHome, dir.slice(2)) : dir);
  const rel = path.relative(homes.vault, abs).split(path.sep);
  return rel.length === 3 && rel[0] === 'projects' && rel[2] === 'memory' ? rel[1] : null;
}

function markerPid(root) {
  return readJsonSyncSafe(path.join(root, MARKER))?.pid ?? null;
}

/**
 * 這個編碼資料夾是否被多個實際根目錄共用（中文路徑碰撞）。
 * 證據有兩種：transcript 裡出現其他根目錄；或綁定表裡同一個編碼已有「仍然存在的」其他路徑（R-25：
 * 另一個資料夾可能還沒開過 Claude Code，transcript 裡看不到）。
 */
export async function detectCollision(homes, encoded, root, bindings = null, { fsIndexMaxAgeMs = Infinity } = {}) {
  if (!encoded) return null;
  const others = [];
  const add = (p) => { if (p && !samePath(p, root) && exists(p) && !others.some((r) => samePath(r, p))) others.push(normalizeFsPath(p)); };
  // 1. transcript 裡的根目錄
  const scan = await scanEncodedDir(homes.claudeHome, encoded);
  scan.roots.forEach(add);
  // 2. 綁定表裡同一個編碼、仍然存在的其他路徑（R-25）
  if (bindings) for (const v of allBindingViews(bindings)) if (v.encoded.toLowerCase() === encoded.toLowerCase()) add(v.path);
  // 3. 檔案系統：同一層的兄弟資料夾（便宜，永遠檢查）＋ 常見位置的編碼索引（SW-1：transcript 會被清掉，記憶檔不會）
  try {
    const parent = path.dirname(root);
    for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
      if (e.isDirectory() && encodeProjectPath(path.join(parent, e.name))?.toLowerCase() === encoded.toLowerCase()) add(path.join(parent, e.name));
    }
  } catch { /* 上層不可讀 */ }
  const idx = await encodingIndex(homes, { maxAgeMs: fsIndexMaxAgeMs, extraRoots: bindings ? allBindingViews(bindings).map((v) => path.dirname(v.path)) : [] });
  for (const p of idx?.[encoded.toLowerCase()] ?? []) add(p);
  return others.length ? { encoded, roots: [normalizeFsPath(root), ...others] } : null;
}

/**
 * 檔案系統的編碼索引：常見位置三層內所有資料夾的「編碼 → 路徑」，快取在 local/cache/encodings.json。
 * maxAgeMs = Infinity 時只讀快取、不重建（SessionStart 用）。
 */
export async function encodingIndex(homes, { maxAgeMs = 86_400_000, extraRoots = [] } = {}) {
  const cachePath = path.join(homes.local, 'cache', 'encodings.json');
  const cached = await readJson(cachePath, null);
  if (cached && (maxAgeMs === Infinity || Date.now() - Date.parse(cached.at ?? 0) < maxAgeMs)) return cached.map ?? {};
  if (maxAgeMs === Infinity) return cached?.map ?? null;
  const map = {};
  const roots = ['Desktop', 'Downloads', 'Documents', 'source', 'repos', 'Projects']
    .map((d) => path.join(homes.userHome, d))
    .concat(fs.existsSync(homes.userHome) ? fs.readdirSync(homes.userHome).filter((n) => /^OneDrive/i.test(n)).map((n) => path.join(homes.userHome, n)) : [])
    .concat(extraRoots)
    .filter((p, i, a) => fs.existsSync(p) && a.findIndex((q) => samePath(q, p)) === i);
  const walk = (dir, depth) => {
    const enc = encodeProjectPath(dir);
    if (enc) (map[enc.toLowerCase()] ??= []).includes(dir) || map[enc.toLowerCase()].push(dir);
    if (depth >= 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const r of roots) walk(normalizeFsPath(r), 0);
  await fsp.mkdir(path.dirname(cachePath), { recursive: true });
  await safeWrite(cachePath, stableJson({ at: new Date().toISOString(), map }));
  return map;
}

/**
 * 同一個編碼、不同路徑時，判斷是「搬家」還是「撞名」（R-25）。
 * - 舊路徑仍存在 → 撞名
 * - 舊路徑不存在 → 新位置的身分（remote、root commit、標記檔）與綁定的專案相符才算搬家
 * @returns {Promise<'same'|'moved'|'collision'|'unknown'>}
 */
export async function classifyEncodedBinding(ctx, binding, root, { withRootCommits = false } = {}) {
  if (!binding?.path || samePath(binding.path, root)) return 'same';
  if (exists(binding.path)) return 'collision';
  const res = await resolveIdentity(ctx, root, { withRootCommits });
  if (res.pid === binding.pid && (res.reason === 'marker' || res.reason === 'settings' || res.reason === 'remote')) return 'moved';
  if (!res.isGit && !markerPid(root)) return 'unknown';
  if (withRootCommits && res.candidates.some((c) => c.pid === binding.pid && c.reason === 'root-commit')) return 'moved';
  return res.pid && res.pid !== binding.pid ? 'collision' : 'unknown';
}

/**
 * 解析資料夾的專案身分。
 * @returns {Promise<{ dir, root, isGit, encoded, pid: string|null, confidence: 'certain'|'high'|'medium'|'none', reason: string,
 *   candidates: {pid, name, reason, score}[], binding: object|null, collision: object|null, remotes: string[], rootCommits: string[] }>}
 */
export async function resolveIdentity(ctx, dir, { withRootCommits = true, fsIndexMaxAgeMs = Infinity } = {}) {
  const { root, git: gitInfo } = memoryRootFor(dir);
  const encoded = encodeProjectPath(root);
  const bindings = await readBindings(ctx.vault, ctx.mid);
  const binding = findBindingByPath(bindings, root) ?? findBindingByEncoded(bindings, encoded);
  const { remotes, rootCommits } = await gitIdentity(gitInfo, { withRootCommits });
  const collision = await detectCollision(ctx.homes, encoded, root, bindings, { fsIndexMaxAgeMs });
  const base = { dir: normalizeFsPath(dir), root, isGit: !!gitInfo, encoded, binding, collision, remotes, rootCommits, candidates: [] };

  const known = async (pid) => (pid && (await readProject(ctx.vault, pid)) ? pid : null);

  if (binding && samePath(binding.path, root) && await known(binding.pid)) return { ...base, pid: binding.pid, confidence: 'certain', reason: 'binding' };
  const mp = await known(markerPid(root));
  if (mp) return { ...base, pid: mp, confidence: 'certain', reason: 'marker' };
  const sp = await known(settingsPid(root, ctx.homes));
  if (sp) return { ...base, pid: sp, confidence: 'certain', reason: 'settings' };

  const projects = [];
  for (const pid of await listProjectIds(ctx.vault)) {
    const p = await readProject(ctx.vault, pid);
    if (p && !p.mergedInto) projects.push(p);
  }
  // R2：remote 完全相同
  const byRemote = projects.filter((p) => (p.remotes ?? []).some((r) => remotes.includes(r)));
  if (byRemote.length === 1) return { ...base, pid: byRemote[0].id, confidence: 'high', reason: 'remote' };
  const candidates = [];
  for (const p of byRemote) candidates.push({ pid: p.id, name: p.name, reason: 'remote', score: 0.95 });
  // R3：root commit 相同（fork 或不同組織）
  for (const p of projects) {
    if (byRemote.includes(p)) continue;
    if ((p.rootCommits ?? []).some((c) => rootCommits.includes(c))) candidates.push({ pid: p.id, name: p.name, reason: 'root-commit', score: 0.85 });
  }
  // R4：非 git，名稱相同或相近 + 第一層檔案相似
  if (!gitInfo) {
    const name = path.basename(root).toLowerCase();
    const entries = topEntries(root);
    for (const p of projects) {
      const names = [p.name, ...(p.aliases ?? [])].map((s) => String(s).toLowerCase());
      const sim = jaccard(entries, p.fingerprint?.entries ?? []);
      if (names.includes(name) && (sim >= 0.6 || !(p.fingerprint?.entries?.length))) candidates.push({ pid: p.id, name: p.name, reason: 'name+entries', score: 0.6 + sim * 0.3 });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length) return { ...base, pid: null, confidence: 'medium', reason: candidates[0].reason, candidates };
  return { ...base, pid: null, confidence: 'none', reason: 'none' };
}

// ───────── 專案登記 ─────────

export async function createProject(ctx, { name, root, remotes = [], rootCommits = [], archived = false }) {
  const pid = makePid(path.basename(root ?? name ?? ''));
  const now = new Date().toISOString();
  const project = {
    id: pid,
    name: name || path.basename(root ?? pid),
    aliases: root ? [path.basename(root)] : [],
    remotes: [...new Set(remotes)].sort(),
    rootCommits: [...new Set(rootCommits)].sort(),
    fingerprint: root && !remotes.length ? { entries: topEntries(root) } : undefined,
    archived,
    createdAt: now,
    updatedAt: now,
  };
  if (!project.fingerprint) delete project.fingerprint;
  await writeProject(ctx.vault, project);
  await fsp.mkdir(projectMemoryDir(ctx.vault, pid), { recursive: true });
  return project;
}

/** adopt：綁到既有的專案（不是這次綁定才建立的），封存專案因此恢復為使用中。 */
async function updateProjectIdentity(ctx, pid, { root, remotes, rootCommits, adopt = true }) {
  const p = await readProject(ctx.vault, pid);
  if (!p) return;
  const before = stableJson(p);
  p.remotes = [...new Set([...(p.remotes ?? []), ...remotes])].sort();
  p.rootCommits = [...new Set([...(p.rootCommits ?? []), ...rootCommits])].sort();
  if (root) {
    const alias = path.basename(root);
    if (!(p.aliases ?? []).includes(alias)) p.aliases = [...(p.aliases ?? []), alias];
    if (!p.remotes.length) p.fingerprint = { entries: topEntries(root) };
    // 封存專案（收編時找不到資料夾）接上了資料夾：恢復為使用中；收編產生的暫定名稱「未歸屬（…）」換成資料夾名稱
    if (adopt && p.archived) p.archived = false;
    if (adopt && /^未歸屬（.+）$/.test(String(p.name))) p.name = alias;
  }
  const { updatedAt, ...rest } = p;
  const { updatedAt: _u, ...restBefore } = JSON.parse(before);
  if (JSON.stringify(rest) !== JSON.stringify(restBefore)) await writeProject(ctx.vault, p);
}

// ───────── 複製記憶進 vault（綁定與收編共用） ─────────

/** 讀來源 MEMORY.md，建立 檔名 → 原本那一行 的對照（保留 Claude 寫的提示語）。 */
async function sourceIndexLines(srcDir) {
  const t = (await readText(path.join(srcDir, PROJECT_INDEX))) ?? '';
  const map = new Map();
  for (const line of t.split(/\r?\n/)) {
    const m = /\[[^\]]*\]\(\.?\/?([^)\s/\\]+\.md)\)/i.exec(line);
    if (m && !map.has(m[1].toLowerCase())) map.set(m[1].toLowerCase(), line);
  }
  return map;
}

/**
 * 把 srcDir 裡的記憶複製到 destDir（vault 內）。相同內容（語意比對）略過；同名不同內容改名。
 * @param {{ files?: string[], dryRun?: boolean }} [opts] files 指定只複製哪些檔
 * @returns {Promise<{ copied: {from, to}[], skipped: {from, dupOf}[], renamed: {from, to}[] }>}
 */
export async function copyMemoriesInto(srcDir, destDir, { files, dryRun = false } = {}) {
  const names = files ?? await listMarkdown(srcDir, { exclude: [PROJECT_INDEX, 'INDEX.md'] });
  const destNames = await listMarkdown(destDir, { exclude: [PROJECT_INDEX, 'INDEX.md'] });
  const destKeys = new Map();
  for (const n of destNames) {
    const t = await readText(path.join(destDir, n));
    if (t !== null) destKeys.set(semanticKey(parseMemoryFile(t)), n);
  }
  const lines = await sourceIndexLines(srcDir);
  const res = { copied: [], skipped: [], renamed: [] };
  const appendLines = [];
  const taken = new Set(destNames.map((n) => n.toLowerCase()));
  for (const n of names) {
    const text = await readText(path.join(srcDir, n));
    if (text === null) continue;
    const key = semanticKey(parseMemoryFile(text));
    if (destKeys.has(key)) { res.skipped.push({ from: n, dupOf: destKeys.get(key) }); continue; }
    const target = uniqueFileName(n, (f) => taken.has(f.toLowerCase()));
    taken.add(target.toLowerCase());
    if (target !== n) res.renamed.push({ from: n, to: target });
    res.copied.push({ from: n, to: target });
    destKeys.set(key, target);
    if (!dryRun) {
      await fsp.mkdir(destDir, { recursive: true });
      await safeWrite(path.join(destDir, target), text);
      const srcLine = lines.get(n.toLowerCase());
      if (srcLine) appendLines.push(target === n ? srcLine : srcLine.replace(`(${n})`, `(${target})`).replace(`(./${n})`, `(${target})`));
    }
  }
  if (!dryRun && appendLines.length) {
    const idx = path.join(destDir, PROJECT_INDEX);
    const cur = (await readText(idx)) ?? '';
    const add = appendLines.filter((l) => !cur.includes(l));
    if (add.length) await safeWrite(idx, `${cur.replace(/\n*$/, cur ? '\n' : '')}${add.join('\n')}\n`);
  }
  return res;
}

/** 逐檔確認複製結果（語意相同即可，避免 frontmatter 被改寫造成誤判）。 */
async function verifyCopied(srcDir, destDir, copied) {
  for (const { from, to } of copied) {
    const a = await readText(path.join(srcDir, from));
    const b = await readText(path.join(destDir, to));
    if (a === null || b === null || sha1(a) !== sha1(b)) {
      if (a === null || b === null || semanticKey(parseMemoryFile(a)) !== semanticKey(parseMemoryFile(b))) return false;
    }
  }
  return true;
}

// ───────── junction ─────────

function memoryPathFor(homes, encoded) {
  return path.join(homes.claudeHome, 'projects', encoded, 'memory');
}

/** 寫一個探針檔確認 junction 可用。 */
function probeJunction(linkPath, targetDir) {
  const name = `.engram-probe-${randomBase32(6)}`;
  try {
    fs.writeFileSync(path.join(linkPath, name), 'probe');
    const ok = fs.existsSync(path.join(targetDir, name));
    fs.rmSync(path.join(targetDir, name), { force: true });
    return ok;
  } catch {
    try { fs.rmSync(path.join(targetDir, name), { force: true }); } catch { /* ignore */ }
    return false;
  }
}

/** junction 狀態：'ok' | 'missing' | 'empty-dir' | 'dir' | 'wrong-target' | 'broken' */
export function junctionState(homes, encoded, pid) {
  const p = memoryPathFor(homes, encoded);
  const want = projectMemoryDir(homes.vault, pid);
  if (isLink(p)) {
    const t = linkTarget(p);
    if (!t || !samePath(t, want)) return { state: 'wrong-target', path: p, target: t };
    return { state: exists(want) ? 'ok' : 'broken', path: p, target: t };
  }
  if (!exists(p)) return { state: 'missing', path: p };
  return { state: isEmptyDir(p) ? 'empty-dir' : 'dir', path: p };
}

function backupRoot(homes) { return path.join(homes.local, 'backups'); }

/**
 * 把編碼資料夾的 memory 換成 junction。
 * mode 'now'：只在 memory 不存在或為空時進行（SessionStart 用，R-06）。
 * mode 'safe'：有內容時依序「複製 → 驗證 → 改名為備份 → 建立 junction → 驗證」，失敗回滾。
 * @returns {Promise<{ state: 'linked'|'already'|'deferred', reason?: string, copied?: object, backup?: string }>}
 */
export async function swapToJunction(ctx, { encoded, pid, mode = 'safe', force = false, preCopied = false, expectFiles = null }) {
  const homes = ctx.homes;
  const memPath = memoryPathFor(homes, encoded);
  const target = projectMemoryDir(homes.vault, pid);
  await fsp.mkdir(target, { recursive: true });
  const st = junctionState(homes, encoded, pid);
  if (st.state === 'ok') return { state: 'already' };
  if (st.state === 'wrong-target' && st.target && !force) {
    throw new EngramError(E.COLLISION, '這個記憶資料夾已綁定到別的專案', '確認是否為碰撞資料夾，或先解除原本的綁定', { encoded, target: st.target });
  }
  if (st.state === 'wrong-target' || st.state === 'broken') fs.rmdirSync(memPath);

  if (st.state === 'missing' || st.state === 'empty-dir' || st.state === 'wrong-target' || st.state === 'broken') {
    if (st.state === 'empty-dir') fs.rmdirSync(memPath);
    createJunction(target, memPath);
    if (!probeJunction(memPath, target)) {
      try { fs.rmdirSync(memPath); } catch { /* ignore */ }
      throw new EngramError(E.INVALID, '建立的 junction 無法寫入', '執行 engram doctor 檢查檔案系統權限');
    }
    // prev／prevTarget：綁定中途失敗時，bind() 依此把記憶資料夾放回切換前的樣子
    return { state: 'linked', prev: st.state, prevTarget: st.target ?? null };
  }

  // 原資料夾有內容
  if (mode === 'now') return { state: 'deferred', reason: 'has-content' };
  const scan = await scanEncodedDir(homes.claudeHome, encoded);
  if (!force && hasActiveSession(scan)) return { state: 'deferred', reason: 'active-session' };

  // preCopied：呼叫端（收編）已依使用者的計畫把內容放進 vault，這裡不再整批複製；原資料夾一樣會完整備份
  // SW-2：切換前比對來源目前的內容與計畫當時的雜湊；規劃後又有新增或修改 → 延後，請使用者重新規劃
  let backupOnly = [];
  if (preCopied && expectFiles) {
    const expected = new Map(expectFiles.map((f) => [f.file.toLowerCase(), f]));
    for (const n of await listMarkdown(memPath, { exclude: [PROJECT_INDEX] })) {
      const e = expected.get(n.toLowerCase());
      const t = await readText(path.join(memPath, n));
      if (!e || (t !== null && sha1(t) !== e.sha1)) return { state: 'deferred', reason: 'changed-since-plan' };
      if (['skip-same', 'superseded', 'skip'].includes(e.action)) backupOnly.push(n);
    }
  }
  const copied = preCopied ? { copied: [], skipped: [], renamed: [] } : await copyMemoriesInto(memPath, target);
  if (!preCopied && !(await verifyCopied(memPath, target, copied.copied))) {
    throw new EngramError(E.INVALID, '複製到 vault 的記憶驗證失敗，已停止切換', '原資料夾未被改動；執行 engram doctor');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(backupRoot(homes), stamp, encoded, 'memory');
  await fsp.mkdir(path.dirname(backup), { recursive: true });
  try {
    fs.renameSync(memPath, backup);
  } catch (err) {
    if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) return { state: 'deferred', reason: 'busy', copied };
    throw err;
  }
  try {
    createJunction(target, memPath);
    if (!probeJunction(memPath, target)) throw new Error('probe failed');
  } catch (err) {
    // 回滾：移除新 junction，把備份改回原名
    try { if (isLink(memPath)) fs.rmdirSync(memPath); } catch { /* ignore */ }
    try { fs.renameSync(backup, memPath); } catch { /* 留給 doctor */ }
    throw new EngramError(E.INVALID, `建立 junction 失敗，已還原原資料夾：${err.message}`, '執行 engram doctor');
  }
  return { state: 'linked', prev: 'has-content', copied, backup, backupOnly: backupOnly.map((n) => path.join(backup, n)) };
}

// ───────── 綁定 ─────────

/**
 * 寫 settings.local.json 的 autoMemoryDirectory，指向 vault 的專案記憶資料夾。保留既有欄位。
 * 回傳這次在使用者資料夾留下的足跡（R-48），解除綁定與還原時依此清乾淨。
 * noGit：SessionStart 用，不啟動 git（exclude 只比對檔案內容，不先問 check-ignore）。
 * @returns {Promise<{ claudeDirCreated: boolean, settingsCreated: boolean, settingsOriginal: string|null, excludeAdded: boolean }>}
 */
export async function writeSettingsBinding(ctx, root, pid, { noGit = false } = {}) {
  const dir = path.join(root, '.claude');
  const p = path.join(root, SETTINGS_LOCAL);
  const claudeDirCreated = !exists(dir);
  const originalText = await readText(p);
  const cur = (await readJson(p, null)) ?? {};
  const want = toTildePath(projectMemoryDir(ctx.vault, pid), ctx.homes.userHome);
  const footprint = { claudeDirCreated, settingsCreated: originalText === null, settingsOriginal: originalText, excludeAdded: false };
  await fsp.mkdir(projectMemoryDir(ctx.vault, pid), { recursive: true });
  if (cur.autoMemoryDirectory !== want) await safeWrite(p, stableJson({ ...cur, autoMemoryDirectory: want }));
  const g = memoryRootFor(root).git;
  const exPath = g ? path.join(g.commonDir, 'info', 'exclude') : null;
  const exBefore = exPath ? await readText(exPath) : null;
  footprint.excludeAdded = await ensureGitExcluded(root, '.claude/settings.local.json', { noGit });
  if (footprint.excludeAdded) footprint.excludeOriginal = exBefore; // null：原本沒有 exclude 檔
  return footprint;
}

/** settings.local.json 目前是否指向這個專案在 vault 的記憶資料夾。 */
function settingsBindingOk(ctx, root, pid) {
  const cur = readJsonSync(path.join(root, SETTINGS_LOCAL), null);
  return cur?.autoMemoryDirectory === toTildePath(projectMemoryDir(ctx.vault, pid), ctx.homes.userHome);
}

/** 第一次綁定的足跡優先（代表「綁定前」的狀態），之後的綁定只補上新增的旗標。 */
function mergeFootprint(prev, next) {
  if (!prev) return next ?? {};
  const out = { ...prev };
  for (const k of ['claudeDirCreated', 'settingsCreated', 'excludeAdded', 'markerCreated']) if (next?.[k] && out[k] === undefined) out[k] = next[k];
  for (const k of ['settingsOriginal', 'excludeOriginal']) if (out[k] === undefined && next && k in next) out[k] = next[k];
  return out;
}

/** 依足跡把資料夾還原成綁定前的樣子：設定檔原本不存在就刪掉、原本存在就寫回原內容；移除 exclude 行、標記檔與空的 .claude。 */
async function cleanupFootprint(root, fp = {}) {
  if (!root || !exists(root)) return;
  const settings = path.join(root, SETTINGS_LOCAL);
  if (exists(settings)) {
    const cur = await readJson(settings, null);
    if (fp.settingsCreated) {
      // 只剩我們寫的那個鍵 → 刪檔；使用者後來又加了別的設定 → 只移除我們的鍵
      if (cur && Object.keys(cur).every((k) => k === 'autoMemoryDirectory')) fs.rmSync(settings, { force: true });
      else await removeSettingsBinding(root);
    } else if (typeof fp.settingsOriginal === 'string') {
      let orig = null;
      try { orig = JSON.parse(fp.settingsOriginal.replace(/^\uFEFF/, '')); } catch { /* 原檔不是 JSON */ }
      const rest = { ...(cur ?? {}) };
      delete rest.autoMemoryDirectory;
      // 除了我們的鍵以外和原檔相同 → 逐位元寫回原檔
      if (orig && !('autoMemoryDirectory' in orig) && JSON.stringify(rest) === JSON.stringify(orig)) await safeWrite(settings, fp.settingsOriginal);
      else await removeSettingsBinding(root);
    } else {
      await removeSettingsBinding(root);
    }
  }
  if (fp.excludeAdded) {
    const g = memoryRootFor(root).git;
    if (g) {
      const ex = path.join(g.commonDir, 'info', 'exclude');
      const cur = await readText(ex);
      if (cur !== null) {
        const block = '# Engram：本機設定不進 repo\n/.claude/settings.local.json\n';
        // 加入之後沒人動過 → 逐位元寫回原檔；否則只移除我們那兩行
        const orig = typeof fp.excludeOriginal === 'string' ? fp.excludeOriginal : null;
        const padded = orig === null ? null : `${orig.replace(/\n*$/, orig ? '\n' : '')}${block}`;
        const next = orig !== null && cur === padded ? orig : cur.replace(block, '');
        // 原本沒有 exclude 檔（excludeOriginal 為 null），移除我們那兩行後是空的 → 刪掉，回到原狀
        if (fp.excludeOriginal === null && next === '') fs.rmSync(ex, { force: true });
        else if (next !== cur) await safeWrite(ex, next);
      }
    }
  }
  if (fp.markerCreated) fs.rmSync(path.join(root, MARKER), { force: true });
  const dir = path.join(root, '.claude');
  if (fp.claudeDirCreated && exists(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

async function removeSettingsBinding(root) {
  const p = path.join(root, SETTINGS_LOCAL);
  const cur = await readJson(p, null);
  if (!cur || !('autoMemoryDirectory' in cur)) return;
  delete cur.autoMemoryDirectory;
  await safeWrite(p, stableJson(cur));
}

/** 確保檔案不會進團隊 repo：只寫 .git/info/exclude（本機有效，不改 .gitignore）。 */
async function ensureGitExcluded(root, rel, { noGit = false } = {}) {
  const g = memoryRootFor(root).git;
  if (!g) return false;
  if (!noGit) {
    const r = await git(['check-ignore', '-q', rel], { cwd: g.root, allowFail: true, timeoutMs: 5_000 });
    if (r.code === 0) return false;
  }
  const ex = path.join(g.commonDir, 'info', 'exclude');
  const cur = (await readText(ex)) ?? '';
  if (cur.split(/\r?\n/).includes(`/${rel}`)) return false;
  await fsp.mkdir(path.dirname(ex), { recursive: true });
  await safeWrite(ex, `${cur.replace(/\n*$/, cur ? '\n' : '')}# Engram：本機設定不進 repo\n/${rel}\n`);
  return true;
}

/**
 * 綁定資料夾到專案。
 * @param {object} ctx
 * @param {string} dir
 * @param {{ pid?: string, create?: { name?: string, archived?: boolean } }} target
 * @param {{ mode?: 'now'|'safe', force?: boolean, preCopied?: boolean }} [opts]
 */
export async function bind(ctx, dir, target = {}, { mode = 'safe', force = false, preCopied = false, expectFiles = null, importTag = null, sessionEnded = false } = {}) {
  return ctx.locked('identity.bind', async () => {
    const res = await resolveIdentity(ctx, dir, { fsIndexMaxAgeMs: 60_000 });
    const { root, encoded, remotes, rootCommits } = res;
    if (!encoded) throw new EngramError(E.INVALID, '路徑太長（超過 200 字元），無法推算 Claude Code 的記憶資料夾', '請把專案移到較短的路徑');
    let pid = target.pid ?? null;
    let created = null;
    if (!pid && !target.create) pid = res.pid;
    if (!pid) {
      created = await createProject(ctx, { name: target.create?.name, root, remotes, rootCommits, archived: !!target.create?.archived });
      pid = created.id;
    } else if (!(await readProject(ctx.vault, pid))) {
      throw new EngramError(E.NOT_FOUND, `找不到專案：${pid}`);
    }
    // 綁定是一個整體：中途失敗（commit 被擋、檔案被占用、磁碟滿）時撤銷這次已做的部分再拋出錯誤。
    // 否則記憶資料夾已換成 junction、呼叫端（例如匯入）卻不知道，「還原到匯入前」就無法把它換回來。
    // 撤銷要逐位元回到綁定前，不能用「移除 Engram 的綁定」的語意：這個資料夾可能本來就已經綁定好了（重新綁定）
    const projectFile = path.join(projectDir(ctx.vault, pid), 'project.json');
    const indexFile = path.join(projectMemoryDir(ctx.vault, pid), PROJECT_INDEX);
    const before = {
      created, projectFile, indexFile,
      project: created ? null : await readText(projectFile),
      index: created ? null : await readText(indexFile), // 非 preCopied 時複製記憶會重建專案的 MEMORY.md
      claudeDir: exists(path.join(root, '.claude')),
      marker: res.isGit ? undefined : await readText(path.join(root, MARKER)),
      readAllowed: await isJunctionReadAllowed(ctx.homes, memoryPathFor(ctx.homes, encoded)),
      settings: null, // writeSettingsBinding 執行後才有：{ settingsCreated, settingsOriginal, excludeAdded, excludeOriginal }
      bindings: null,
    };
    let method = 'junction';
    let swap = null;
    let split = null;
    let footprint = {};
    try {
    await updateProjectIdentity(ctx, pid, { root, remotes, rootCommits, adopt: !created });

    const touched = [toRef(ctx.vault, projectFile)];
    if (res.collision) {
      method = 'settings';
      footprint = await writeSettingsBinding(ctx, root, pid);
      before.settings = footprint;
      // 同一個編碼已有別的資料夾用 junction 綁定 → 那一個也要改成設定檔備援，否則從子資料夾啟動時會讀到別人的記憶
      const other = (await readBindings(ctx.vault, ctx.mid));
      const j = findBindingByEncoded(other, encoded);
      if (j?.method === 'junction' && !samePath(j.path, root)) split = await splitCollision(ctx, encoded);
    } else {
      // R-52：一律寫設定檔，從專案根目錄啟動時直接指向 vault，不經過 junction
      footprint = await writeSettingsBinding(ctx, root, pid);
      before.settings = footprint;
      if (await junctionAllowed(ctx, root)) {
        // sessionEnded：常駐程式收到 SessionEnd 時呼叫，不必再等「30 分鐘沒有更新」
        swap = await swapToJunction(ctx, { encoded, pid, mode, force: force || sessionEnded, preCopied, expectFiles });
        // R-24：互動模式透過 junction 讀記憶會被詢問；把 junction 路徑本身列入使用者層 additionalDirectories
        if (swap.state !== 'deferred') await allowJunctionRead(ctx.homes, memoryPathFor(ctx.homes, encoded));
        if (swap.copied?.copied?.length) {
          await normalizeProjectIndex(projectMemoryDir(ctx.vault, pid), { skipRecentMs: 0 });
          touched.push(toRef(ctx.vault, projectMemoryDir(ctx.vault, pid)));
        }
      } else {
        // 預設權限模式不允許 junction：只用設定檔；原本的記憶資料夾不動，裡面的記憶由收編（H05）處理
        method = 'settings';
      }
    }
    if (!res.isGit) {
      const marker = path.join(root, MARKER);
      if (footprint.claudeDirCreated === undefined) footprint.claudeDirCreated = !exists(path.join(root, '.claude'));
      const vaultId = (await readJson(path.join(ctx.vault, 'engram.json'), {}))?.vaultId;
      const cur = await readJson(marker, null);
      if (cur === null) footprint.markerCreated = true;
      if (cur?.pid !== pid) await safeWrite(marker, stableJson({ pid, vault: vaultId ?? null }));
    }
    const deferred = swap?.state === 'deferred';
    const bindings = await readBindings(ctx.vault, ctx.mid);
    before.bindings = JSON.parse(JSON.stringify(bindings));
    const key = bindingKey(encoded, method, root);
    const prevFootprint = Object.values(bindings).find((v) => v?.path && samePath(v.path, root))?.footprint;
    // 同一個資料夾換了綁定方式時，移除舊的那筆
    for (const [k, v] of Object.entries(bindings)) if (k !== key && v?.path && samePath(v.path, root)) delete bindings[k];
    const prev = bindings[key];
    bindings[key] = {
      pid,
      path: root,
      encoded,
      method,
      // 只用設定檔的原因：撞名（collision: true），或權限模式不允許 junction（false）
      collision: !!res.collision,
      state: deferred ? 'pending' : 'active',
      ...(deferred ? { reason: swap.reason } : {}),
      // 綁定在使用者資料夾留下的足跡（R-48）；同一個資料夾重新綁定時保留第一次的紀錄
      footprint: mergeFootprint(prevFootprint, footprint),
      boundAt: prev?.pid === pid && prev.boundAt ? prev.boundAt : new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
    };
    await writeBindings(ctx.vault, ctx.mid, bindings);
    touched.push(`machines/${ctx.mid}/bindings.json`);
    const project = await readProject(ctx.vault, pid);
    const commit = await commitPaths(ctx.vault, touched, `bind ${project?.name ?? pid} (${pid})`, { action: 'bind', refs: touched, mid: ctx.mid, trailers: { 'Engram-Import': importTag } });
    return {
      ok: true,
      pid,
      created: !!created,
      method,
      split: split?.state,
      state: bindings[key].state,
      deferredReason: deferred ? swap.reason : undefined,
      copied: swap?.copied ? { copied: swap.copied.copied.length, skipped: swap.copied.skipped.length } : undefined,
      backup: swap?.backup,
      backupOnly: swap?.backupOnly?.length ? swap.backupOnly : undefined,
      encoded,
      commit: commit ?? undefined,
      undo: commit ? { sha: commit.sha } : undefined,
    };
    } catch (err) {
      await undoPartialBind(ctx, { root, encoded, pid, swap, before }).catch(() => {});
      throw err;
    }
  });
}

/**
 * 撤銷一次中途失敗的綁定，逐位元回到綁定前：記憶資料夾（junction 換回原資料夾、原本的空資料夾或舊 junction）、
 * 這次複製進 vault 的檔案、additionalDirectories、設定檔、exclude、標記檔、綁定表與專案登記。
 * 已經 commit 的事（撞名時先執行的 splitCollision）不在此列：那是獨立、正確的修正。
 */
async function undoPartialBind(ctx, { root, encoded, pid, swap, before }) {
  if (swap?.state === 'linked') {
    const memPath = memoryPathFor(ctx.homes, encoded);
    if (isLink(memPath)) fs.rmdirSync(memPath);
    if (swap.backup && exists(swap.backup) && !exists(memPath)) fs.renameSync(swap.backup, memPath);
    else if (swap.prev === 'empty-dir' && !exists(memPath)) fs.mkdirSync(memPath);
    else if (['wrong-target', 'broken'].includes(swap.prev) && swap.prevTarget && !exists(memPath)) createJunction(swap.prevTarget, memPath);
    for (const c of swap.copied?.copied ?? []) fs.rmSync(path.join(projectMemoryDir(ctx.vault, pid), c.to), { force: true }); // 這次新複製、還沒 commit 的
    if (!before.readAllowed) await revokeJunctionRead(ctx.homes, memPath).catch(() => {});
  }
  if (before.settings) {
    const s = before.settings;
    const p = path.join(root, SETTINGS_LOCAL);
    if (s.settingsCreated) fs.rmSync(p, { force: true });
    else if (typeof s.settingsOriginal === 'string' && (await readText(p)) !== s.settingsOriginal) await safeWrite(p, s.settingsOriginal);
    const g = s.excludeAdded ? memoryRootFor(root).git : null;
    if (g) {
      const ex = path.join(g.commonDir, 'info', 'exclude');
      if (s.excludeOriginal === null) fs.rmSync(ex, { force: true }); // 原本沒有 exclude 檔
      else await safeWrite(ex, s.excludeOriginal ?? '');
    }
  }
  if (before.marker !== undefined) {
    const marker = path.join(root, MARKER);
    if (before.marker === null) fs.rmSync(marker, { force: true });
    else if ((await readText(marker)) !== before.marker) await safeWrite(marker, before.marker);
  }
  const dir = path.join(root, '.claude');
  if (!before.claudeDir && exists(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  if (before.bindings) await writeBindings(ctx.vault, ctx.mid, before.bindings);
  if (before.created) fs.rmSync(path.dirname(before.projectFile), { recursive: true, force: true });
  else {
    if (before.project !== null) await safeWrite(before.projectFile, before.project);
    if (before.index === null) fs.rmSync(before.indexFile, { force: true });
    else if ((await readText(before.indexFile)) !== before.index) await safeWrite(before.indexFile, before.index);
  }
}

/**
 * 撞名事後才被發現（R-25）：把用 junction 綁定的編碼資料夾改成「設定檔備援」，讓兩個資料夾的記憶分開。
 * 只在沒有進行中的對話時執行；被誤寫進原專案的記憶由健康檢查 H19 逐筆提示，不自動搬移。
 * @returns {Promise<{ ok: boolean, state: 'converted'|'deferred'|'noop', reason?: string }>}
 */
export async function splitCollision(ctx, encoded, { force = false } = {}) {
  return ctx.locked('identity.split', async () => {
    const bindings = await readBindings(ctx.vault, ctx.mid);
    const b = findBindingByEncoded(bindings, encoded);
    if (!b || b.method !== 'junction') return { ok: true, state: 'noop' };
    const scan = await scanEncodedDir(ctx.homes.claudeHome, b.encoded);
    if (!force && hasActiveSession(scan, 5 * 60_000)) return { ok: true, state: 'deferred', reason: 'active-session' };
    const memPath = memoryPathFor(ctx.homes, b.encoded);
    if (isLink(memPath)) fs.rmdirSync(memPath); // 只移除 junction 本身
    await fsp.mkdir(memPath, { recursive: true });
    await revokeJunctionRead(ctx.homes, memPath).catch(() => {});
    const fp = exists(b.path) ? await writeSettingsBinding(ctx, b.path, b.pid) : {};
    const { key, ...entry } = b;
    delete bindings[key];
    bindings[bindingKey(b.encoded, 'settings', b.path)] = { ...entry, encoded: b.encoded, method: 'settings', collision: true, state: 'active', footprint: mergeFootprint(b.footprint, fp), splitAt: new Date().toISOString() };
    await writeBindings(ctx.vault, ctx.mid, bindings);
    const st = await readJson(path.join(ctx.local, 'state.json'), {});
    if (st?.pendingSplits?.length) {
      const { updateState } = await import('./vault.mjs');
      await updateState(ctx.local, { pendingSplits: st.pendingSplits.filter((p) => p.encoded.toLowerCase() !== b.encoded.toLowerCase()) });
    }
    await commitPaths(ctx.vault, [`machines/${ctx.mid}/bindings.json`], `split collision ${b.encoded}`, { action: 'bind', mid: ctx.mid });
    return { ok: true, state: 'converted' };
  });
}

/**
 * 依目前的預設權限模式（逐一含專案層設定）收斂這台電腦的所有綁定（R-52），常駐程式定期呼叫：
 * - 不允許 junction：拆掉 junction，改成只用設定檔（從根目錄啟動照常可用）；有進行中的對話就延後。
 * - 允許 junction：非撞名、只用設定檔的綁定補上 junction（原資料夾有內容時照 swapToJunction 的規則複製、備份或延後）。
 * - 每個綁定都確認設定檔仍指向 vault；舊版只有 junction 的綁定在這裡補上設定檔。
 * 沒有要改的時候只讀檔，不呼叫 git、不 commit。
 * junction：這台電腦（使用者層）的預設模式是否允許；個別專案可能被專案層設定覆蓋。
 * @returns {Promise<{ ok: true, junction: boolean, changed: object[], deferred: object[] }>}
 */
export async function reconcile(ctx, { force = false } = {}) {
  const machineAllowed = await junctionAllowed(ctx);
  return ctx.locked('identity.reconcile', async () => {
    const bindings = await readBindings(ctx.vault, ctx.mid);
    const changed = [];
    const deferred = [];
    const touched = [`machines/${ctx.mid}/bindings.json`];
    for (const view of allBindingViews(bindings)) {
      let b = view;
      if (!b.path || !exists(b.path)) continue;
      // R-54：舊版第一次從 git 子資料夾開啟時，把綁定（與 junction）放在子資料夾的編碼；Claude Code 用的是根目錄的編碼。
      // 拆掉放錯位置的 junction 與 additionalDirectories，改回根目錄的編碼，再照下面的規則重新收斂。
      const want = encodeProjectPath(b.path);
      if (want && want.toLowerCase() !== b.encoded.toLowerCase()) {
        const wrong = memoryPathFor(ctx.homes, b.encoded);
        if (isLink(wrong)) fs.rmdirSync(wrong); // 只移除 junction 本身；Claude Code 不會從這裡讀記憶
        await revokeJunctionRead(ctx.homes, wrong).catch(() => {});
        const { key: oldKey, ...rest } = b;
        delete bindings[oldKey];
        delete rest.reason;
        const other = findBindingByEncoded(bindings, want);
        changed.push({ pid: b.pid, path: b.path, from: b.method, to: 'settings', encoded: { from: b.encoded, to: want } });
        if (other && samePath(other.path, b.path)) continue; // 同一個資料夾已有正確的綁定：放錯的這筆直接移除
        // 根目錄的編碼已被別的資料夾用 junction 綁定 → 撞名，只能用設定檔
        const fixed = { ...rest, encoded: want, method: 'settings', collision: !!other, state: 'active' };
        const newKey = bindingKey(want, 'settings', b.path);
        bindings[newKey] = fixed;
        b = { ...fixed, key: newKey };
      }
      const memPath = memoryPathFor(ctx.homes, b.encoded);
      const { key, ...entry } = b;
      const allowed = await junctionAllowed(ctx, b.path);
      if (b.method === 'junction' && !allowed) {
        const scan = await scanEncodedDir(ctx.homes.claudeHome, b.encoded);
        if (!force && hasActiveSession(scan, 5 * 60_000)) { deferred.push({ path: b.path, pid: b.pid, reason: 'active-session' }); continue; }
        if (isLink(memPath)) {
          fs.rmdirSync(memPath); // 只移除 junction 本身；記憶都在 vault
          await fsp.mkdir(memPath, { recursive: true });
        }
        await revokeJunctionRead(ctx.homes, memPath).catch(() => {});
        const fp = await writeSettingsBinding(ctx, b.path, b.pid);
        delete bindings[key];
        delete entry.reason;
        bindings[bindingKey(b.encoded, 'settings', b.path)] = { ...entry, method: 'settings', collision: false, state: 'active', footprint: mergeFootprint(b.footprint, fp) };
        changed.push({ pid: b.pid, path: b.path, from: 'junction', to: 'settings' });
        continue;
      }
      if (b.method === 'settings' && b.collision === false && allowed) {
        // 綁定之後才出現撞名的話，不能建 junction（會讓兩個資料夾共用記憶）
        const res = await resolveIdentity(ctx, b.path, { withRootCommits: false });
        if (res.collision) {
          bindings[key] = { ...entry, collision: true };
          changed.push({ pid: b.pid, path: b.path, from: 'settings', to: 'settings', collision: true });
          continue;
        }
        const swap = await swapToJunction(ctx, { encoded: b.encoded, pid: b.pid, mode: 'safe', force });
        const linked = swap.state !== 'deferred';
        if (linked) await allowJunctionRead(ctx.homes, memPath);
        if (swap.copied?.copied?.length) {
          await normalizeProjectIndex(projectMemoryDir(ctx.vault, b.pid), { skipRecentMs: 0 });
          touched.push(toRef(ctx.vault, projectMemoryDir(ctx.vault, b.pid)));
        }
        delete bindings[key];
        bindings[bindingKey(b.encoded, 'junction', b.path)] = { ...entry, method: 'junction', collision: false, state: linked ? 'active' : 'pending', ...(linked ? {} : { reason: swap.reason }) };
        changed.push({ pid: b.pid, path: b.path, from: 'settings', to: 'junction', state: linked ? 'active' : 'pending' });
        if (!linked) deferred.push({ path: b.path, pid: b.pid, reason: swap.reason });
        continue;
      }
      if (!settingsBindingOk(ctx, b.path, b.pid)) {
        const fp = await writeSettingsBinding(ctx, b.path, b.pid);
        bindings[key] = { ...entry, footprint: mergeFootprint(b.footprint, fp) };
        changed.push({ pid: b.pid, path: b.path, from: b.method, to: b.method, settings: 'written' });
      }
    }
    if (changed.length) {
      await writeBindings(ctx.vault, ctx.mid, bindings);
      await commitPaths(ctx.vault, touched, `reconcile bindings (${changed.length} changed)`, { action: 'bind', mid: ctx.mid });
    }
    return { ok: true, junction: machineAllowed, changed, deferred };
  });
}

/** 解除綁定：移除 junction，並把記憶複製回原本的資料夾，讓 Claude Code 照常運作。 */
export async function unbind(ctx, dir) {
  return ctx.locked('identity.unbind', async () => {
    const { root } = memoryRootFor(dir);
    const bindings = await readBindings(ctx.vault, ctx.mid);
    const b = findBindingByPath(bindings, root) ?? findBindingByEncoded(bindings, encodeProjectPath(root));
    if (!b) throw new EngramError(E.NOT_BOUND, '這個資料夾沒有綁定到 Engram');
    const memPath = memoryPathFor(ctx.homes, b.encoded);
    if (b.method === 'junction') await revokeJunctionRead(ctx.homes, memPath);
    if (b.method === 'junction' && isLink(memPath)) {
      fs.rmdirSync(memPath); // 只移除 junction 本身
      await fsp.mkdir(memPath, { recursive: true });
      const src = projectMemoryDir(ctx.vault, b.pid);
      for (const n of await listMarkdown(src)) await fsp.copyFile(path.join(src, n), path.join(memPath, n));
    }
    if (b.method === 'settings' && b.collision === false && !isLink(memPath)) {
      // R-52：只用設定檔綁定（非撞名）的專案，記憶都在 vault；解除後 Claude Code 回到原本的資料夾，把記憶複製回去。
      // 原資料夾裡內容不同的同名檔先改名保留，不刪除任何東西。
      await fsp.mkdir(memPath, { recursive: true });
      const src = projectMemoryDir(ctx.vault, b.pid);
      for (const n of await listMarkdown(src)) {
        const dest = path.join(memPath, n);
        const text = await readText(path.join(src, n));
        const cur = await readText(dest);
        if (cur === text) continue;
        if (cur !== null) fs.renameSync(dest, `${dest}.engram-${Date.now()}`);
        await fsp.writeFile(dest, text);
      }
    }
    if (b.footprint) await cleanupFootprint(root, b.footprint);
    else {
      if (b.method === 'settings') await removeSettingsBinding(root);
      try { fs.rmSync(path.join(root, MARKER), { force: true }); } catch { /* ignore */ }
    }
    delete bindings[b.key];
    await writeBindings(ctx.vault, ctx.mid, bindings);
    const commit = await commitPaths(ctx.vault, [`machines/${ctx.mid}/bindings.json`], `unbind ${b.pid} @ ${path.basename(root)}`, { action: 'unbind', mid: ctx.mid });
    return { ok: true, pid: b.pid, commit: commit ?? undefined, undo: undefined };
  });
}

export { memoryPathFor, cleanupFootprint, mergeFootprint };
