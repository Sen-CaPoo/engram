// vault 結構、初始化、電腦與專案登記、commit 輔助。結構見 40 號文件 §04。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { E, EngramError } from './errors.mjs';
import { exists, readJson, readJsonSync, readText, safeWrite, stableJson, writeJson } from './fsx.mjs';
import { buildMessage, git } from './git.mjs';
import { makeMid, makeVaultId } from './ids.mjs';
import { normalizeFsPath, toTildePath } from './paths.mjs';

export const SCHEMA_VERSION = 1;
export const ENGINE_VERSION = '1.3.0';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_DIR = path.join(HERE, 'templates');
/** CLI 入口（合併器設定要指向它）；由 claude-25 提供 app/bin/engram.mjs。 */
export const DEFAULT_CLI = path.resolve(HERE, '..', '..', 'bin', 'engram.mjs');

export const GITATTRIBUTES = `* text=auto eol=lf
*.md          merge=engram-md
**/MEMORY.md  merge=union
**/INDEX.md   merge=ours
*.json        text eol=lf
`;

export const GITIGNORE = `# Engram vault
.*.tmp
*.tmp
Thumbs.db
desktop.ini
`;

/** vault 內各範圍的位置。 */
export function layout(vaultDir) {
  return {
    engramJson: path.join(vaultDir, 'engram.json'),
    core: path.join(vaultDir, 'core'),
    coreMd: path.join(vaultDir, 'core', 'CORE.md'),
    global: path.join(vaultDir, 'global'),
    projects: path.join(vaultDir, 'projects'),
    machines: path.join(vaultDir, 'machines'),
    conflicts: path.join(vaultDir, 'conflicts'),
  };
}

// R-45：pid／mid 會被用來組路徑，所有 *Dir helper 都在這裡統一驗證（防止 ..、路徑分隔字元等）
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KIND_EN = { '專案 id': 'project id', '電腦 id': 'machine id' }; // assertId 的 kind 是中文詞，英文訊息用這張表對照
export function assertId(kind, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new EngramError(E.INVALID, `不合法的${kind}：${String(id).slice(0, 80)}`).withEn(`Invalid ${KIND_EN[kind] ?? kind}: ${String(id).slice(0, 80)}`);
  return id;
}
export function projectDir(vaultDir, pid) { return path.join(vaultDir, 'projects', assertId('專案 id', pid)); }
export function projectMemoryDir(vaultDir, pid) { return path.join(vaultDir, 'projects', assertId('專案 id', pid), 'memory'); }
export function machineDir(vaultDir, mid) { return path.join(vaultDir, 'machines', assertId('電腦 id', mid)); }

/** 簡單樣板：{{key}} 換成 vars[key]；未提供的鍵換成空字串。 */
export function renderTemplate(text, vars = {}) {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
}

export async function loadTemplate(name) {
  return readText(path.join(TEMPLATES_DIR, name));
}

// ───────── 本機身分 ─────────

/** 讀本機 machine.json；不存在時回傳 null。 */
export function readLocalMachine(localDir) {
  return readJsonSync(path.join(localDir, 'machine.json'), null);
}

async function ensureLocalMachine(localDir, label) {
  const p = path.join(localDir, 'machine.json');
  let m = await readJson(p, null);
  if (!m?.mid) {
    m = { mid: makeMid(os.hostname()), label: label || os.hostname(), createdAt: new Date().toISOString() };
    await writeJson(p, m);
  } else if (label && m.label !== label) {
    m.label = label;
    await writeJson(p, m);
  }
  return m;
}

// ───────── git 設定 ─────────

