// 收編舊記憶（40 號文件 §09）：把 ~/.claude/projects/*/memory/ 裡尚未納管的記憶複製進 vault。
// 一律先產生計畫（SweepPlan，匯入精靈預覽用），再依（可能被使用者修改過的）計畫執行。原資料夾只備份、不刪除。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { looseName, suggestScope } from './classify.mjs';
import { getField, parseMemoryFile, semanticKey } from './frontmatter.mjs';
import { exists, mtimeMs, readJson, readText, safeWrite, sha1, writeJson } from './fsx.mjs';
import { bind, copyMemoriesInto, createProject, encodingIndex, gitIdentity, memoryPathFor, resolveIdentity } from './identity.mjs';
import { revokeJunctionRead } from './claudesettings.mjs';
import { git } from './git.mjs';
import { E, EngramError } from './errors.mjs';
import { isLink, listMarkdown } from './fsx.mjs';
import { uniqueFileName } from './ids.mjs';
import { scopeDir } from './memories.mjs';
import { encodeProjectPath, memoryRootFor, normalizeFsPath, samePath, toRef } from './paths.mjs';
import { scanAll, sessionIndex } from './transcripts.mjs';
import { commitPaths, listMachineIds, listProjectIds, machineDir, projectMemoryDir, readBindings, readProject } from './vault.mjs';

const SEARCH_ROOTS = ['Desktop', 'Downloads', 'Documents', 'source', 'repos', 'Projects'];

function searchRoots(userHome) {
  const extra = fs.existsSync(userHome) ? fs.readdirSync(userHome).filter((n) => /^OneDrive/i.test(n)) : [];
  return [...SEARCH_ROOTS, ...extra].map((d) => path.join(userHome, d)).filter((p) => fs.existsSync(p));
}

/** 走訪常見位置三層內的資料夾。 */
function walkDirs(userHome, visit) {
  const walk = (dir, depth) => {
    visit(dir);
    if (depth >= 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const r of searchRoots(userHome)) walk(r, 0);
}

/** 在 dirs 裡找「編碼後等於 encoded」的資料夾（只在 transcript 找不到 cwd 時使用）。 */
function decodeCandidates(encoded, dirs) {
  const hits = new Set();
  for (const dir of dirs) if (encodeProjectPath(dir)?.toLowerCase() === encoded.toLowerCase()) hits.add(normalizeFsPath(dir));
  return [...hits];
}

// SW-3：記憶內文提到的路徑。Claude 寫記憶時常寫下工作目錄；對話紀錄被清掉、或多個中文資料夾撞名時，
// 這是唯一能把「這一筆」記憶對回原資料夾的線索。可以是絕對路徑，或以常見位置開頭、相對於家目錄的路徑。
// 磁碟代號前面只排除英數（中文字可以緊接著，例如「放在C:\…」；https: 的 s: 不算）；Git Bash 的 /c/Users/… 也認得
const PATH_IN_TEXT = /(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/]|(?<![\w.~\\/-])\/[A-Za-z]\/(?=[^\s/])|~[\\/]|(?<![\p{L}\p{N}_.~\\/-])(?:Desktop|Downloads|Documents|source|repos|Projects)[\\/])[^\s"'`<>|*?]+/gu;
// 路徑後面緊接著的標點（中文句子常常不留空白）
const PATH_STOP = /[，。、；：！？（）「」『』【】《》〈〉,;()[\]{}]/u;

/** 從文字中取出路徑，回傳絕對路徑（家目錄相對的路徑接到 userHome 底下）。 */
export function pathsInText(text, userHome) {
  const out = [];
  for (const m of String(text ?? '').matchAll(PATH_IN_TEXT)) {
    let s = m[0];
    const colon = s.indexOf(':', 2); // 冒號只會出現在磁碟代號
    if (colon >= 0) s = s.slice(0, colon);
    const stop = s.search(PATH_STOP);
    if (stop >= 0) s = s.slice(0, stop);
    const bash = /^\/([A-Za-z])\/(.*)$/.exec(s); // Git Bash：/c/Users/… → C:\Users\…
    if (bash) s = `${bash[1].toUpperCase()}:\\${bash[2]}`;
    s = s.replace(/[.\\/]+$/, '');
    if (!s || /^[A-Za-z]:$/.test(s) || s === '~') continue;
    out.push(/^[A-Za-z]:/.test(s) ? s : path.join(userHome, s.replace(/^~[\\/]/, '')));
  }
  return out;
}

/**
 * 兩個編碼相同的路徑，差異是否出現在英數或符號上（例如 Desktop\engram-app 與 Desktop\engram\app）。
 * 中文撞名的差異只會在非 ASCII 字元上；差在 ASCII 上的多半只是內文剛好提到別的路徑。
 */
function differsInAscii(a, b) {
  const x = normalizeFsPath(a).toLowerCase();
  const y = normalizeFsPath(b).toLowerCase();
  if (x === y) return false;
  if (x.length !== y.length) return true;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i] && x.charCodeAt(i) < 128 && y.charCodeAt(i) < 128) return true;
  return false;
}

/**
 * 內文提到、而且編碼後正好等於 encoded 的資料夾（提到的是裡面的檔案也算）。
 * 提到兩個以上不同的資料夾時無法判斷，回傳 null。
 */
export function contentPathFor(text, encoded, userHome) {
  const want = encoded.toLowerCase();
  const hits = new Map();
  for (const abs of pathsInText(text, userHome)) {
    const parts = normalizeFsPath(abs).split(/[\\/]+/);
    for (let i = 2; i <= parts.length; i++) {
      const p = parts.slice(0, i).join(path.sep);
      if (encodeProjectPath(p)?.toLowerCase() !== want) continue;
      // 存在、但只是 git repo 裡的子資料夾：Claude Code 用 repo 根目錄的編碼，這個記憶資料夾不可能屬於它
      if (exists(p) && !samePath(memoryRootFor(p).root, p)) break;
      if (!hits.has(p.toLowerCase())) hits.set(p.toLowerCase(), normalizeFsPath(p)); // 同一個資料夾寫了兩次（大小寫不同）：用第一次的寫法
      break;
    }
  }
  return hits.size === 1 ? [...hits.values()][0] : null;
}

