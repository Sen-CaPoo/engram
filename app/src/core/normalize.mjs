// 索引正規化：專案 MEMORY.md（Claude 與引擎共同維護）與全域／單機 INDEX.md（引擎完全產生）。
// 規則見 40 號文件 §12。兩者都必須冪等：連續執行兩次結果一字不差。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { engramMeta, getField, parseMemoryFile } from './frontmatter.mjs';
import { exists, listMarkdown, mtimeMs, readText, safeWrite, sha1 } from './fsx.mjs';
import { git } from './git.mjs';
import { toTildePath } from './paths.mjs';
import { loadAllow, scanWithAllow } from './secretallow.mjs';
import { redactSecrets, scanSecrets } from './secrets.mjs';

export const PROJECT_INDEX = 'MEMORY.md';
export const SCOPE_INDEX = 'INDEX.md';
export const INDEX_BUDGET = { global: 60, machine: 30 };
const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/;

/** 同資料夾的連結目標（./x.md 或 x.md）；其他（子資料夾、網址）回傳 null。 */
function localTarget(target) {
  const t = decodeURI(target.replace(/^\.\//, ''));
  if (!/\.md$/i.test(t) || t.includes('/') || t.includes('\\') || /^[a-z]+:/i.test(t)) return null;
  return t;
}

/** 索引的一行：先遮蔽疑似金鑰再截斷（索引每個對話都會載入；含金鑰的索引也會被扣住、讓同步卡住） */
function oneLine(s, max = 160) {
  const t = redactSecrets(String(s ?? '')).text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * 正規化 MEMORY.md 文字。
 * @param {string} text  目前內容（可為空字串）
 * @param {{ file: string, name: string, description: string, pinned: boolean }[]} files  資料夾內實際的記憶檔
 * @param {{ appendOnly?: boolean }} [opts]  appendOnly：進行中對話時只附加，不刪不排（R-08）
 */
export function normalizeMemoryIndexText(text, files, { appendOnly = false } = {}) {
  const src = String(text ?? '').replace(/\r\n/g, '\n');
  const lines = src.length ? src.replace(/\n+$/, '').split('\n') : [];
  const byFile = new Map(files.map((f) => [f.file.toLowerCase(), f]));
  const seen = new Map(); // target(lower) → 保留下來的行在 out 中的位置

  /** @type {{ raw: string, target: string|null }[]} */
  const out = [];
  for (const raw of lines) {
    const m = LINK_RE.exec(raw);
    const target = m ? localTarget(m[2]) : null;
    if (!target) { out.push({ raw, target: null }); continue; }
    const key = target.toLowerCase();
    if (appendOnly) { out.push({ raw, target: key }); seen.set(key, out.length - 1); continue; }
    if (!byFile.has(key)) continue; // 指向不存在的檔案（H02）
    if (seen.has(key)) {
      const idx = seen.get(key);
      if (raw.length > out[idx].raw.length) out[idx].raw = raw; // 保留較長的那行，位置以先出現者為準
      continue;
    }
    seen.set(key, out.length);
    out.push({ raw, target: key });
  }

  // 補上沒列在索引的檔案（H03）
  for (const f of files) {
    const key = f.file.toLowerCase();
    if (seen.has(key)) continue;
    const label = oneLine(f.name || f.file.replace(/\.md$/i, ''), 80);
    const desc = oneLine(f.description);
    out.push({ raw: `- [${label}](${f.file})${desc ? ` — ${desc}` : ''}`, target: key });
    seen.set(key, out.length - 1);
  }

  let result = out;
  if (!appendOnly) {
    // 釘選項目移到連結清單最前面（保持彼此原本順序）
    const pinned = new Set(files.filter((f) => f.pinned).map((f) => f.file.toLowerCase()));
    if (pinned.size) {
      const firstLink = out.findIndex((l) => l.target);
      const pinnedLines = out.filter((l) => l.target && pinned.has(l.target));
      const rest = out.filter((l) => !(l.target && pinned.has(l.target)));
      const insertAt = rest.findIndex((l, i) => l.target && i >= Math.min(firstLink, rest.length));
      const at = insertAt === -1 ? rest.length : insertAt;
      result = [...rest.slice(0, at), ...pinnedLines, ...rest.slice(at)];
    }
  }
  const body = result.map((l) => l.raw).join('\n');
  return body.length ? `${body}\n` : '';
}

function gitRoot(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (exists(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

/**
 * 索引會同步，所以依「已同步的內容」產生：含疑似金鑰而被扣住的檔案只在這台電腦，
 * 沒進過 git 的不列入；進過的用 HEAD 版本。不然沒有這個檔案（或只有舊版）的另一台電腦會把索引改回去，
 * 兩台電腦每一輪同步都互相改寫索引，commit 數不停增加。回傳 檔名 → 文字（null＝不列入）。
 */
async function syncedTexts(dir, names) {
  const texts = new Map();
  for (const n of names) texts.set(n, await readText(path.join(dir, n)));
  const flagged = names.filter((n) => texts.get(n) && scanSecrets(texts.get(n)).length);
  const root = flagged.length ? gitRoot(dir) : null;
  if (!root) return texts;
  const allow = await loadAllow(path.join(path.dirname(root), 'local'));
  const held = [];
  for (const n of flagged) {
    const ref = path.relative(root, path.join(dir, n)).split(path.sep).join('/');
    if (scanWithAllow(texts.get(n), ref, allow).length) held.push({ n, ref });
  }
  if (!held.length) return texts;
  // 一次問 git 哪些進過歷史（SessionStart 也會走到這裡，不要每個檔案各啟動一次 git）；只有進過的才需要讀 HEAD 版本
  const ls = await git(['ls-files', '-z', '--', ...held.map((h) => h.ref)], { cwd: root, allowFail: true });
  const tracked = new Set(ls.stdout.split('\0').filter(Boolean));
  for (const { n, ref } of held) {
    if (!tracked.has(ref)) { texts.set(n, null); continue; }
    const head = await git(['show', `HEAD:${ref}`], { cwd: root, allowFail: true });
    texts.set(n, head.code === 0 ? head.stdout : null);
  }
  return texts;
}

/** 讀資料夾內記憶檔的摘要（給索引用）。skipRecentMs 內被改過的檔案仍列入（只是不會被引擎改寫）。被扣住的檔案依 syncedTexts 處理。 */
export async function readDirEntries(dir, { exclude = [PROJECT_INDEX, SCOPE_INDEX] } = {}) {
  const names = await listMarkdown(dir, { exclude });
  const texts = await syncedTexts(dir, names);
  const entries = [];
  for (const file of names) {
    const text = texts.get(file);
    if (text == null) continue;
    const parsed = parseMemoryFile(text);
    const em = engramMeta(parsed.data);
    entries.push({
      file,
      name: String(parsed.data?.name ?? ''),
      description: String(parsed.data?.description ?? ''),
      type: String(getField(parsed.data, 'metadata.type') ?? parsed.data?.type ?? ''),
      modified: String(getField(parsed.data, 'metadata.modified') ?? ''),
      pinned: em?.pinned === true || em?.pinned === 'true',
      project: em?.project ? String(em.project) : null,
      bytes: Buffer.byteLength(text, 'utf8'),
    });
  }
  return entries;
}

/**
 * 正規化某專案的 MEMORY.md。
 * @returns {Promise<{ changed: boolean, skipped?: string }>}
 */
export async function normalizeProjectIndex(memDir, { appendOnly = false, skipRecentMs = 10_000, now = Date.now() } = {}) {
  const indexPath = path.join(memDir, PROJECT_INDEX);
  if (skipRecentMs && now - mtimeMs(indexPath) < skipRecentMs) return { changed: false, skipped: 'recent' };
  const files = await readDirEntries(memDir);
  const current = await readText(indexPath);
  if (current === null && files.length === 0) return { changed: false };
  const next = normalizeMemoryIndexText(current ?? '', files, { appendOnly });
  if (current !== null && next === current.replace(/\r\n/g, '\n')) return { changed: false };
  if (current === next) return { changed: false };
  const ok = await safeWrite(indexPath, next, { expectHash: current === null ? null : sha1(current) });
  return ok ? { changed: true } : { changed: false, skipped: 'race' };
}

/**
 * 產生全域或單機 INDEX.md 的內容（不含時間戳記，R-13）。
 * @param {{ kind: 'global'|'machine', dir: string, userHome: string, label?: string, projectNames?: Map<string,string> }} o
 */
export async function renderScopeIndex({ kind, dir, userHome, label, projectNames = new Map(), budget: lineBudget }) {
  const entries = await readDirEntries(dir);
  // 預算是整份 INDEX.md 的行數；扣掉檔頭 4 行、溢出說明 2 行後才是可列的筆數
  const total = lineBudget ?? INDEX_BUDGET[kind] ?? 60;
  const budget = Math.max(1, entries.length + 4 <= total ? entries.length : total - 6);
  // 排序只用會同步的內容（釘選 → metadata.modified 新到舊 → 檔名），兩台電腦結果一致
  entries.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || b.modified.localeCompare(a.modified) || a.file.localeCompare(b.file));
  const title = kind === 'global' ? '全域記憶' : `單機記憶 · ${label ?? ''}`.trim();
  const head = [
    '<!-- 由 Engram 產生，請勿手改。新增記憶請用 engram remember。 -->',
    `# ${title}（${kind === 'machine' ? entries.filter((e) => !e.project).length : entries.length} 筆）`,
    kind === 'global'
      ? '適用於所有專案。需要時用 Read 讀取對應檔案。'
      : '只在這台電腦成立的事實（路徑、安裝、網路、磁碟）。需要時用 Read 讀取對應檔案。',
    '',
  ];
  const line = (e) => {
    const p = toTildePath(path.join(dir, e.file), userHome);
    const name = oneLine(e.name || e.file.replace(/\.md$/i, ''), 80);
    const desc = oneLine(e.description);
    return `- [${name}](${p})${desc ? ` — ${desc}` : ''}`;
  };
  const body = [];
  // R-18：單機記憶裡標了 engram.project 的，只在開那個專案時由 SessionStart 注入，不佔其他專案的上下文
  const listed = kind === 'machine' ? entries.filter((e) => !e.project) : entries;
  const projectOnly = entries.length - listed.length;
  const shown = listed.slice(0, budget);
  body.push(...shown.map(line));
  if (listed.length > budget) body.push('', `- 另有 ${listed.length - budget} 筆未列出，可用 \`engram search <關鍵字>\` 查詢。`);
  if (projectOnly) body.push('', `- 另有 ${projectOnly} 筆只與特定專案有關，開啟該專案時會自動列出。`);
  void projectNames;
  return `${[...head, ...body].join('\n')}\n`;
}

/** 重建 INDEX.md；內容相同時不寫。 */
export async function rebuildScopeIndex(opts) {
  const p = path.join(opts.dir, SCOPE_INDEX);
  await fsp.mkdir(opts.dir, { recursive: true });
  const next = await renderScopeIndex(opts);
  const cur = await readText(p);
  if (cur !== null && cur.replace(/\r\n/g, '\n') === next) return { changed: false };
  await safeWrite(p, next);
  return { changed: true };
}

/**
 * 兩份索引的行數預算（41 號文件 §02）：可用 = 200 −（CORE.md ＋ CORE.md 匯入的 rules）；
 * 全域與單機 2:1 分配，上限 60／30、下限 20／10。fits=false 代表連下限都放不下（H16）。
 */
export async function computeIndexBudget(vaultDir) {
  const corePath = path.join(vaultDir, 'core', 'CORE.md');
  const core = await indexStats(corePath);
  const text = (await readText(corePath)) ?? '';
  let rules = 0;
  for (const m of text.matchAll(/^@(\.\/)?(rules\/[^\s]+\.md)\s*$/gm)) rules += (await indexStats(path.join(vaultDir, 'core', ...m[2].split('/')))).lines;
  const available = 200 - core.lines - rules;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  return {
    core: core.lines,
    rules,
    available,
    global: clamp(Math.floor((available * 2) / 3), 20, 60),
    machine: clamp(Math.floor(available / 3), 10, 30),
    fits: available >= 30,
  };
}

/** 索引的行數與位元組（預算條，H01）。 */
export async function indexStats(file) {
  const t = await readText(file);
  if (t === null) return { lines: 0, bytes: 0 };
  const lines = t.replace(/\n+$/, '').split(/\r?\n/).length;
  return { lines: t.length ? lines : 0, bytes: Buffer.byteLength(t, 'utf8') };
}