export async function configureRepo(vaultDir, { mid, label, cli = DEFAULT_CLI, conflictsDir }) {
  const nodeExe = process.execPath.replace(/\\/g, '/');
  const cliPath = cli.replace(/\\/g, '/');
  const conf = [
    ['core.autocrlf', 'false'],
    ['core.quotepath', 'false'],
    ['core.longpaths', 'true'],
    ['pull.rebase', 'false'],
    ['merge.ours.driver', 'true'],
    ['merge.engram-md.name', 'Engram memory merge'],
    // 合併器：%O 共同祖先、%A 本機（結果寫回這裡）、%B 對方、%P 路徑
    ['merge.engram-md.driver', `"${nodeExe}" "${cliPath}" merge-driver %O %A %B %P`],
    ['user.name', `Engram · ${label || mid}`],
    ['user.email', `engram@${mid}.local`],
    ['engram.conflictsdir', (conflictsDir ?? path.join(vaultDir, 'conflicts')).replace(/\\/g, '/')],
  ];
  for (const [k, v] of conf) await git(['config', '--local', k, v], { cwd: vaultDir });
}

// ───────── 初始化 ─────────

/**
 * 建立或接上 vault，並登記本機。
 * @param {{ homes: import('./paths.mjs').Homes, remote?: string, machineLabel?: string, userName?: string, cli?: string }} opts
 */
export async function initVault({ homes, remote, machineLabel, userName, cli }) {
  const { vault, local } = homes;
  await fsp.mkdir(local, { recursive: true });
  const machine = await ensureLocalMachine(local, machineLabel);
  const L = layout(vault);
  let created = false;

  if (!exists(path.join(vault, '.git'))) {
    if (exists(vault) && fs.readdirSync(vault).length > 0) {
      throw new EngramError(E.INVALID, `vault 位置已有其他檔案：${vault}`, '請清空該資料夾或指定其他 home').withEn(`The vault location already contains other files: ${vault}`, 'Empty that folder or specify a different home');
    }
    let cloned = false;
    if (remote) {
      await fsp.mkdir(path.dirname(vault), { recursive: true });
      const r = await git(['clone', '--origin', 'origin', remote, vault], { cwd: path.dirname(vault), timeoutMs: 120_000, allowFail: true });
      if (r.code === 0) cloned = true;
      else if (!/empty repository/i.test(r.stderr)) {
        const { classifyGitError } = await import('./git.mjs');
        throw classifyGitError(r, ['clone', remote]);
      }
    }
    if (!cloned) {
      await fsp.mkdir(vault, { recursive: true });
      await git(['init', '-b', 'main'], { cwd: vault });
      if (remote) await git(['remote', 'add', 'origin', remote], { cwd: vault });
    }
    created = !cloned;
  }

  await configureRepo(vault, { mid: machine.mid, label: machine.label, cli });

  // 骨架（已存在的檔案不覆寫）
  const ensures = [];
  if (!exists(L.engramJson)) ensures.push(writeJson(L.engramJson, { schema: SCHEMA_VERSION, vaultId: makeVaultId(), createdAt: new Date().toISOString() }));
  if (!exists(path.join(vault, '.gitattributes'))) ensures.push(safeWrite(path.join(vault, '.gitattributes'), GITATTRIBUTES));
  if (!exists(path.join(vault, '.gitignore'))) ensures.push(safeWrite(path.join(vault, '.gitignore'), GITIGNORE));
  if (!exists(L.coreMd)) {
    const tpl = (await loadTemplate('CORE.template.md')) ?? '# 核心準則\n';
    ensures.push(safeWrite(L.coreMd, renderTemplate(tpl, {
      user_name: userName ?? os.userInfo().username,
      generated_at: new Date().toISOString().slice(0, 10),
      engram_version: ENGINE_VERSION,
      user_profile: '（尚未填寫。可在 Engram 介面的「核心準則」補上身分、職務與偏好。）', // 41 號 §05 的預設值
      environments: `- ${machine.label}（${machine.mid}）`,
      language: '正體中文（zh-TW）',
      communication_extra: '',
      optional_user_guidelines: '',
      global_index_import: '@../global/INDEX.md',
      vault_path: toTildePath(vault, homes.userHome),
    })));
  }
  for (const d of [L.global, L.projects, L.conflicts]) ensures.push(fsp.mkdir(d, { recursive: true }));
  await Promise.all(ensures);
  for (const keep of [path.join(L.projects, '.gitkeep'), path.join(L.conflicts, '.gitkeep')]) {
    if (!exists(keep)) await safeWrite(keep, '');
  }

  await registerMachine(homes, machine);

  // 初次 commit
  await git(['add', '-A'], { cwd: vault });
  const st = await git(['status', '--porcelain'], { cwd: vault });
  if (st.stdout.trim()) {
    await git(['commit', '-q', '-F', '-'], { cwd: vault, input: buildMessage(`engram(${machine.mid}): ${created ? '建立 vault' : '登記電腦'} ${machine.label}`, { action: created ? 'init' : 'register' }) });
  }
  return { machine, vault, created };
}

