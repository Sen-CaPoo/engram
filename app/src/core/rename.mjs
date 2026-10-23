// 撞名資料夾的系統化改名（40 號 §08、SW-4）。
// Claude Code 把資料夾路徑裡英數以外的字元都換成「-」：同一層、字數相同的中文資料夾（或只差在符號的英文資料夾）
// 會共用同一份記憶與對話紀錄。用過 Claude Code 的資料夾，只要和任何現存的資料夾編碼相同，就依規則改名為
// 「原名-4 碼代號」：代號由原路徑算出、固定不變，中文名稱照樣看得到，編碼不再相同。
// 改名時一併處理：
//   1. 重新綁定：不再撞名，auto 模式可以改用 junction（從子資料夾啟動也讀得到記憶）
//   2. 記憶裡寫到的舊路徑：只改這台電腦寫的（另一台電腦寫的路徑指的是那台的資料夾）
//   3. 共用的舊記憶資料夾：用過它的資料夾都改名、裡面的記憶也都收編完，就移到備份，
//      之後在同編碼的資料夾開 Claude Code 不會讀到別的專案的記憶
// 每一批改名記在 vault 的 machines/<mid>/renames.json（commit 帶 Engram-Rename 標記），可以整批還原。
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { allowJunctionRead, revokeJunctionRead } from './claudesettings.mjs';
import { E, EngramError } from './errors.mjs';
import { createJunction, exists, isLink, linkTarget, listMarkdown, readJson, readJsonSync, readText, safeWrite, sha1, writeJson } from './fsx.mjs';
import { bind, encodingIndex, memoryPathFor, mergeFootprint } from './identity.mjs';
import { refreshIndex, scopeOfRef } from './memories.mjs';
import { encodeProjectPath, normalizeFsPath, samePath } from './paths.mjs';
import { readSweepLog } from './sweep.mjs';
import { hasActiveSession, scanAll, scanEncodedDir } from './transcripts.mjs';
import { allBindingViews, commitPaths, findBindingByPath, machineDir, memoryOwners, readBindings, writeBindings } from './vault.mjs';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // 不含 i、l、o、u，避免看錯
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EEXIST']);

/** 由路徑算出的代號（不分大小寫；同一個資料夾永遠得到同一個代號）。 */
export function collisionCode(absPath, length = 4) {
  const h = crypto.createHash('sha1').update(normalizeFsPath(absPath).toLowerCase()).digest();
  let s = '';
  for (let i = 0; i < length; i++) s += ALPHABET[h[i] % ALPHABET.length];
  return s;
}

/** 依命名規則產生新路徑。新名稱的編碼不可與任何已知資料夾相同；極少數情況加長代號。 */
export function collisionSafePath(absPath, takenEncodings) {
  const dir = path.dirname(absPath);
  const base = path.basename(absPath);
  for (let n = 4; n <= 12; n++) {
    const next = path.join(dir, `${base}-${collisionCode(absPath, n)}`);
    const enc = encodeProjectPath(next);
    if (enc && !takenEncodings.has(enc.toLowerCase()) && !exists(next)) return next;
  }
  return null;
}

const under = (p, dir) => !!p && !!dir && normalizeFsPath(p).toLowerCase().startsWith(`${normalizeFsPath(dir).toLowerCase()}${path.sep}`);

// 系統資料夾（任何深度；OneDrive 重新導向的 Desktop 等在第二層）不改
const SHELL_FOLDERS = new Set(['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos', 'favorites', 'links', 'contacts', 'saved games', 'searches', '3d objects', 'appdata']);
const RECENT_MS = 30 * 60_000;
// .claude 是 Engram／Claude Code 自己寫的設定（綁定時剛寫入），不代表使用者正在編輯
const SKIP_SCAN = new Set(['.git', '.claude', 'node_modules', '.venv', 'venv', '__pycache__']);

/** 資料夾裡（兩層內）最近修改的時間：有編輯器開著或程式在寫入時，改名後可能在舊路徑重建出另一份 */
function lastActivityMs(dir, depth = 2) {
  let last = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (SKIP_SCAN.has(e.name.toLowerCase())) continue;
    const p = path.join(dir, e.name);
    try { last = Math.max(last, fs.statSync(p).mtimeMs); } catch { /* 讀不到就略過 */ }
    if (e.isDirectory() && depth > 1) last = Math.max(last, lastActivityMs(p, depth - 1));
  }
  return last;
}

/** dir 或它三層內的子資料夾有沒有符合 test 的；大型資料夾（SKIP_SCAN）只看本身、不往下找 */
function someDir(dir, test, depth = 3) {
  if (test(dir)) return true;
  if (depth <= 0) return false;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const child = path.join(dir, e.name);
    if (SKIP_SCAN.has(e.name.toLowerCase()) ? test(child) : someDir(child, test, depth - 1)) return true;
  }
  return false;
}