// 同一個來源裡各筆記憶的歸屬依據不同時，來源顯示最強的那一種
const HOW_RANK = { 'origin-session': 4, 'content-path': 3, 'transcript-cwd': 2, decoded: 1, unknown: 0 };

// 名稱比對時，也認得收編產生的「未歸屬（X）」裡的 X
function nameKeys(p) {
  return [p.name, ...(p.aliases ?? [])].flatMap((n) => {
    const m = /^未歸屬（(.+)）$/.exec(String(n));
    return m ? [n, m[1]] : [n];
  }).map(looseName);
}

const CANDIDATE_REASON = {
  remote: 'git remote 與既有專案相同',
  'root-commit': '與既有專案有相同的第一個 commit（fork 或換了組織）',
  'name+entries': '名稱與資料夾內容和既有專案相近',
};
// CANDIDATE_REASON 的英文版（鍵相同）
const CANDIDATE_REASON_EN = {
  remote: 'Same git remote as an existing project',
  'root-commit': 'Same first commit as an existing project (a fork, or moved to another organization)',
  'name+entries': 'Name and folder contents are similar to an existing project',
};

/**
 * 編碼名稱的尾段（中文字被換成連字號之後，最後一段通常還是英數的專案名稱）。
 * 例：C--Users-me-Desktop-Github---------Team-Dashboard → Team-Dashboard
 */
export function encodedTail(encoded, userHome) {
  const homePrefix = encodeProjectPath(userHome);
  let rest = homePrefix && encoded.toLowerCase().startsWith(homePrefix.toLowerCase()) ? encoded.slice(homePrefix.length) : encoded;
  rest = rest.replace(/^-+/, '');
  const runs = rest.split(/-{3,}/);
  let tail = runs[runs.length - 1];
  if (runs.length === 1) tail = rest.replace(/^(Desktop|Downloads|Documents|source|repos|Projects)-/i, '');
  return tail.replace(/^-+|-+$/g, '') || null;
}