/** 在 vault 登記本機（單一寫入者：只寫 machines/<mid>/）。 */
export async function registerMachine(homes, machine) {
  const dir = machineDir(homes.vault, machine.mid);
  await fsp.mkdir(dir, { recursive: true });
  const p = path.join(dir, 'machine.json');
  const prev = await readJson(p, {});
  const next = {
    id: machine.mid,
    label: machine.label,
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()}`,
    user: os.userInfo().username,
    engramVersion: ENGINE_VERSION,
    firstSeenAt: prev.firstSeenAt ?? new Date().toISOString(),
    lastSeenAt: prev.lastSeenAt ?? new Date().toISOString(),
  };
  await writeJson(p, next);
  const b = path.join(dir, 'bindings.json');
  if (!exists(b)) await writeJson(b, {});
}

/** lastSeenAt 最多每 6 小時寫一次，避免 commit 雜訊。 */
export async function touchMachine(homes, mid) {
  const p = path.join(machineDir(homes.vault, mid), 'machine.json');
  const m = await readJson(p, null);
  if (!m) return false;
  const last = Date.parse(m.lastSeenAt ?? 0) || 0;
  if (Date.now() - last < 6 * 3600_000 && m.engramVersion === ENGINE_VERSION) return false;
  m.lastSeenAt = new Date().toISOString();
  m.engramVersion = ENGINE_VERSION;
  await writeJson(p, m);
  return true;
}

// ───────── 專案與綁定登記 ─────────

export async function readProject(vaultDir, pid) {
  return readJson(path.join(projectDir(vaultDir, pid), 'project.json'), null);
}

export async function writeProject(vaultDir, project) {
  project.updatedAt = new Date().toISOString();
  await writeJson(path.join(projectDir(vaultDir, project.id), 'project.json'), project);
}

export async function listProjectIds(vaultDir) {
  try {
    const entries = await fsp.readdir(path.join(vaultDir, 'projects'), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && ID_RE.test(e.name)).map((e) => e.name).sort();
  } catch { return []; }
}

export async function listMachineIds(vaultDir) {
  try {
    const entries = await fsp.readdir(path.join(vaultDir, 'machines'), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && ID_RE.test(e.name)).map((e) => e.name).sort();
  } catch { return []; }
}

export async function readBindings(vaultDir, mid) {
  return readJson(path.join(machineDir(vaultDir, mid), 'bindings.json'), {});
}

export async function writeBindings(vaultDir, mid, bindings) {
  const sorted = Object.fromEntries(Object.entries(bindings).sort(([a], [b]) => a.localeCompare(b)));
  await writeJson(path.join(machineDir(vaultDir, mid), 'bindings.json'), sorted);
}

// bindings.json：{ [key]: { pid, path, encoded, method, state, boundAt, lastOpenedAt } }。
// junction 綁定的 key 就是編碼資料夾名稱（一個編碼只能有一個 junction）；
// 設定檔備援（撞名資料夾）的 key 是「編碼@路徑雜湊」，讓同一個編碼底下的多個資料夾各有一筆（R-25）。
// 同一個專案在同一台電腦可以有多個資料夾（例如同一個 repo clone 兩份）。
// 查詢函式回傳 { key, encoded, ...entry }：寫回 bindings 時一律用 key。

/**
 * 每個檔案是哪台電腦寫進 vault 的：加入它的 commit 標題「engram(<mid>): …」。一次 git log（由舊到新）取得全部；
 * 搬移（改範圍、合併專案）沿用原本的歸屬，不算給執行搬移的那台；刪除後重新加入的算新的；原本歸屬不明（null）的搬移後仍不明。
 * 還沒 commit 的檔案是這台電腦剛寫的。用途：H08 的單機歸屬、資料夾改名時只改這台寫的記憶。
 * @returns {Promise<Map<string, string|null>>} vault 相對路徑 → mid
 */
export async function memoryOwners(vaultDir, selfMid) {
  const r = await git(['log', '--reverse', '-M', '--name-status', '--format=%x00%s'], { cwd: vaultDir, allowFail: true });
  const map = new Map();
  let mid = null;
  for (const line of (r.stdout ?? '').split('\n')) {
    if (line.startsWith('\0')) { mid = /^engram\(([^)]+)\):/.exec(line.slice(1))?.[1] ?? null; continue; }
    const [status, a, b] = line.split('\t');
    if (!a) continue;
    if (status === 'A' && !map.has(a)) map.set(a, mid);
    else if (status === 'D') map.delete(a);
    else if (status?.startsWith('R') && b) { map.set(b, map.has(a) ? map.get(a) : mid); map.delete(a); }
  }
  const untracked = await git(['ls-files', '--others', '--exclude-standard'], { cwd: vaultDir, allowFail: true });
  for (const f of (untracked.stdout ?? '').split('\n').map((x) => x.trim()).filter(Boolean)) map.set(f, selfMid);
  return map;
}

export function bindingKey(encoded, method, root) {
  if (method === 'junction') return encoded;
  return `${encoded}@${createHash('sha1').update(normalizeFsPath(root).toLowerCase()).digest('hex').slice(0, 8)}`;
}

function view(key, b) {
  return { ...b, key, encoded: b?.encoded ?? key.split('@')[0] };
}

/** 依本機路徑找綁定（大小寫不敏感）。 */
export function findBindingByPath(bindings, absPath) {
  const target = normalizeFsPath(absPath).toLowerCase();
  for (const [key, b] of Object.entries(bindings)) {
    if (b?.path && normalizeFsPath(b.path).toLowerCase() === target) return view(key, b);
  }
  return null;
}

/** 依編碼找綁定；同一個編碼有多筆時優先回傳 junction 那筆。 */
export function findBindingByEncoded(bindings, encoded) {
  if (!encoded) return null;
  const want = String(encoded).toLowerCase();
  const hits = Object.entries(bindings).map(([k, b]) => view(k, b)).filter((v) => v.encoded.toLowerCase() === want);
  return hits.find((h) => h.method === 'junction') ?? hits[0] ?? null;
}

export function bindingsForPid(bindings, pid) {
  return Object.entries(bindings).filter(([, b]) => b?.pid === pid).map(([k, b]) => view(k, b));
}

export function allBindingViews(bindings) {
  return Object.entries(bindings).map(([k, b]) => view(k, b));
}

// ───────── 本機狀態 ─────────

export async function readState(localDir) {
  return readJson(path.join(localDir, 'state.json'), {});
}

export async function updateState(localDir, patch) {
  const p = path.join(localDir, 'state.json');
  const cur = await readJson(p, {});
  const next = { ...cur, ...patch };
  await fsp.mkdir(localDir, { recursive: true });
  await safeWrite(p, stableJson(next));
  return next;
}

// ───────── commit 輔助 ─────────

/**
 * 把指定路徑加入暫存並 commit。paths 為 vault 相對路徑；空陣列代表不 commit。
 * @returns {Promise<{ sha: string, message: string } | null>}
 */
/**
 * 最後一道防線（R-31、m1）：檢查「實際被 stage 的內容」，含衝突標記或疑似金鑰的檔案一律退出暫存區。
 * @returns {Promise<string[]>} 被退出的路徑
 */
export async function guardStaged(vaultDir, allow = {}) {
  const staged = (await git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], { cwd: vaultDir })).stdout.split('\0').filter(Boolean);
  if (!staged.length) return [];
  const bad = new Set();
  const markers = await git(['grep', '--cached', '-I', '-l', '-z', '-E', '^(<<<<<<<|>>>>>>>)( |$)', '--', ...staged], { cwd: vaultDir, allowFail: true });
  for (const p of markers.stdout.split('\0').filter(Boolean)) bad.add(p);
  const { scanWithAllow } = await import('./secretallow.mjs');
  for (const p of staged.filter((s) => /\.md$/i.test(s) && !bad.has(s))) {
    const blob = await git(['show', `:${p}`], { cwd: vaultDir, allowFail: true });
    if (blob.code === 0 && scanWithAllow(blob.stdout, p, allow).length) bad.add(p);
  }
  if (bad.size) await git(['reset', '-q', '--', ...bad], { cwd: vaultDir });
  return [...bad];
}

/**
 * guard 預設開啟（M5）：含疑似金鑰或衝突標記的檔案退回不提交、留在工作目錄，同步也會繼續扣住，直到內容改好。
 * 不只同步，remember、介面編輯、合併、移動、衝突處理、核心準則等所有直接寫入都經過這一關；allow 省略時讀 vault 旁邊 local/ 的「不是金鑰」清單。
 */
export async function commitPaths(vaultDir, paths, subject, { action, refs = [], mid, guard = true, allow, trailers = {} } = {}) {
  if (!paths.length) return null;
  const requested = [...new Set(paths)];
  // 不存在、也從未被追蹤的路徑（例如還沒自動存檔就被移走的檔案）不能交給 git add，否則整批失敗
  const tracked = new Set((await git(['ls-files', '-z', '--', ...requested], { cwd: vaultDir })).stdout.split('\0').filter(Boolean));
  const unique = requested.filter((p) => exists(path.join(vaultDir, ...p.split('/'))) || tracked.has(p) || [...tracked].some((t) => t.startsWith(`${p}/`)));
  if (!unique.length) return null;
  let message;
  try {
    for (let i = 0; i < unique.length; i += 100) {
      await git(['add', '-A', '--', ...unique.slice(i, i + 100)], { cwd: vaultDir });
    }
    if (guard) await guardStaged(vaultDir, allow ?? await (await import('./secretallow.mjs')).loadAllow(path.join(path.dirname(vaultDir), 'local')));
    const staged = await git(['diff', '--cached', '--name-only'], { cwd: vaultDir });
    if (!staged.stdout.trim()) return null;
    message = buildMessage(`engram(${mid ?? 'local'}): ${subject}`, { action, refs: refs.length ? refs : unique });
    const extra = Object.entries(trailers).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
    if (extra.length) message = `${message.replace(/\n+$/, '')}\n${extra.join('\n')}\n`;
    await git(['commit', '-q', '-F', '-'], { cwd: vaultDir, input: message });
  } catch (err) {
    // 失敗時把這次 stage 的路徑退回（工作目錄不動）：否則下一個不相干的 commit 會把它們一起提交出去
    for (let i = 0; i < unique.length; i += 100) {
      await git(['reset', '-q', '--', ...unique.slice(i, i + 100)], { cwd: vaultDir, allowFail: true });
    }
    throw err;
  }
  const sha = (await git(['rev-parse', 'HEAD'], { cwd: vaultDir })).stdout.trim();
  return { sha, message: message.split('\n')[0] };
}