/** 有 worktree 的主 repo，或 worktree 本身：兩邊互相記著對方的絕對路徑 */
function worktreeLinked(dir) {
  const dotGit = path.join(dir, '.git');
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) return fs.readdirSync(path.join(dotGit, 'worktrees')).length > 0;
    return /[\\/]worktrees[\\/]/.test(fs.readFileSync(dotGit, 'utf8'));
  } catch { return false; }
}

/** Python 虛擬環境寫死了絕對路徑，改名後就不能用 */
const isPythonVenv = (dir) => exists(path.join(dir, 'pyvenv.cfg'));

/** Claude Code 依絕對路徑記在 ~/.claude.json 的專案設定（MCP 伺服器、允許的工具）：改名後會遺失，交給使用者決定 */
function claudeProjectSettings(ctx, dir) {
  const cfg = readJsonSync(path.join(ctx.homes.userHome, '.claude.json'), null);
  const want = normalizeFsPath(dir).toLowerCase().split(path.sep).join('/');
  const entry = Object.entries(cfg?.projects ?? {}).find(([k]) => k.replace(/\\/g, '/').toLowerCase() === want)?.[1];
  const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.keys(v).length > 0 : false);
  return !!entry && ['mcpServers', 'allowedTools', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'mcpContextUris'].some((k) => nonEmpty(entry[k]));
}

/** 不改名的原因；可以改時回傳 null。 */
async function blockedReason(ctx, p, encoded, usedPaths, now = Date.now()) {
  const home = normalizeFsPath(ctx.homes.userHome);
  if (!under(p, home)) return 'outside-home'; // 只改家目錄底下的資料夾（編碼索引也只涵蓋這裡）
  if (samePath(path.dirname(p), home)) return 'top-level'; // Desktop、Documents 這一層
  for (const d of [ctx.homes.home, ctx.homes.claudeHome]) if (d && (samePath(p, d) || under(p, d))) return 'engram-or-claude';
  const segs = path.relative(home, p).split(path.sep);
  if (segs.some((s) => /^onedrive/i.test(s))) return 'onedrive'; // 同步中的資料夾：兩台各自改名會產生衝突副本
  if (SHELL_FOLDERS.has(segs.at(-1).toLowerCase())) return 'system-folder';
  if (usedPaths.some((q) => under(q, p))) return 'contains-projects'; // 改名會連帶移動裡面的其他專案
  const dotGit = path.join(p, '.git');
  if (exists(dotGit) && fs.statSync(dotGit).isFile()) return 'git-worktree'; // worktree／submodule 的登記在別處，改名會失效
  if (someDir(p, worktreeLinked)) return 'git-worktree'; // 主 repo 與 worktree 互記絕對路徑（含子資料夾裡的 repo）
  if (someDir(p, isPythonVenv)) return 'python-venv';
  if (claudeProjectSettings(ctx, p)) return 'claude-project-settings';
  if (hasActiveSession(await scanEncodedDir(ctx.homes.claudeHome, encoded))) return 'active-session';
  if (now - lastActivityMs(p) < RECENT_MS) return 'recent-activity';
  return null;
}

export const BLOCKED_LABEL = {
  'outside-home': '不在使用者資料夾底下',
  'top-level': '是使用者資料夾第一層（例如 Desktop）',
  'engram-or-claude': '是 Engram 或 Claude Code 自己的資料夾',
  'contains-projects': '裡面還有其他專案，改名會連帶移動它們',
  'git-worktree': '是 git worktree、submodule，或有 worktree 的主 repo（worktree 記的是絕對路徑）',
  onedrive: '在 OneDrive 底下（兩台電腦各自改名會產生衝突副本）',
  'system-folder': '是系統資料夾（Desktop、Documents 等）',
  'python-venv': '裡面有 Python 虛擬環境（寫死了絕對路徑，改名後不能用）',
  'claude-project-settings': 'Claude Code 為這個資料夾記了 MCP 伺服器或允許的工具（改名後會遺失）',
  'active-session': '30 分鐘內有對話在使用',
  'recent-activity': '30 分鐘內有檔案被修改（可能有編輯器開著）',
  busy: '資料夾被其他程式開著',
  'no-name': '找不到不撞名的新名稱',
};