function bigrams(s) {
  const t = String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function jaccard(a, b) {
  if (!a?.size || !b?.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function sourceKey(encoded, resolvedPath) {
  return `${encoded}|${resolvedPath ?? ''}`;
}

function modifiedOf(parsed, file) {
  const m = getField(parsed.data, 'metadata.modified');
  const t = Date.parse(m ?? '');
  return Number.isFinite(t) ? t : mtimeMs(file);
}

/**
 * 產生收編計畫。
 * @param {object} ctx
 * @param {{ encoded?: string }} [opts]
 * @returns {Promise<object>} SweepPlan
 */
export async function planSweep(ctx, { encoded: only } = {}) {
  await encodingIndex(ctx.homes, { maxAgeMs: 0 }); // SW-1：重建檔案系統的編碼索引，撞名判斷才完整
  const allScans = await scanAll(ctx.homes.claudeHome);
  const scans = allScans.filter((s) => !only || s.encoded.toLowerCase() === only.toLowerCase());
  const sessIdx = sessionIndex(allScans);
  const bindings = await readBindings(ctx.vault, ctx.mid);
  const projects = [];
  for (const pid of await listProjectIds(ctx.vault)) { const p = await readProject(ctx.vault, pid); if (p && !p.mergedInto) projects.push(p); }
  const hostnames = [os.hostname()];
  for (const mid of await listMachineIds(ctx.vault)) {
    const m = await readJson(path.join(machineDir(ctx.vault, mid), 'machine.json'), null);
    if (m?.hostname) hostnames.push(m.hostname);
  }

  // 常見位置三層內的資料夾：編碼反推與「搬到哪裡去了」的建議共用，整次規劃只走訪一次
  let dirCache = null;
  const allDirs = () => {
    if (!dirCache) { dirCache = []; walkDirs(ctx.homes.userHome, (d) => dirCache.push(d)); }
    return dirCache;
  };

  // ── 第一輪：依來源分組 ──
  // 每一筆記憶依序用：originSessionId 對到的對話紀錄 → 內文提到的資料夾（SW-3）→ 同資料夾唯一的對話紀錄 cwd
  // → 編碼反推（只在唯一對應時）。內文排在對話紀錄之前：撞名時，那個資料夾現存的對話紀錄可能屬於後來的另一個資料夾。
  // 已經收編、內容也沒變的檔案不再列入（與 H05 同一個依據）：撞名資料夾只用設定檔綁定、孤兒來源也不會綁定，
  // 原本的記憶資料夾都還在，否則每次產生計畫都會再出現，精靈也會誤報「還有資料夾的記憶尚未匯入」
  const swept = await readSweepLog(ctx.local);
  // 撞名改名（SW-4）之前的對話紀錄寫的是舊路徑：對應到改名後的位置，記憶才會歸到改名後的資料夾所屬的專案
  const { renamedPathMapper } = await import('./rename.mjs');
  const mapRenamed = await renamedPathMapper(ctx);
  const groups = new Map();
  for (const s of scans) {
    if (s.memory.isJunction || !s.memory.files.length) continue;
    if (Object.keys(bindings).some((k) => k.toLowerCase() === s.encoded.toLowerCase())) continue;
    const files = s.memory.files.filter((f) => !/^MEMORY\.md$/i.test(f));
    if (!files.length) continue;
    const done = new Map((swept[s.encoded]?.files ?? []).map((f) => [f.file.toLowerCase(), f.sha1]));
    let decoded = null;
    const resolved = [];
    for (const file of files) {
      const abs = path.join(s.memory.path, file);
      const text = (await readText(abs)) ?? '';
      // 已經收編、沒變的檔案不列入計畫，但照樣提供歸屬證據（同一個記憶資料夾之後才寫的記憶要跟著它）
      const swept = done.get(file.toLowerCase()) === sha1(text);
      const parsed = parseMemoryFile(text);
      const origin = getField(parsed.data, 'metadata.originSessionId');
      let resolvedPath = null;
      let how = 'unknown';
      let fromText = origin && sessIdx.has(String(origin)) ? null : contentPathFor(text, s.encoded, ctx.homes.userHome);
      // 內文路徑和磁碟上另一個同編碼的資料夾只差在英數符號、而且兩個都存在（例如 site-v2 與 site.v2）：
      // 兩者在 Claude Code 裡本來就撞名，不靠內文決定。內文提到的資料夾已不存在時，內文仍是最好的證據
      if (fromText && !s.roots.length && exists(fromText)) {
        decoded ??= decodeCandidates(s.encoded, allDirs());
        if (decoded.some((d) => !samePath(d, fromText) && differsInAscii(d, fromText))) fromText = null;
      }
      if (origin && sessIdx.has(String(origin))) { resolvedPath = memoryRootFor(sessIdx.get(String(origin))).root; how = 'origin-session'; }
      // 只有一個對話紀錄的資料夾時，內文路徑只在兩者差在中文字（真正的撞名）時才優先
      else if (fromText && !(s.roots.length === 1 && differsInAscii(fromText, s.roots[0]))) { resolvedPath = fromText; how = 'content-path'; }
      else if (s.roots.length === 1) { resolvedPath = s.roots[0]; how = 'transcript-cwd'; }
      resolved.push({ file, abs, text, parsed, resolvedPath: mapRenamed(resolvedPath), how, swept });
    }
    // 沒有對話紀錄時，其餘的記憶看整個記憶資料夾的證據（一個記憶資料夾本來就只屬於一個資料夾，除非撞名）：
    // - 其他記憶都指向同一個資料夾、磁碟上也沒有別的同編碼資料夾 → 跟著歸過去，不另外變成「未歸屬」來源
    // - 完全沒有其他證據 → 編碼反推（唯一對應時）
    // - 其他記憶指向的資料夾和磁碟上同編碼的資料夾不同（撞名）→ 無法判斷，不綁到剛好同編碼的資料夾
    const unknown = resolved.filter((r) => r.how === 'unknown');
    if (unknown.length && !s.roots.length) {
      const known = [...new Map(resolved.filter((r) => r.resolvedPath).map((r) => [r.resolvedPath.toLowerCase(), r])).values()];
      decoded ??= decodeCandidates(s.encoded, allDirs());
      let to = null;
      if (known.length === 1 && decoded.every((d) => samePath(d, known[0].resolvedPath))) to = { resolvedPath: known[0].resolvedPath, how: known[0].how };
      else if (!known.length && decoded.length === 1) to = { resolvedPath: decoded[0], how: 'decoded' };
      if (to) for (const r of unknown) Object.assign(r, to);
    }
    for (const { file, abs, text, parsed, resolvedPath, how, swept } of resolved) {
      if (swept) continue;
      // 分組不分大小寫（Windows 路徑），來源記下第一筆記憶寫的大小寫
      const key = process.platform === 'win32' ? sourceKey(s.encoded, resolvedPath).toLowerCase() : sourceKey(s.encoded, resolvedPath);
      if (!groups.has(key)) groups.set(key, { encoded: s.encoded, resolvedPath, how, srcDir: s.memory.path, files: [] });
      const g = groups.get(key);
      if (HOW_RANK[how] > HOW_RANK[g.how]) g.how = how;
      g.files.push({ file, abs, text, parsed, key: semanticKey(parsed), name: String(parsed.data?.name ?? file.replace(/\.md$/i, '')), modified: modifiedOf(parsed, abs) });
    }
  }

  // ── 第二輪：決定每個來源的目標專案 ──
  const list = [...groups.values()];
  const takenNames = new Set(projects.map((p) => p.name.toLowerCase()));
  const uniqueName = (base, root) => {
    let name = base;
    if (takenNames.has(name.toLowerCase()) && root) name = `${base}（${path.basename(path.dirname(root))}）`;
    takenNames.add(name.toLowerCase());
    return name;
  };
  // 先處理資料夾仍存在的來源
  for (const g of list) {
    g.exists = !!(g.resolvedPath && exists(g.resolvedPath));
    g.suggestions = [];
    if (!g.exists) continue;
    const res = await resolveIdentity(ctx, g.resolvedPath);
    if (res.pid) {
      g.target = { pid: res.pid, name: (await readProject(ctx.vault, res.pid))?.name ?? res.pid, isNew: false, archived: false };
      // 早就綁定到這個專案（executeSweep 不會重新綁定）：精靈的「將綁定」不計入
      const b = res.binding;
      if (b && b.state === 'active' && samePath(b.path, res.root)) g.target.boundPid = b.pid;
      continue;
    }
    g.target = { pid: null, name: uniqueName(path.basename(g.resolvedPath), g.resolvedPath), isNew: true, archived: false };
    // 身分解析只有中等信心的候選、或名稱與既有專案（含另一台電腦匯入的「未歸屬（X）」封存專案）相同：只建議，不自動連結
    for (const c of res.candidates ?? []) g.suggestions.push({ kind: 'project', pid: c.pid, name: c.name, reason: CANDIDATE_REASON[c.reason] ?? c.reason, en: { reason: CANDIDATE_REASON_EN[c.reason] ?? c.reason } });
    const ln = looseName(path.basename(g.resolvedPath));
    for (const p of projects) {
      if (!ln || g.suggestions.some((x) => x.pid === p.id) || !nameKeys(p).includes(ln)) continue;
      g.suggestions.push({
        kind: 'project', pid: p.id, name: p.name,
        reason: p.archived ? `名稱與封存專案「${p.name}」相同（可能是另一台電腦匯入時找不到資料夾）` : `名稱與既有專案「${p.name}」相同`,
        en: { reason: p.archived ? `Same name as the archived project "${p.name}" (the other computer may not have found the folder when importing)` : `Same name as the existing project "${p.name}"` },
      });
    }
  }
  const liveSources = list.filter((g) => g.exists);
  for (const g of list) {
    if (g.exists) continue;
    const base = g.resolvedPath ? path.basename(g.resolvedPath) : encodedTail(g.encoded, ctx.homes.userHome);
    const ln = looseName(base);
    // (a) 同名的既有專案
    const proj = ln ? projects.find((p) => nameKeys(p).includes(ln)) : null;
    // (b) 同一份計畫裡、資料夾仍存在的同名來源
    const sibling = ln ? liveSources.find((s) => looseName(path.basename(s.resolvedPath)) === ln) : null;
    if (g.resolvedPath && proj) {
      g.target = { pid: proj.id, name: proj.name, isNew: false, archived: !!proj.archived };
    } else {
      g.target = { pid: null, name: g.resolvedPath ? uniqueName(base, g.resolvedPath) : `未歸屬（${base ?? g.encoded}）`, isNew: true, archived: true };
      // 只建議、不自動連結
      if (proj) g.suggestions.push({ kind: 'project', pid: proj.id, name: proj.name, reason: `名稱與既有專案「${proj.name}」相同`, en: { reason: `Same name as the existing project "${proj.name}"` } });
      // 另一台電腦匯入同一個編碼資料夾時建立的封存專案（名稱只有編碼，無法用名稱比對）
      const sameOrigin = !g.resolvedPath && !proj ? projects.find((p) => p.name === `未歸屬（${g.encoded}）`) : null;
      if (sameOrigin) g.suggestions.push({ kind: 'project', pid: sameOrigin.id, name: sameOrigin.name, reason: '另一台電腦匯入同一個編碼資料夾時建立的封存專案', en: { reason: 'Archived project created when the other computer imported the same encoded folder' } });
      if (sibling) g.suggestions.push({ kind: 'source', sameAs: sourceKey(sibling.encoded, sibling.resolvedPath), name: sibling.target.name, path: sibling.resolvedPath, reason: `名稱與這次匯入的 ${sibling.resolvedPath} 相同`, en: { reason: `Same name as ${sibling.resolvedPath} in this import` } });
      if (ln && !sibling) {
        // 原路徑已知（內文或對話紀錄）但不在了：同名的資料夾可能就是搬過去的新位置
        const reason = g.resolvedPath ? `原資料夾 ${g.resolvedPath} 已不存在；這裡有同名的資料夾，可能是搬過來的` : '資料夾名稱與編碼尾段相符';
        const reasonEn = g.resolvedPath ? `The original folder ${g.resolvedPath} no longer exists; a folder with the same name is here and may have been moved` : 'The folder name matches the end of the encoded name';
        for (const dir of allDirs()) {
          if (g.suggestions.length >= 5) break;
          if (looseName(path.basename(dir)) === ln && !samePath(dir, g.resolvedPath)) g.suggestions.push({ kind: 'path', path: normalizeFsPath(dir), reason, en: { reason: reasonEn } });
        }
      }
    }
  }

  // ── 第三輪：逐筆決定動作 ──
  const vaultByKey = new Map();
  // 同一筆記憶的不同版本：frontmatter 的 name 相同，或檔名相同（舊版本的 name 可能和新版不同）
  const versions = new Map(); // 'n:<name>' 或 'f:<檔名>' → [{ where, key, modified, inVault }]
  const addVersion = (k, v) => { if (!versions.has(k)) versions.set(k, []); versions.get(k).push(v); };
  for (const m of await ctx.scan()) {
    // 別台電腦的單機記憶不算：這台的同名或相同內容是這台自己的環境事實，不是重複或舊版本（否則匯入時被略過，只留在備份）
    if (m.scope?.kind === 'machine' && m.scope.mid !== ctx.mid) continue;
    vaultByKey.set(semanticKey(m._parsed), m.ref);
    const v = { where: m.ref, key: semanticKey(m._parsed), modified: Date.parse(m.updatedAt ?? '') || 0, inVault: true, sig: bigrams(`${m.name} ${m.description}`) };
    addVersion(`n:${m.name.toLowerCase()}`, v);
    addVersion(`f:${path.posix.basename(m.ref).toLowerCase()}`, v);
  }
  for (const g of list) for (const f of g.files) {
    f.sig = bigrams(`${f.name} ${f.parsed.data?.description ?? ''}`);
    const v = { where: `${g.target.pid ?? g.target.name}/${f.file}`, key: f.key, modified: f.modified, inVault: false, sig: f.sig };
    addVersion(`n:${f.name.toLowerCase()}`, v);
    addVersion(`f:${f.file.toLowerCase()}`, v);
  }
  const plannedKeys = new Map();
  const sources = [];
  for (const g of list) {
    const destDir = g.target.pid ? projectMemoryDir(ctx.vault, g.target.pid) : null;
    const items = [];
    for (const f of g.files) {
      const type = String(getField(f.parsed.data, 'metadata.type') ?? '');
      const sug = suggestScope({ type, text: f.text, hostnames });
      const where = `${g.target.pid ?? g.target.name}/${f.file}`;
      const seen = new Set();
      // 同名或同檔名，而且名稱加描述相似（避免把不同專案裡剛好都叫 deploy 的記憶當成新舊版本）
      const sameName = [...(versions.get(`n:${f.name.toLowerCase()}`) ?? []), ...(versions.get(`f:${f.file.toLowerCase()}`) ?? [])]
        .filter((x) => x.key !== f.key && x.where !== where && jaccard(f.sig, x.sig) >= 0.5 && !seen.has(x.where) && seen.add(x.where));
      const newer = sameName.filter((x) => x.modified > f.modified).sort((a, b) => b.modified - a.modified)[0];
      let action = 'copy';
      let reason = sug.reason;
      let reasonEn = sug.en.reason;
      let dupOf;
      if (vaultByKey.has(f.key)) { action = 'skip-same'; dupOf = vaultByKey.get(f.key); reason = 'vault 裡已有相同內容'; reasonEn = 'The vault already has the same content'; }
      else if (plannedKeys.has(f.key)) { action = 'skip-same'; dupOf = plannedKeys.get(f.key); reason = '這次匯入的其他來源已有相同內容'; reasonEn = 'Another source in this import has the same content'; }
      else if (newer) { action = 'superseded'; dupOf = newer.where; reason = '較舊版本，內容保留在原處'; reasonEn = 'Older version; its content stays in the original location'; }
      else if (sameName.some((x) => x.inVault)) { action = 'merge-candidate'; dupOf = sameName.find((x) => x.inVault).where; reason = 'vault 裡有同名但較舊的版本，建議合併'; reasonEn = 'The vault has an older version with the same name; merging is suggested'; }
      else if (destDir && exists(path.join(destDir, f.file))) { action = 'rename'; reason = '目標專案已有同名檔案'; reasonEn = 'The target project already has a file with the same name'; }
      if (action !== 'skip-same' && action !== 'superseded') plannedKeys.set(f.key, where);
      const desc = String(f.parsed.data?.description ?? '').replace(/\s+/g, ' ').trim();
      items.push({ file: f.file, name: f.name, type, description: desc.length > 120 ? `${desc.slice(0, 119)}…` : desc, action, scope: sug.scope, reason, en: { reason: reasonEn }, ...(dupOf ? { dupOf } : {}) });
    }
    sources.push({
      encoded: g.encoded,
      resolvedPath: g.resolvedPath,
      how: g.how,
      exists: g.exists,
      target: g.target,
      suggestions: g.suggestions,
      items,
    });
  }

  const totals = { sources: sources.length, memories: 0, copy: 0, skip: 0, superseded: 0, global: 0, machine: 0, archived: 0, unknown: 0 };
  for (const s of sources) {
    totals.memories += s.items.length;
    // 沒有任何記憶留在專案範圍的孤兒來源不會建立封存專案（executeSweep），不計入
    if (s.target.archived && s.items.some((it) => !NO_COPY.has(it.action) && (it.scope ?? 'project') === 'project')) totals.archived++;
    if (s.how === 'unknown') totals.unknown++;
    for (const it of s.items) {
      if (it.action === 'skip-same') totals.skip++;
      else if (it.action === 'superseded') totals.superseded++;
      else {
        totals.copy++;
        if (it.scope === 'global') totals.global++;
        if (it.scope === 'machine') totals.machine++;
      }
    }
  }
  return { sources, totals, _srcDirs: Object.fromEntries(list.map((g) => [sourceKey(g.encoded, g.resolvedPath), g.srcDir])) };
}

/** 不複製的動作。 */
const NO_COPY = new Set(['skip-same', 'superseded', 'skip']);

/**
 * 依計畫執行。plan 可由精靈修改：改 item.action（'copy'、'rename'、'merge-candidate' 會複製；'skip-same'、'superseded'、'skip' 不複製）、
 * 改 item.scope、改 target.pid（連結到既有專案）、或設 target.sameAs = '<encoded>|<resolvedPath>'（跟另一個來源用同一個專案）。
 * @param {{ bindSources?: boolean }} [opts]  bindSources：收編後把來源資料夾換成 junction（預設 true）
 */
export async function executeSweep(ctx, plan, { bindSources = true } = {}) {
  const result = { ok: true, sources: 0, copied: 0, skipped: 0, bound: [], deferred: [], backupOnly: [], commits: [], restorePoint: null };
  const log = (await readJson(path.join(ctx.local, 'sweep.json'), {})) ?? {};
  // 還原點：本機 tag（不會推到遠端）＋ 匯入紀錄，讓「一鍵還原」能處理部分完成的狀態
  const head = (await git(['rev-parse', 'HEAD'], { cwd: ctx.vault })).stdout.trim();
  // 還原點名稱必須唯一：同一秒內的多次匯入（例如常駐程式連續收編幾個資料夾）若共用一個 tag，
  // 還原時會找到別次匯入的紀錄、還原錯對象
  const base = `engram-import-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  const taken = new Set((log._imports ?? []).map((r) => r.tag));
  const tagExists = async (t) => (await git(['rev-parse', '-q', '--verify', `refs/tags/${t}`], { cwd: ctx.vault, allowFail: true })).code === 0;
  let tag = base;
  for (let i = 2; taken.has(tag) || await tagExists(tag); i++) tag = `${base}-${i}`;
  await git(['tag', tag, head], { cwd: ctx.vault });
  result.restorePoint = tag;
  const record = { tag, head, at: new Date().toISOString(), sources: [], commits: [] };
  log._imports = [...(log._imports ?? []), record];
  await writeJson(path.join(ctx.local, 'sweep.json'), log);
  const pidByKey = new Map();
  const toBind = [];
  const ordered = [...plan.sources].sort((a, b) => Number(!!a.target?.sameAs) - Number(!!b.target?.sameAs));
  try {
  for (const src of ordered) {
    const key = sourceKey(src.encoded, src.resolvedPath);
    const srcDir = plan._srcDirs?.[key] ?? path.join(ctx.homes.claudeHome, 'projects', src.encoded, 'memory');
    const done = await ctx.locked('sweep', async () => {
      // 這一步開始前已經存在的未提交變更（例如 Claude 剛寫的別的記憶）：失敗時不能動到它們
      const before = await dirtySet(ctx.vault);
      const stepPaths = [];
      try {
      let id = src.target.pid ?? (src.target.sameAs ? pidByKey.get(src.target.sameAs) : null);
      const byScope = { project: [], global: [], machine: [] };
      for (const it of src.items) {
        if (NO_COPY.has(it.action)) { result.skipped++; continue; }
        byScope[it.scope ?? 'project'].push(it.file);
      }
      // 原資料夾已不存在、記憶也全都進了全域或單機（或略過）：不建立沒有內容、也不會綁定的空封存專案
      if (!id && (src.exists || byScope.project.length)) {
        const gi = src.exists ? await gitIdentity(memoryRootFor(src.resolvedPath).git) : { remotes: [], rootCommits: [] };
        const p = await createProject(ctx, { name: src.target.name, root: src.exists ? src.resolvedPath : null, archived: !!src.target.archived, ...gi });
        if (!src.exists && src.resolvedPath) {
          p.aliases = [path.basename(src.resolvedPath)];
          const { writeProject } = await import('./vault.mjs');
          await writeProject(ctx.vault, p);
        }
        id = p.id;
      }
      src.target.pid = id ?? null;
      if (id) stepPaths.push(`projects/${id}`);
      const touched = id ? [`projects/${id}`] : [];
      const imported = []; // { from, destRef }：還原時用來把匯入後的修改放回原處（R-47）
      if (byScope.project.length) {
        const r = await copyMemoriesInto(srcDir, projectMemoryDir(ctx.vault, id), { files: byScope.project });
        result.copied += r.copied.length; result.skipped += r.skipped.length;
        for (const c of r.copied) imported.push({ from: c.from, destRef: `projects/${id}/memory/${c.to}` });
      }
      for (const kind of ['global', 'machine']) {
        if (!byScope[kind].length) continue;
        const scope = kind === 'global' ? { kind } : { kind, mid: ctx.mid };
        const dest = scopeDir(ctx.vault, scope);
        await fsp.mkdir(dest, { recursive: true });
        for (const f of byScope[kind]) {
          const text = await readText(path.join(srcDir, f));
          if (text === null) continue;
          const name = uniqueFileName(f, (n) => exists(path.join(dest, n)));
          await safeWrite(path.join(dest, name), text);
          touched.push(toRef(ctx.vault, path.join(dest, name)));
          imported.push({ from: f, destRef: toRef(ctx.vault, path.join(dest, name)) });
          result.copied++;
        }
      }
      const { refreshIndex } = await import('./memories.mjs');
      if (id) touched.push(...await refreshIndex(ctx, { kind: 'project', pid: id }));
      if (byScope.global.length) touched.push(...await refreshIndex(ctx, { kind: 'global' }));
      if (byScope.machine.length) touched.push(...await refreshIndex(ctx, { kind: 'machine', mid: ctx.mid }));
      const label = src.resolvedPath ? path.basename(src.resolvedPath) : src.encoded;
      const commit = await commitPaths(ctx.vault, touched, `sweep ${src.items.length} memories from ${label}`, { action: 'sweep', mid: ctx.mid, trailers: { 'Engram-Import': tag } });
      if (commit) { result.commits.push(commit.sha); record.commits.push(commit.sha); }
      for (const it of imported) it.sha = commit?.sha ?? null;
      // 記錄已收編的檔案與雜湊：之後 H05 只回報新的或改過的檔案
      const files = [];
      for (const it of src.items) {
        const t = await readText(path.join(srcDir, it.file));
        if (t !== null) files.push({ file: it.file, sha1: sha1(t), action: it.action });
      }
      const prev = log[src.encoded]?.files ?? [];
      const merged = new Map(prev.map((f) => [f.file, f]));
      for (const f of files) merged.set(f.file, f);
      log[src.encoded] = { at: new Date().toISOString(), pid: id ?? null, resolvedPath: src.resolvedPath, files: [...merged.values()] };
      return { id: id ?? null, imported };
      } catch (err) {
        // 失敗的這一步寫進 vault、但沒有 commit 的檔案全部撤銷，避免還原時被當成「匯入後新寫的記憶」
        await revertStep(ctx.vault, [...stepPaths, 'global', `machines/${ctx.mid}`], before).catch(() => {});
        throw err;
      }
    });
    const pid = done.id;
    pidByKey.set(key, pid);
    result.sources++;
    const rec = { encoded: src.encoded, resolvedPath: src.resolvedPath, pid, bound: false, srcDir, items: done.imported };
    record.sources.push(rec);
    if (bindSources && src.exists && src.resolvedPath) toBind.push({ src, rec });
    await writeJson(path.join(ctx.local, 'sweep.json'), log);
  }
  // 全部來源都複製完才綁定：同一個編碼資料夾可能拆成好幾個來源（撞名、內文路徑、改名），
  // 換成 junction 前要比對的「已收編檔案」必須包含所有來源，否則會被誤判為規劃後有變更而延後
  const { findBindingByPath } = await import('./vault.mjs');
  for (const { src, rec } of toBind) {
    // 這個資料夾早就綁定到同一個專案（例如上一次匯入、或對話開始時自動綁定）：不重新綁定。
    // 否則還原這一次匯入時，會把不是這次建立的綁定一起拆掉
    const existing = findBindingByPath(await readBindings(ctx.vault, ctx.mid), memoryRootFor(src.resolvedPath).root);
    if (existing && existing.pid === rec.pid && existing.state === 'active') {
      Object.assign(rec, { preBound: true });
      continue;
    }
    const bindEnc = encodeProjectPath(memoryRootFor(src.resolvedPath).root) ?? src.encoded;
    const expectFiles = Object.entries(log).find(([k]) => k !== '_imports' && k.toLowerCase() === bindEnc.toLowerCase())?.[1]?.files ?? [];
    const b = await bind(ctx, src.resolvedPath, { pid: rec.pid }, { mode: 'safe', preCopied: true, expectFiles, importTag: tag });
    if (b.commit) record.commits.push(b.commit.sha);
    Object.assign(rec, { bound: true, method: b.method, backup: b.backup ?? null, bindEncoded: b.encoded, state: b.state });
    if (b.state === 'pending') result.deferred.push({ path: src.resolvedPath, reason: b.deferredReason });
    else result.bound.push({ path: src.resolvedPath, method: b.method });
    if (b.backupOnly) result.backupOnly.push(...b.backupOnly);
    await writeJson(path.join(ctx.local, 'sweep.json'), log);
  }
  } catch (err) {
    // 中途失敗：已完成的來源留在紀錄裡，附上還原點讓呼叫端可以一鍵還原（部分完成）
    record.failedAt = new Date().toISOString();
    record.error = err?.message ?? String(err);
    await writeJson(path.join(ctx.local, 'sweep.json'), log).catch(() => {});
    if (err && typeof err === 'object') {
      err.restorePoint = tag;
      if (err.details && typeof err.details === 'object') err.details.restorePoint = tag;
      else if (err.code) err.details = { restorePoint: tag };
    }
    throw err;
  }
  await writeJson(path.join(ctx.local, 'sweep.json'), log);
  return result;
}

/** vault 目前所有未提交的路徑。 */
async function dirtySet(vaultDir) {
  const { parseStatusZ } = await import('./git.mjs');
  const st = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: vaultDir });
  return new Set(parseStatusZ(st.stdout).map((i) => i.path));
}

/** 撤銷某一步在 scopes（vault 相對路徑或資料夾）裡新產生的未提交變更；before 裡已經存在的不動。 */
async function revertStep(vaultDir, scopes, before) {
  const { parseStatusZ } = await import('./git.mjs');
  const existing = scopes.filter((p) => exists(path.join(vaultDir, ...p.split('/'))));
  if (!existing.length) return;
  await git(['reset', '-q', '--', ...existing], { cwd: vaultDir, allowFail: true }); // commit 失敗時可能已經 stage
  const st = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...existing], { cwd: vaultDir });
  for (const it of parseStatusZ(st.stdout)) {
    if (before.has(it.path)) continue;
    const abs = path.join(vaultDir, ...it.path.split('/'));
    if (it.x === '?' && it.y === '?') fs.rmSync(abs, { force: true });
    else await git(['checkout', 'HEAD', '--', it.path], { cwd: vaultDir, allowFail: true });
  }
  // 這一步建立、現在已經空掉的專案資料夾
  for (const p of scopes.filter((x) => x.startsWith('projects/'))) {
    const dir = path.join(vaultDir, ...p.split('/'));
    const tracked = await git(['ls-files', '--', p], { cwd: vaultDir, allowFail: true });
    if (exists(dir) && !tracked.stdout.trim()) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 回到原處時保留最新內容（R-47）：原處已有不同的版本就改名成 .pre-rollback，兩份都留著。 */
async function restoreLatest(target, latest, importVer) {
  const cur = exists(target) ? await readText(target) : null;
  if (cur === null) { await safeWrite(target, latest); return 'copied'; }
  if (cur === latest) return 'same';
  if (importVer !== null && latest === importVer) return 'kept-original'; // vault 在匯入後沒改過：原處的版本就是最新
  let aside = `${target}.pre-rollback`;
  for (let i = 2; exists(aside); i++) aside = `${target}.pre-rollback-${i}`;
  fs.renameSync(target, aside);
  await safeWrite(target, latest);
  return 'updated';
}

/**
 * 一鍵還原一次匯入（可處理部分完成）。語意：撤銷綁定與匯入的結構，保留最新的內容。
 * - 換成 junction 的資料夾還原成備份，再把 vault 裡「匯入後改過」或「匯入後新增」的記憶放回去（R-47）
 * - 全域、單機與設定檔備援的匯入項目，匯入後改過的也放回原本的記憶資料夾
 * - 依綁定足跡把使用者資料夾清乾淨：設定檔、exclude 行、標記檔、空的 .claude（R-48）
 * - vault 端：這次匯入動過的檔案回到匯入前（tag）的狀態；最新內容已放回原處，所以刪除不會遺失
 */
export async function rollbackImport(ctx, tag) {
  return ctx.locked('sweep.rollback', async () => {
    const log = (await readJson(path.join(ctx.local, 'sweep.json'), {})) ?? {};
    const record = (log._imports ?? []).find((r) => r.tag === tag);
    if (!record) throw new EngramError(E.NOT_FOUND, `找不到匯入紀錄：${tag}`).withEn(`Import record not found: ${tag}`);
    const restored = [];
    const updated = [];
    const { readBindings, writeBindings, allBindingViews } = await import('./vault.mjs');
    const { cleanupFootprint } = await import('./identity.mjs');
    const bindings = await readBindings(ctx.vault, ctx.mid);
    const importVersion = async (it) => {
      if (!it.sha) return null;
      const r = await git(['show', `${it.sha}:${it.destRef}`], { cwd: ctx.vault, allowFail: true });
      return r.code === 0 ? r.stdout : null;
    };
    // 1. 先把所有換成 junction 的記憶資料夾放回原本的實體資料夾，再處理各來源的記憶：
    //    同一個編碼資料夾可能拆成好幾個來源；若邊還原邊寫，前面的來源會經由別人還沒拆掉的 junction 寫進那個專案
    for (const s of record.sources) {
      if (!(s.bound && s.method === 'junction')) continue;
      const memPath = memoryPathFor(ctx.homes, s.bindEncoded ?? s.encoded);
      if (isLink(memPath)) fs.rmdirSync(memPath);
      if (s.backup && exists(s.backup)) {
        if (exists(memPath)) fs.renameSync(memPath, `${memPath}.engram-${Date.now()}`); // 不刪除任何東西
        fs.renameSync(s.backup, memPath);
      } else {
        await fsp.mkdir(memPath, { recursive: true });
      }
      await revokeJunctionRead(ctx.homes, memPath).catch(() => {});
    }
    for (const s of record.sources) {
      const vaultDir = s.pid ? projectMemoryDir(ctx.vault, s.pid) : null; // 沒有建立專案的來源（SW-3）沒有專案資料夾
      // 匯入的記憶回到它來自的資料夾；綁定期間新寫的記憶回到綁定那個資料夾的記憶位置（改綁到別的資料夾時兩者不同）
      const itemsDir = s.srcDir ?? memoryPathFor(ctx.homes, s.encoded);
      const addedDir = memoryPathFor(ctx.homes, s.bindEncoded ?? s.encoded);
      await fsp.mkdir(itemsDir, { recursive: true });
      // 2. 匯入項目：vault 裡匯入後改過的版本放回原處
      const itemFiles = new Set();
      for (const it of s.items ?? []) {
        itemFiles.add(path.posix.basename(it.destRef).toLowerCase());
        const abs = path.join(ctx.vault, ...it.destRef.split('/'));
        const latest = exists(abs) ? await readText(abs) : null;
        if (latest === null) continue; // 匯入後被刪除：原處的版本保留
        const r = await restoreLatest(path.join(itemsDir, it.from), latest, await importVersion(it));
        if (r === 'updated' || r === 'copied') updated.push(path.join(itemsDir, it.from));
      }
      // 3. 綁定期間在 vault 專案資料夾新增的記憶，也放回原處（連同 MEMORY.md 的提示行）。
      //    還原點當時專案裡就有的記憶（例如另一台電腦寫的）不是這次新增的，不放
      const restoreDir = addedDir;
      if (s.bound && vaultDir) {
        await fsp.mkdir(restoreDir, { recursive: true });
        const atTag = await git(['ls-tree', '--name-only', `${tag}:projects/${s.pid}/memory`], { cwd: ctx.vault, allowFail: true });
        const before = new Set(atTag.code === 0 ? atTag.stdout.split('\n').map((n) => n.trim().toLowerCase()).filter(Boolean) : []);
        const vaultIdx = (await readText(path.join(vaultDir, 'MEMORY.md'))) ?? '';
        const added = [];
        for (const n of await listMarkdown(vaultDir, { exclude: ['MEMORY.md'] })) {
          if (itemFiles.has(n.toLowerCase()) || before.has(n.toLowerCase())) continue;
          const latest = await readText(path.join(vaultDir, n));
          if (latest === null) continue;
          const r = await restoreLatest(path.join(restoreDir, n), latest, null);
          if (r === 'copied' || r === 'updated') { updated.push(path.join(restoreDir, n)); added.push(n); }
        }
        if (added.length) {
          const idxPath = path.join(restoreDir, 'MEMORY.md');
          const cur = (await readText(idxPath)) ?? '';
          const lines = vaultIdx.split(/\r?\n/).filter((l) => added.some((n) => l.includes(`](${n})`)) && !cur.includes(l));
          if (lines.length) await safeWrite(idxPath, `${cur.replace(/\n*$/, cur ? '\n' : '')}${lines.join('\n')}\n`);
        }
      }
      // 4. 這次匯入建立的綁定在使用者資料夾留下的足跡清乾淨（原本就綁定好、這次沒有重新綁定的不動）
      for (const v of allBindingViews(bindings)) {
        if (!s.bound || v.pid !== s.pid || !v.path || !s.resolvedPath || v.path.toLowerCase() !== s.resolvedPath.toLowerCase()) continue;
        if (v.footprint) await cleanupFootprint(s.resolvedPath, v.footprint);
        else if (v.method === 'settings') {
          const p = path.join(s.resolvedPath, '.claude', 'settings.local.json');
          const cur = await readJson(p, null);
          if (cur && 'autoMemoryDirectory' in cur) { delete cur.autoMemoryDirectory; await safeWrite(p, `${JSON.stringify(cur, null, 2)}\n`); }
        }
        delete bindings[v.key];
      }
      // 沒有綁定的來源，這次匯入沒有在它的資料夾寫過任何東西（標記檔只由綁定建立，並依足跡清除）。
      // 不可以刪資料夾裡的標記檔：演練時 resolvedPath 是真實資料夾，會刪到使用者本來就有的綁定
      restored.push(s.resolvedPath ?? s.encoded);
    }
    await writeBindings(ctx.vault, ctx.mid, bindings);
    // vault 端逐檔回到 tag（不用 git revert：同一次匯入的 sweep 與 bind commit 交錯、又都改 bindings.json，逐筆 revert 會互相衝突）
    const bindingsRef = `machines/${ctx.mid}/bindings.json`;
    const touched = new Set();
    for (const sha of record.commits) {
      const r = await git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', sha], { cwd: ctx.vault, allowFail: true });
      for (const p of r.stdout.split('\0').filter(Boolean)) if (p !== bindingsRef) touched.add(p);
    }
    // 這次匯入寫進 vault 的檔案一律納入：含疑似金鑰而被扣住的不在上面的 commit 裡，也要清掉（原檔已在前面放回原處；
    // 匯入時用不撞名的新檔名寫入，所以 tag 當時都不存在）
    for (const s of record.sources) for (const it of s.items ?? []) if (it.destRef) touched.add(it.destRef);
    for (const p of touched) {
      const atTag = await git(['cat-file', '-e', `${tag}:${p}`], { cwd: ctx.vault, allowFail: true });
      if (atTag.code === 0) await git(['checkout', tag, '--', p], { cwd: ctx.vault });
      else {
        await git(['rm', '-q', '--cached', '--ignore-unmatch', '--', p], { cwd: ctx.vault });
        fs.rmSync(path.join(ctx.vault, ...p.split('/')), { force: true });
      }
    }
    // 匯入時建立的專案資料夾：內容都已放回原處，一併移除
    for (const s of record.sources) {
      if (!s.pid) continue;
      const dir = path.join(ctx.vault, 'projects', s.pid);
      if (exists(dir) && (await git(['cat-file', '-e', `${tag}:projects/${s.pid}/project.json`], { cwd: ctx.vault, allowFail: true })).code !== 0) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    const { commitPaths: commit } = await import('./vault.mjs');
    await commit(ctx.vault, [...touched, bindingsRef, ...record.sources.filter((s) => s.pid).map((s) => `projects/${s.pid}`)], `rollback import ${tag}`, { action: 'rollback', mid: ctx.mid });
    log._imports = log._imports.map((r) => (r.tag === tag ? { ...r, rolledBackAt: new Date().toISOString() } : r));
    for (const s of record.sources) delete log[s.encoded];
    await writeJson(path.join(ctx.local, 'sweep.json'), log);
    return { ok: true, restored, updated };
  });
}

/** 讀收編紀錄（health 的 H05 用）。 */
export async function readSweepLog(localDir) {
  return (await readJson(path.join(localDir, 'sweep.json'), {})) ?? {};
}