/** BLOCKED_LABEL 的英文版（鍵相同；管理介面切到英文時用） */
export const BLOCKED_LABEL_EN = {
  'outside-home': 'not under your user folder',
  'top-level': 'a first-level folder of your user folder (for example Desktop)',
  'engram-or-claude': "Engram's or Claude Code's own folder",
  'contains-projects': 'contains other projects, and renaming would move them too',
  'git-worktree': 'a git worktree, a submodule, or a main repo that has worktrees (worktrees record absolute paths)',
  onedrive: 'under OneDrive (renaming on each computer would create conflicting copies)',
  'system-folder': 'a system folder (Desktop, Documents, etc.)',
  'python-venv': 'contains a Python virtual environment (it hard-codes absolute paths and would break after renaming)',
  'claude-project-settings': 'Claude Code has MCP servers or allowed tools recorded for this folder (they would be lost after renaming)',
  'active-session': 'a conversation used it within the last 30 minutes',
  'recent-activity': 'a file was modified within the last 30 minutes (an editor may be open)',
  busy: 'the folder is open in another program',
  'no-name': 'could not find a new name that does not collide',
};

/**
 * 盤點撞名：用過 Claude Code 的資料夾（對話紀錄的根目錄、這台電腦的綁定）中，和任何現存資料夾編碼相同的。
 * @returns {Promise<{ path, encoded, others: string[], binding: {key,pid,method}|null, to: string|null, blocked: string|null }[]>}
 */
export async function planCollisionRenames(ctx, { indexMaxAgeMs = 0 } = {}) {
  const homes = ctx.homes;
  const idx = (await encodingIndex(homes, { maxAgeMs: indexMaxAgeMs })) ?? {};
  const scans = await scanAll(homes.claudeHome);
  const views = allBindingViews(await readBindings(ctx.vault, ctx.mid));
  const used = new Map();
  for (const p of [...scans.flatMap((s) => s.roots), ...views.map((v) => v.path)]) {
    if (p && exists(p) && !used.has(normalizeFsPath(p).toLowerCase())) used.set(normalizeFsPath(p).toLowerCase(), normalizeFsPath(p));
  }
  const usedPaths = [...used.values()];
  // 新名稱的編碼不可和已知資料夾、或 ~/.claude/projects 裡既有的編碼資料夾相同（後者可能留著舊的對話與記憶）
  const taken = new Set(Object.keys(idx));
  try { for (const n of fs.readdirSync(path.join(homes.claudeHome, 'projects'))) taken.add(n.toLowerCase()); } catch { /* 沒有 projects 資料夾 */ }
  const items = [];
  for (const p of usedPaths.sort((a, b) => a.localeCompare(b))) {
    const encoded = encodeProjectPath(p);
    if (!encoded) continue;
    const others = new Map();
    for (const q of [...(idx[encoded.toLowerCase()] ?? []), ...usedPaths]) {
      if (!samePath(q, p) && exists(q) && encodeProjectPath(q)?.toLowerCase() === encoded.toLowerCase()) others.set(q.toLowerCase(), normalizeFsPath(q));
    }
    if (!others.size) continue;
    const b = views.find((v) => v.path && samePath(v.path, p));
    let blocked = await blockedReason(ctx, p, encoded, usedPaths);
    let to = null;
    if (!blocked) {
      to = collisionSafePath(p, taken);
      if (to) taken.add(encodeProjectPath(to).toLowerCase());
      else blocked = 'no-name';
    }
    items.push({ path: p, encoded, others: [...others.values()], binding: b ? { key: b.key, pid: b.pid, method: b.method } : null, to, blocked });
  }
  return items;
}


// ───────── 記憶裡的路徑 ─────────

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// 路徑前面不可以是英數或路徑字元：「D:\Backup\Desktop\X」「C:\Users\Amy\Desktop\X」「/home/u/Desktop/X」都不是這個資料夾
const BEFORE = '(?<![A-Za-z0-9_.~\\\\/:-])';
// 最後一段後面必須是分隔、空白、引號或標點（中文字緊接著時不改，例如「印表機設定」是另一個名稱）
const AFTER = '(?=$|[\\\\/\\s"\'`<>|*?()（）「」『』【】《》〈〉，。、；：！？,;:!?\\[\\]{}])';
// 空白或括號後面接的是 Windows 副本的命名（「X - 複製」「X (2)」），那是另一個資料夾
const NOT_COPY = '(?!\\s*-\\s*(?:複製|副本|copy)|\\s*[(（]\\d+[)）]|\\s+copy\\b)';

/**
 * 這個資料夾在文字裡的寫法：只認它本身的完整寫法（C:\…、C:/…、/c/…、/mnt/c/…），以及家目錄底下的 ~/… 與
 * 以常見位置開頭、位於字詞開頭的 Desktop\…。只換最後一段（改名不會換上層資料夾）。
 * 磁碟上名稱以原名開頭的兄弟資料夾（例如「X 舊版」）也不算。
 */
export function pathPattern(fromPath, userHome) {
  const abs = normalizeFsPath(fromPath);
  const segs = abs.split(/[\\/]+/).filter(Boolean);
  const last = segs.at(-1);
  const drive = /^([A-Za-z]):$/.exec(segs[0])?.[1];
  const mid = segs.slice(1, -1).map(escapeRe);
  const heads = [];
  if (drive) {
    heads.push(`${drive}:[\\\\/]+${mid.map((s) => `${s}[\\\\/]+`).join('')}`);
    heads.push(`/${drive}/${mid.map((s) => `${s}/`).join('')}`); // Git Bash
    heads.push(`/mnt/${drive}/${mid.map((s) => `${s}/`).join('')}`); // WSL
    heads.push(`file:///${drive}:/${mid.map((s) => `${s}/`).join('')}`); // 檔案網址
  }
  const rel = path.relative(normalizeFsPath(userHome), abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    const r = rel.split(/[\\/]+/).slice(0, -1).map(escapeRe);
    heads.push(`~[\\\\/]+${r.map((s) => `${s}[\\\\/]+`).join('')}`);
    if (r.length) heads.push(r.map((s) => `${s}[\\\\/]+`).join('')); // 例如 Desktop\X；只有一段（家目錄底下）時太容易誤認，不用
  }
  let siblings = [];
  try { siblings = fs.readdirSync(path.dirname(abs)).filter((n) => n.length > last.length && n.toLowerCase().startsWith(last.toLowerCase())); } catch { /* 上層不在 */ }
  const notSibling = siblings.map((n) => `(?!${escapeRe(n.slice(last.length))})`).join('');
  return new RegExp(`${BEFORE}(${heads.join('|')})${escapeRe(last)}${AFTER}${NOT_COPY}${notSibling}`, 'giu');
}

/** 把文字裡的舊路徑換成新路徑；回傳新文字與替換次數。 */
export function replacePath(text, fromPath, toPath, userHome) {
  let count = 0;
  const base = path.basename(toPath);
  const next = String(text).replace(pathPattern(fromPath, userHome), (_m, head) => { count++; return `${head}${base}`; });
  return { text: next, count };
}

async function vaultMemoryRefs(vault) {
  const out = [];
  const add = async (dir, rel) => { for (const n of await listMarkdown(dir, { exclude: ['MEMORY.md', 'INDEX.md'] })) out.push(`${rel}/${n}`); };
  await add(path.join(vault, 'global'), 'global');
  for (const pid of await fsp.readdir(path.join(vault, 'projects')).catch(() => [])) await add(path.join(vault, 'projects', pid, 'memory'), `projects/${pid}/memory`);
  for (const mid of await fsp.readdir(path.join(vault, 'machines')).catch(() => [])) await add(path.join(vault, 'machines', mid), `machines/${mid}`);
  return out;
}

/**
 * 這台電腦寫的記憶裡，把舊路徑換成新路徑（另一台電腦寫的路徑指的是那台的資料夾，不改）。
 * 先算好所有變更再寫入；寫到一半失敗時，已寫的檔案逐一改回原文再拋出錯誤（不留下指向不存在路徑的記憶）。
 * 專案的 MEMORY.md 保留 Claude 寫的原本那一行，指向改過的記憶的那幾行也一起換；全域與單機索引依描述重建。
 * @returns {Promise<{ files: { ref, count }[], touched: string[] }>}  touched：要 commit 的 vault 相對路徑
 */
export async function rewritePaths(ctx, fromPath, toPath) {
  const owners = await memoryOwners(ctx.vault, ctx.mid);
  const changes = []; // { ref, abs, cur, next, count }
  for (const ref of await vaultMemoryRefs(ctx.vault)) {
    const scope = scopeOfRef(ref);
    if (!scope) continue;
    const mine = scope.kind === 'machine' ? scope.mid === ctx.mid : owners.get(ref) === ctx.mid;
    if (!mine) continue;
    const abs = path.join(ctx.vault, ...ref.split('/'));
    const cur = await readText(abs);
    if (cur === null) continue;
    const r = replacePath(cur, fromPath, toPath, ctx.homes.userHome);
    if (r.count) changes.push({ ref, abs, cur, next: r.text, count: r.count });
  }
  for (const pid of new Set(changes.map((c) => scopeOfRef(c.ref)).filter((s) => s.kind === 'project').map((s) => s.pid))) {
    const abs = path.join(ctx.vault, 'projects', pid, 'memory', 'MEMORY.md');
    const cur = await readText(abs);
    if (cur === null) continue;
    const names = changes.filter((c) => c.ref.startsWith(`projects/${pid}/`)).map((c) => path.posix.basename(c.ref));
    const next = cur.split('\n').map((l) => (names.some((n) => l.includes(`](${n})`)) ? replacePath(l, fromPath, toPath, ctx.homes.userHome).text : l)).join('\n');
    if (next !== cur) changes.push({ ref: `projects/${pid}/memory/MEMORY.md`, abs, cur, next, count: 0, index: true });
  }
  const written = [];
  try {
    for (const c of changes) {
      if (!(await safeWrite(c.abs, c.next, { expectHash: sha1(c.cur) }))) throw new EngramError(E.CONFLICT, `記憶剛被修改，已停止改名：${c.ref}`, '稍後再試一次').withEn(`A memory was just modified, so renaming stopped: ${c.ref}`, 'Try again in a moment');
      written.push(c);
    }
  } catch (err) {
    for (const c of written.reverse()) await safeWrite(c.abs, c.cur).catch(() => {});
    throw err;
  }
  const touched = changes.map((c) => c.ref);
  const scopes = new Map(changes.filter((c) => !c.index).map((c) => scopeOfRef(c.ref)).filter((s) => s.kind !== 'project').map((s) => [JSON.stringify(s), s]));
  for (const scope of scopes.values()) touched.push(...await refreshIndex(ctx, scope));
  return { files: changes.filter((c) => !c.index).map(({ ref, count }) => ({ ref, count })), touched };
}

// ───────── 改名、還原 ─────────

const renamesRef = (mid) => `machines/${mid}/renames.json`;
const renamesFile = (ctx) => path.join(machineDir(ctx.vault, ctx.mid), 'renames.json');
async function readRenames(ctx) { return (await readJson(renamesFile(ctx), null)) ?? { batches: [] }; }

/** 這台電腦的改名紀錄（新的在前）。 */
export async function listCollisionRenames(ctx) {
  return [...(await readRenames(ctx)).batches].reverse();
}

/**
 * 還沒還原的改名：舊路徑 → 新路徑。收編與 H19 用它把對話紀錄裡的舊工作目錄對應到現在的位置
 * （改名前的對話紀錄寫的是舊路徑）。
 * @returns {Promise<(p: string|null) => string|null>}
 */
export async function renamedPathMapper(ctx) {
  const pairs = (await readRenames(ctx)).batches.filter((b) => !b.undoneAt).flatMap((b) => b.items.filter(inEffect)).map((i) => [normalizeFsPath(i.from), normalizeFsPath(i.to)]);
  const once = (n) => {
    for (const [from, to] of pairs) {
      if (samePath(n, from)) return to;
      if (under(n, from)) return path.join(to, n.slice(from.length + 1));
    }
    return n;
  };
  return (p) => {
    if (!p) return p;
    // 連續改名（A → A-x → A-x-y）一路對應到最後的位置
    let n = normalizeFsPath(p);
    for (let i = 0; i < 10; i++) { const next = once(n); if (next === n) break; n = next; }
    return samePath(n, p) ? p : n;
  };
}

/**
 * 這一筆改名目前是否生效：沒有還原過，而且原名不在。撤銷失敗而停在新名稱的也算；
 * 新名稱之後又被改名（連續改名）時新名稱也不在，仍然算，由對應表一路接到最後的位置。
 */
function inEffect(rec) {
  return !rec.undoneAt && !exists(rec.from);
}

/** 舊路徑的綁定移到新路徑：同一個專案重新綁定；第一次綁定的足跡（這個資料夾的 .claude、設定檔、exclude 是誰建立的）與時間沿用原本的紀錄。 */
async function rebind(ctx, it) {
  const bindings = await readBindings(ctx.vault, ctx.mid);
  const old = bindings[it.binding.key];
  if (!old) return null;
  // 舊編碼位置若是指向這個專案的 junction（撞名是綁定之後才出現的），拆掉：
  // 否則之後在同編碼的另一個資料夾開 Claude Code，會讀寫到這個專案的記憶
  let oldJunction = null;
  const oldMem = memoryPathFor(ctx.homes, old.encoded ?? it.encoded);
  if (old.method === 'junction' && isLink(oldMem)) {
    oldJunction = { path: oldMem, target: linkTarget(oldMem) };
    fs.rmdirSync(oldMem);
    await revokeJunctionRead(ctx.homes, oldMem).catch(() => {});
  }
  delete bindings[it.binding.key];
  await writeBindings(ctx.vault, ctx.mid, bindings);
  let b;
  try {
    b = await bind(ctx, it.to, { pid: old.pid }, { mode: 'safe' });
  } catch (err) {
    const cur = await readBindings(ctx.vault, ctx.mid);
    cur[it.binding.key] = old;
    await writeBindings(ctx.vault, ctx.mid, cur);
    if (oldJunction && !exists(oldJunction.path)) { createJunction(oldJunction.target, oldJunction.path); await allowJunctionRead(ctx.homes, oldJunction.path).catch(() => {}); }
    throw err;
  }
  const after = await readBindings(ctx.vault, ctx.mid);
  const v = findBindingByPath(after, it.to);
  if (v) {
    after[v.key] = { ...after[v.key], footprint: mergeFootprint(old.footprint, after[v.key].footprint), boundAt: old.boundAt ?? after[v.key].boundAt, renamedFrom: it.path };
    await writeBindings(ctx.vault, ctx.mid, after);
  }
  return { key: it.binding.key, entry: old, newKey: v?.key ?? null, method: b.method, encoded: b.encoded, oldJunction };
}

/**
 * 撤銷一筆改名（也用於改名中途失敗）：新綁定拆掉、資料夾改回原名、原綁定放回、記憶裡的路徑改回。
 * 記憶的部分用同一套規則把新路徑換回舊路徑，改名之後才寫、提到新路徑的記憶也一起改回。
 * notesEn 是 notes 的英文版（同樣的順序）。
 */
async function undoOne(ctx, rec) {
  const notes = [];
  const notesEn = [];
  const toOurs = exists(rec.to) && sameFolder(rec.to, rec.fid);
  const fromOurs = exists(rec.from) && sameFolder(rec.from, rec.fid);
  // 先把資料夾改回原名：被其他程式開著或原位置又有資料夾時直接拋出，什麼都不動（綁定、記憶保持改名後的狀態，之後可以再試）
  if (toOurs && !exists(rec.from)) {
    try { fs.renameSync(rec.to, rec.from); } catch (err) {
      throw new EngramError(BUSY.has(err.code) ? E.LOCKED : E.INVALID, `${rec.to} 無法改回原名（${err.code ?? err.message}）`, '關閉使用這個資料夾的程式後再還原一次')
        .withEn(`${rec.to} could not be renamed back (${err.code ?? err.message})`, 'Close any program using this folder, then undo again');
    }
  } else if (toOurs) {
    throw new EngramError(E.CONFLICT, `原位置又出現了同名資料夾 ${rec.from}，${rec.to} 沒有改回`, '把其中一個資料夾移開後再還原一次')
      .withEn(`A folder with the same name appeared again at ${rec.from}, so ${rec.to} was not renamed back`, 'Move one of the folders away, then undo again');
  } else if (!fromOurs) {
    // 改名後的資料夾被刪除或搬走（原位置若有資料夾，也不是同一個）：只拆掉新綁定，不綁回原路徑，免得綁到無關的資料夾
    await dropNewBinding(ctx, rec);
    notes.push(`找不到改名後的資料夾 ${rec.to}（可能已刪除或搬走），只移除了它的綁定${exists(rec.from) ? `；原位置的 ${rec.from} 是另一個資料夾，沒有綁定` : ''}`);
    notesEn.push(`Could not find the renamed folder ${rec.to} (it may have been deleted or moved); only its binding was removed${exists(rec.from) ? `; ${rec.from} at the original location is a different folder and is not bound` : ''}`);
    return { touched: [], notes, notesEn, gone: true };
  } // 只剩原名、而且是同一個資料夾：上一次還原已經改回，接著補做綁定與記憶
  await dropNewBinding(ctx, rec);
  if (rec.binding) {
    const bindings = await readBindings(ctx.vault, ctx.mid);
    bindings[rec.binding.key] = rec.binding.entry;
    await writeBindings(ctx.vault, ctx.mid, bindings);
    const j = rec.binding.oldJunction;
    if (j && !exists(j.path)) { createJunction(j.target, j.path); await allowJunctionRead(ctx.homes, j.path).catch(() => {}); }
  }
  const rw = exists(rec.from) ? await rewritePaths(ctx, rec.to, rec.from) : { touched: [] };
  return { touched: rw.touched, notes, notesEn };
}

/** 拆掉改名時建立的新綁定（junction 一併移除；新編碼的記憶資料夾原本不存在，是改名時才建立的） */
async function dropNewBinding(ctx, rec) {
  if (!rec.binding?.newKey) return;
  const bindings = await readBindings(ctx.vault, ctx.mid);
  const cur = bindings[rec.binding.newKey];
  if (cur?.method === 'junction') {
    const mem = memoryPathFor(ctx.homes, cur.encoded ?? rec.binding.encoded);
    if (isLink(mem)) fs.rmdirSync(mem);
    await revokeJunctionRead(ctx.homes, mem).catch(() => {});
  }
  delete bindings[rec.binding.newKey];
  await writeBindings(ctx.vault, ctx.mid, bindings);
}

/** 資料夾的識別：NTFS 的 file ID，改名後不變。檔案系統不提供時回傳 null。 */
function folderId(p) {
  try { const { ino } = fs.statSync(p, { bigint: true }); return ino ? String(ino) : null; } catch { return null; }
}
// 沒記到識別（檔案系統不提供）時無從比對，視為同一個
const sameFolder = (p, fid) => !fid || folderId(p) === fid;

/**
 * 共用的舊記憶資料夾：沒有現存、用過的資料夾還會用到它，而且裡面的記憶都已收編、內容沒變 → 移到備份。
 * 檢查所有還沒還原的批次（上次因為還有沒收編的記憶而保留的，收編之後下次再退役），退役紀錄附在原批次上以便還原。
 */
async function retireSharedDirs(ctx, log) {
  const retired = [];
  const swept = await readSweepLog(ctx.local);
  const scans = await scanAll(ctx.homes.claudeHome);
  const views = allBindingViews(await readBindings(ctx.vault, ctx.mid));
  const stillUsed = [...scans.flatMap((s) => s.roots), ...views.map((v) => v.path)].filter((p) => p && exists(p));
  for (const batch of log.batches.filter((b) => !b.undoneAt)) {
    batch.retired ??= [];
    for (const enc of new Set(batch.items.filter(inEffect).map((i) => i.encodedFrom))) {
      if (log.batches.some((b) => !b.undoneAt && (b.retired ?? []).some((r) => r.encoded.toLowerCase() === enc.toLowerCase()))) continue;
      if (stillUsed.some((p) => encodeProjectPath(p)?.toLowerCase() === enc.toLowerCase())) continue;
      const mem = memoryPathFor(ctx.homes, enc);
      if (!exists(mem) || isLink(mem)) continue;
      const done = new Map((swept[enc]?.files ?? []).map((f) => [f.file.toLowerCase(), f.sha1]));
      const files = await listMarkdown(mem, { exclude: ['MEMORY.md'] });
      let ok = files.length > 0;
      for (const n of files) {
        const t = await readText(path.join(mem, n));
        if (t === null || done.get(n.toLowerCase()) !== sha1(t)) { ok = false; break; } // 還沒收編或改過：留給 H05，收編後下次再退役
      }
      if (!ok) continue;
      const backup = path.join(ctx.local, 'backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-rename`, enc, 'memory');
      await fsp.mkdir(path.dirname(backup), { recursive: true });
      try { fs.renameSync(mem, backup); } catch (err) { if (BUSY.has(err.code)) continue; throw err; }
      const r = { encoded: enc, from: mem, backup, at: new Date().toISOString() };
      batch.retired.push(r);
      retired.push(r);
    }
  }
  return retired;
}

async function commitLog(ctx, log, touched, subject, id, action = 'rename-folder') {
  await writeJson(renamesFile(ctx), log);
  return commitPaths(ctx.vault, [...touched, renamesRef(ctx.mid), `machines/${ctx.mid}/bindings.json`], subject, { action, mid: ctx.mid, trailers: { 'Engram-Rename': id } });
}

/**
 * 依命名規則改名。paths：只處理這些資料夾（介面的一鍵改名）；省略時處理全部可以改的。
 * 也順便退役之前因為還有沒收編的記憶而保留的共用舊記憶資料夾。
 * @returns {Promise<{ ok, id, renamed: {from,to}[], skipped: {path,reason}[], retired, commit?, undo? }>}
 */
export async function renameCollisions(ctx, { paths = null } = {}) {
  return ctx.locked('collisions.rename', async () => {
    const plan = await planCollisionRenames(ctx);
    const inScope = (it) => !paths || paths.some((p) => samePath(p, it.path));
    const id = `rn-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-')}-${crypto.randomBytes(2).toString('hex')}`;
    const log = await readRenames(ctx);
    const batch = { id, at: new Date().toISOString(), items: [], retired: [] };
    const skipped = plan.filter((it) => inScope(it) && it.blocked).map((it) => ({ path: it.path, reason: it.blocked }));
    const touched = new Set();
    for (const it of plan.filter((x) => inScope(x) && x.to && !x.blocked)) {
      try {
        fs.renameSync(it.path, it.to);
      } catch (err) {
        if (BUSY.has(err.code)) { skipped.push({ path: it.path, reason: 'busy' }); continue; } // 被其他程式開著：下次再試
        throw err;
      }
      // fid：還原時用來確認原位置／新位置的資料夾還是同一個（使用者可能刪掉後又建了同名的新資料夾）
      const rec = { from: it.path, to: it.to, fid: folderId(it.to), encodedFrom: it.encoded, encodedTo: encodeProjectPath(it.to), binding: null, memories: [] };
      try {
        const rw = await rewritePaths(ctx, it.path, it.to); // 失敗時已自行改回
        rec.memories = rw.files;
        rw.touched.forEach((r) => touched.add(r));
        if (it.binding) rec.binding = await rebind(ctx, it);
      } catch (err) {
        // 這一筆撤銷；撤銷也失敗時照樣記進批次（undoFailed），之後還能從紀錄還原，不會無聲遺失
        try {
          const u = await undoOne(ctx, rec);
          u.touched.forEach((r) => touched.add(r));
        } catch (undoErr) {
          batch.items.push({ ...rec, undoFailed: String(undoErr?.message ?? undoErr) });
        }
        if (batch.items.length) log.batches.push({ ...batch, failed: { path: it.path, message: String(err?.message ?? err) } });
        await commitLog(ctx, log, touched, `rename folders stopped at ${path.basename(it.path)} (${id})`, id).catch(() => {});
        throw err;
      }
      batch.items.push(rec);
    }
    if (batch.items.length) log.batches.push(batch);
    const retired = await retireSharedDirs(ctx, log);
    if (!batch.items.length && !retired.length) return { ok: true, id: null, renamed: [], skipped, retired: [] };
    const subject = batch.items.length
      ? `rename ${batch.items.length} folders: ${batch.items.map((i) => `${path.basename(i.from)} → ${path.basename(i.to)}`).join(', ')}`
      : `retire ${retired.length} shared memory folders after rename`;
    // 只有退役、沒有新的改名時，紀錄附在原本的批次上；commit 沿用那一批的 id（還原時一起處理）
    const ownerId = batch.items.length ? id : log.batches.find((b) => (b.retired ?? []).includes(retired[0]))?.id ?? id;
    const commit = await commitLog(ctx, log, touched, subject, ownerId);
    return {
      ok: true, id: batch.items.length ? id : null,
      renamed: batch.items.map(({ from, to }) => ({ from, to })),
      skipped, retired: retired.map(({ encoded, backup }) => ({ encoded, backup })),
      commit: commit ?? undefined, undo: commit && batch.items.length ? { sha: commit.sha } : undefined,
    };
  });
}

/** 整批還原一次改名（倒序；每一筆盡力而為，失敗的記下原因、繼續下一筆）。共用的舊記憶資料夾從備份放回。 */
export async function undoCollisionRenames(ctx, id) {
  return ctx.locked('collisions.rename', async () => {
    const log = await readRenames(ctx);
    const batch = log.batches.find((b) => b.id === id);
    if (!batch) throw new EngramError(E.NOT_FOUND, `找不到改名紀錄：${id}`).withEn(`Rename record not found: ${id}`);
    if (batch.undoneAt) return { ok: true, already: true };
    const touched = new Set();
    const notes = [];
    const notesEn = []; // notes 的英文版，順序相同
    const restored = [];
    // 逐筆記錄是否已還原；失敗的（例如資料夾被其他程式開著）維持改名後的完整狀態，之後再按還原可以重試
    for (const rec of [...batch.items].reverse()) {
      if (rec.undoneAt) continue;
      try {
        const u = await undoOne(ctx, rec);
        u.touched.forEach((r) => touched.add(r));
        notes.push(...u.notes);
        notesEn.push(...u.notesEn);
        rec.undoneAt = new Date().toISOString();
        delete rec.undoFailed;
        if (u.gone) rec.gone = true; // 資料夾已不在：視為完成，讓整批可以結束
        else restored.push({ from: rec.to, to: rec.from });
      } catch (err) {
        notes.push(`${rec.to}：${err?.message ?? err}${err?.hint ? `（${err.hint}）` : ''}`);
        const hintEn = err?.en ? err.en.hint : err?.hint;
        notesEn.push(`${rec.to}: ${err?.en?.message ?? err?.message ?? err}${hintEn ? ` (${hintEn})` : ''}`);
      }
    }
    const done = batch.items.every((r) => r.undoneAt);
    if (done) {
      // 全部改回原名之後，共用的舊記憶資料夾才從備份放回（還有資料夾停在新名稱時，放回會讓它讀到舊的共用記憶）
      for (const r of batch.retired ?? []) {
        if (!exists(r.backup)) { notes.push(`找不到共用舊記憶資料夾的備份：${r.backup}`); notesEn.push(`Could not find the backup of the shared old memory folder: ${r.backup}`); continue; }
        if (exists(r.from)) { notes.push(`${r.from} 已經有新的內容，舊記憶仍保存在 ${r.backup}`); notesEn.push(`${r.from} already has new content; the old memories are still kept in ${r.backup}`); continue; }
        await fsp.mkdir(path.dirname(r.from), { recursive: true });
        fs.renameSync(r.backup, r.from);
      }
      batch.undoneAt = new Date().toISOString();
    }
    batch.undoNotes = notes.length ? notes : undefined;
    const commit = await commitLog(ctx, log, touched, done ? `undo rename ${id}` : `undo rename ${id} (partial: ${batch.items.filter((r) => !r.undoneAt).length} left)`, id, 'undo');
    return { ok: done && notes.length === 0, done, id, restored, notes, ...(notes.length ? { en: { notes: notesEn } } : {}), commit: commit ?? undefined };
  });
}
