// 索引正規化：專案 MEMORY.md（Claude 與引擎共同維護）與全域／單機 INDEX.md（引擎完全產生）。
// 規則見 40 號文件 §12。兩者都必須冪等：連續執行兩次結果一字不差。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { engramMeta, getField, parseMemoryFile } from './frontmatter.mjs';
import { exists, listMarkdown, mtimeMs, readJson, readText, readTextSync, safeWrite, sha1, writeJson } from './fsx.mjs';
import { git } from './git.mjs';
import { INDEX_COMPAT_WITHIN_MS, olderMachines } from './indexcompat.mjs';
import * as legacy from './normalize-legacy.mjs';
import { toTildePath } from './paths.mjs';
import { loadAllow, scanWithAllow } from './secretallow.mjs';
import { redactSecrets, scanSecrets } from './secrets.mjs';
import { readSharedSettings } from './sharedsettings.mjs';
import { readLocalMachine } from './vault.mjs';

export const PROJECT_INDEX = 'MEMORY.md';
export const SCOPE_INDEX = 'INDEX.md';
export const INDEX_BUDGET = { global: 60, machine: 30 };
// Claude Code 只載入 MEMORY.md 的前 200 行或 25KB；到上限的 80% 就進入「精簡索引」模式（P7）
export const INDEX_COMPACT_AT = { lines: 160, bytes: 20 * 1024 };
// 索引行：清單項目、而且連結就在項目開頭（允許粗體包住連結）。其他含連結的行（Claude 或使用者手寫的說明句）一律是手寫行：
// 不精簡、不省略、不去重，也不算「那筆記憶已經列在索引」
const INDEX_LINE_RE = /^\s*[-*+]\s+(?:\*\*|__)?\[([^\]]*)\]\(([^)\s]+)\)/;
const OMIT_LINE_RE = /^- 另有 \d+ 筆未列出，可用 `engram search <關鍵字>` 查詢。\s*$/;
const omitLine = (n) => `- 另有 ${n} 筆未列出，可用 \`engram search <關鍵字>\` 查詢。`;
// 2.0.0 P2：索引分層（indexLayers 是 on）時，全域與單機的 INDEX.md 只列規則層，參考類記憶靠情境召回帶出
const LAYER_LINE_RE = /^- 另有 \d+ 筆參考類記憶不在索引，相關時會自動帶出，也可以用 `engram search <關鍵字>` 查詢。\s*$/;
const layerLine = (n) => `- 另有 ${n} 筆參考類記憶不在索引，相關時會自動帶出，也可以用 \`engram search <關鍵字>\` 查詢。`;
/** 索引裡有沒有「另有 N 筆未列出」或「另有 N 筆參考類記憶不在索引」那行（有的話，沒列在索引的記憶是被省略的，不是漏掉的） */
export const hasOmitLine = (indexText) => String(indexText ?? '').split(/\r?\n/).some((l) => OMIT_LINE_RE.test(l) || LAYER_LINE_RE.test(l));

/**
 * 實際的索引分層（P2）：shared 是所有電腦共用的設定（vault/settings.json，core/sharedsettings.mjs）。
 * indexLayers 是 on 才分層（'on'）；observe（預設，照舊產生索引、只算出切換後的數字）與 off 都是 'off'。
 * 只看共用的值：兩台電腦算出來的索引一定一樣。分層時每一台的情境召回都強制開啟（core/recall.mjs 的 recallSettings）。
 */
export function readIndexLayers(shared) {
  return shared?.indexLayers === 'on' ? 'on' : 'off';
}

/** 記憶庫共用的索引分層設定（讀 vault/settings.json） */
export async function indexLayersFor(vaultDir) {
  return readIndexLayers(await readSharedSettings(vaultDir));
}
const DAY = 86_400_000;
const byteLen = (s) => Buffer.byteLength(s, 'utf8');

/**
 * 索引一行裡的說明（P7 精簡）：在第一個句號、分號、全形冒號或 max 個字元處截斷；真的截掉東西時結尾加「…」。
 * 句號只認「。」與後面接空白或結尾的「.」（版本號 22.1 不算）。
 */
export function shortDescription(desc, max = 90) {
  const chars = Array.from(String(desc ?? '').replace(/\s+/g, ' ').trim());
  let end = chars.length;
  let cut = false;
  for (let i = 1; i < chars.length; i++) {
    const c = chars[i];
    if (c === '。' || c === '；' || c === ';' || c === '：' || (c === '.' && (i === chars.length - 1 || /\s/.test(chars[i + 1])))) {
      end = i;
      cut = i < chars.length - 1;
      break;
    }
  }
  if (end > max) { end = max; cut = true; }
  return `${chars.slice(0, end).join('')}${cut ? '…' : ''}`;
}

/** 放不下時的保留順序（P1、P7 共用）：釘選 → feedback／user → 近 14 天 → 近 90 天讀取次數 → 修改時間 → 檔名。只用會同步的內容。 */
const isDurable = (e) => e.type === 'feedback' || e.type === 'user';
/** 規則層（P2）：feedback、user 與釘選的記憶；其餘是參考類 */
const isRuleLayer = (e) => !!e.pinned || isDurable(e);
// 近 14 天新增或修改的先保留：新記憶還沒人讀過，不能因為 0 次就被擠出索引（不在索引裡就更不會被讀到）
const recentOf = (now) => {
  const cut = new Date(now - 14 * DAY).toISOString().slice(0, 10);
  return (e) => Number(String(e.modified ?? '').slice(0, 10) >= cut);
};
function keepOrder({ now, reads }) {
  const recent = recentOf(now);
  const readsOf = (e) => (typeof reads === 'function' ? Number(reads(e.file)) || 0 : 0);
  return (a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || (Number(isDurable(b)) - Number(isDurable(a))) || (recent(b) - recent(a))
    || (readsOf(b) - readsOf(a)) || String(b.modified ?? '').localeCompare(String(a.modified ?? '')) || a.file.localeCompare(b.file);
}

/** 同資料夾的連結目標（./x.md 或 x.md）；其他（子資料夾、網址）回傳 null。 */
function localTarget(target) {
  let t;
  try { t = decodeURI(target.replace(/^\.\//, '')); } catch { return null; }
  if (!/\.md$/i.test(t) || t.includes('/') || t.includes('\\') || /^[a-z]+:/i.test(t)) return null;
  return t;
}

/**
 * 索引文字裡「真的有一行」的記憶檔名（小寫）：只看索引行（清單項目、連結在開頭），手寫說明句裡提到不算。
 * 連結可以是同資料夾的檔名（MEMORY.md），也可以是帶路徑的（全域與單機 INDEX.md 用 ~/.engram/… 的路徑）。
 */
export function listedFiles(indexText) {
  const out = new Set();
  for (const raw of String(indexText ?? '').split(/\r?\n/)) {
    const m = INDEX_LINE_RE.exec(raw);
    if (!m) continue;
    let t;
    try { t = decodeURI(m[2].replace(/^\.\//, '')); } catch { continue; }
    if (/\.md$/i.test(t)) out.add(t.slice(Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\')) + 1).toLowerCase());
  }
  return out;
}

/** 永遠列出、不參與截斷的記憶：釘選的，以及 feedback／user（使用者的偏好與糾正） */
export const alwaysListed = (e) => !!e.pinned || isDurable(e);

/** 全域／單機索引可列的筆數：預算（整份 INDEX.md 的行數）扣掉檔頭 4 行、溢出說明 2 行；放得下時全部列出。 */
export const scopeSlots = (entryCount, totalLines) => Math.max(1, entryCount + 4 <= totalLines ? entryCount : totalLines - 6);

/** 索引的一行：先遮蔽疑似金鑰再截斷（索引每個對話都會載入；含金鑰的索引也會被扣住、讓同步卡住） */
function oneLine(s, max = 160) {
  const t = redactSecrets(String(s ?? '')).text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 索引這幾行的大小是否到了精簡門檻（上限的 80%：位元組 20,480 或 160 行） */
function overCompact(lines) {
  let bytes = 0;
  for (const l of lines) bytes += byteLen(l.raw) + 1;
  return bytes >= INDEX_COMPACT_AT.bytes || lines.length >= INDEX_COMPACT_AT.lines;
}

/** 精簡一行（P7）：指向既有記憶檔的行，把連結後面的說明換成 frontmatter description 的第一句；只在比原本短時才換（冪等） */
function compactLine(l, byFile) {
  const f = l.target ? byFile.get(l.target) : null;
  const m = f ? INDEX_LINE_RE.exec(l.raw) : null;
  if (!m) return l;
  const short = shortDescription(redactSecrets(String(f.description ?? '')).text);
  if (!short) return l;
  const end = m[0].length;
  const closers = /^[*_`]+/.exec(l.raw.slice(end))?.[0] ?? '';
  const raw = `${l.raw.slice(0, end + closers.length)} — ${short}`;
  return byteLen(raw) < byteLen(l.raw) ? { ...l, raw } : l;
}

/**
 * 精簡後仍超過 80%：依 keepOrder 保留放得下的連結行（放進來後要低於 80%，並預留「另有 N 筆」那行），其餘不列。
 * 手寫的非連結行一律保留。結果只取決於檔案清單與排序依據，不看目前索引裡有沒有那一行（所以冪等，也不會把被省略的加回來）。
 */
function omitToFit(lines, byFile, { now, reads }) {
  const links = lines.filter((l) => l.target);
  let bytes = byteLen(omitLine(links.length)) + 1;
  let count = 1;
  for (const l of lines) if (!l.target) { bytes += byteLen(l.raw) + 1; count++; }
  const order = keepOrder({ now, reads });
  const kept = new Set();
  for (const l of [...links].sort((a, b) => order(byFile.get(a.target), byFile.get(b.target)))) {
    const b = byteLen(l.raw) + 1;
    if (bytes + b >= INDEX_COMPACT_AT.bytes || count + 1 >= INDEX_COMPACT_AT.lines) break;
    bytes += b;
    count++;
    kept.add(l);
  }
  return { lines: lines.filter((l) => !l.target || kept.has(l)), omitted: links.length - kept.size };
}

/**
 * 正規化 MEMORY.md 文字。
 * @param {string} text  目前內容（可為空字串）
 * @param {{ file: string, name: string, description: string, pinned: boolean, type?: string, modified?: string }[]} files  資料夾內實際的記憶檔
 * @param {{ appendOnly?: boolean, now?: number, reads?: (file: string) => number }} [opts]
 *   appendOnly：進行中對話時只附加，不刪不排、不精簡（R-08）；now、reads：索引放不下時挑選用（近 14 天、近 90 天讀取次數）
 */
export function normalizeMemoryIndexText(text, files, opts) {
  return planMemoryIndex(text, files, opts).text;
}

/** 同 normalizeMemoryIndexText；另外回報這次是否進入「依排名省略」（ranked：呼叫端要補上 git 時間與讀取統計再算一次） */
export function planMemoryIndex(text, files, opts = {}) {
  let plan = planOnce(text, files, opts);
  // 被省略的檔案下一次會以「重新產生的格式」（通常比 Claude 手寫的行短）參與比較，所以重複到穩定為止：
  // 這樣連續執行兩次的結果一字不差（冪等）。每一輪只會多留下幾行，很快就穩定
  for (let i = 0; plan.ranked && i < 4; i++) {
    const next = planOnce(plan.text, files, opts);
    if (next.text === plan.text) break;
    plan = next;
  }
  return plan;
}

function planOnce(text, files, { appendOnly = false, now = Date.now(), reads } = {}) {
  const src = String(text ?? '').replace(/\r\n/g, '\n');
  const lines = src.length ? src.replace(/\n+$/, '').split('\n') : [];
  const byFile = new Map(files.map((f) => [f.file.toLowerCase(), f]));
  const seen = new Map(); // target(lower) → 保留下來的行在 out 中的位置

  /** @type {{ raw: string, target: string|null }[]} */
  const out = [];
  for (const raw of lines) {
    if (!appendOnly && OMIT_LINE_RE.test(raw)) continue; // 上一次省略時加的說明：每次依目前狀況重新產生
    const m = INDEX_LINE_RE.exec(raw);
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

  // 補上沒列在索引的檔案（H03）。索引已經在省略（有「另有 N 筆」那行）時，進行中的對話不能把被省略的加回來：
  // 只補一定會留下的（釘選、feedback／user、近 14 天），例如剛用 engram remember 寫的
  const omitting = appendOnly && lines.some((l) => OMIT_LINE_RE.test(l));
  const recent = recentOf(now);
  for (const f of files) {
    const key = f.file.toLowerCase();
    if (seen.has(key)) continue;
    if (omitting && !(f.pinned || isDurable(f) || recent(f))) continue;
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
  // P7：到上限的 80% 先把每行的說明縮成一句；仍然超過就依排名省略。進行中的對話（appendOnly）不做
  let omitted = 0;
  let ranked = false;
  if (!appendOnly && overCompact(result)) {
    result = result.map((l) => compactLine(l, byFile));
    if (overCompact(result)) {
      ranked = true;
      ({ lines: result, omitted } = omitToFit(result, byFile, { now, reads }));
    }
  }
  const rows = result.map((l) => l.raw);
  if (omitted) rows.push(omitLine(omitted));
  const body = rows.join('\n');
  return { text: body.length ? `${body}\n` : '', ranked };
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

/** HEAD 指到的 commit（直接讀 .git，不啟動 git）；讀不到時 null */
function headSha(root) {
  try {
    const head = (readTextSync(path.join(root, '.git', 'HEAD')) ?? '').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
    if (!ref) return null;
    const loose = (readTextSync(path.join(root, '.git', ...ref.split('/'))) ?? '').trim();
    if (/^[0-9a-f]{40}$/.test(loose)) return loose;
    const packed = new RegExp(`^([0-9a-f]{40}) ${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').exec(readTextSync(path.join(root, '.git', 'packed-refs')) ?? '');
    return packed?.[1] ?? null;
  } catch { return null; }
}

/**
 * 記憶庫裡每個 .md 檔「第一次被加入」的作者時間（ISO，UTC）：檔案的 ref → 時間。
 * 缺 metadata.modified 時的排序後備（git 歷史會同步，兩台電腦在同一個 HEAD 算出來一樣）。
 * 一次問 git 整個記憶庫；結果以 HEAD 為鍵存在 local/cache/first-added.json（HEAD 沒變就不再呼叫 git）。取不到時空 Map。
 */
async function firstAddedDates(root) {
  const cachePath = path.join(path.dirname(root), 'local', 'cache', 'first-added.json');
  const head = headSha(root);
  if (head) {
    const c = await readJson(cachePath, null);
    if (c?.v === 1 && c.head === head && c.dates && typeof c.dates === 'object') return new Map(Object.entries(c.dates));
  }
  // --no-renames：改過名的檔案以目前檔名第一次出現的時間為準
  const r = await git(['log', '--no-renames', '--diff-filter=A', '--name-only', '--format=%x01%at', '--', '*.md'], { cwd: root, allowFail: true, timeoutMs: 20_000 });
  const dates = new Map();
  if (r.code !== 0) return dates;
  let at = Number.NaN;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('\x01')) { at = Number(line.slice(1)); continue; }
    const file = line.replace(/\r$/, '');
    if (!file || !Number.isFinite(at)) continue;
    const iso = new Date(at * 1000).toISOString();
    if (!dates.has(file) || iso < dates.get(file)) dates.set(file, iso);
  }
  if (head) {
    try { await writeJson(cachePath, { v: 1, head, dates: Object.fromEntries([...dates].sort(([a], [b]) => (a < b ? -1 : 1))) }); } catch { /* 快取只是加速：寫不進去就下次再算 */ }
  }
  return dates;
}

/** 記憶庫（vault）的根目錄；dir 不在記憶庫的 git 工作樹裡時 null */
function vaultRoot(dir) {
  const root = gitRoot(dir);
  return root && path.basename(root) === 'vault' ? root : null;
}

/**
 * 相容模式的舊版電腦（2.0.0）：記憶庫裡版本低於 2.0.0、而且近 7 天內有活動的電腦（core/indexcompat.mjs，只看同步來的 machine.json）。
 * 非空時，共用的索引（全域 INDEX.md、各專案 MEMORY.md）改由 normalize-legacy.mjs（1.6.0 的原樣）產生，和那幾台輸出一樣。
 * dir 不在記憶庫裡（vaultRoot 找不到）時空陣列；這台自己不算（local/machine.json 的 mid）。每次重新判斷，不快取。
 */
async function compatMachines(dir, now) {
  const root = vaultRoot(dir);
  if (!root) return [];
  const selfMid = readLocalMachine(path.join(path.dirname(root), 'local'))?.mid ?? null;
  return olderMachines(root, { now, withinMs: INDEX_COMPAT_WITHIN_MS, selfMid });
}

/** metadata.modified 缺漏的項目，用 git 第一次加入的時間補上（取不到就維持空字串）。 */
async function fillGitDates(entries, dir) {
  const blank = entries.filter((e) => !e.modified);
  const root = blank.length ? vaultRoot(dir) : null;
  if (!root) return;
  let dates;
  try { dates = await firstAddedDates(root); } catch { return; }
  for (const e of blank) e.modified = dates.get(path.relative(root, path.join(dir, e.file)).split(path.sep).join('/')) ?? '';
}

/**
 * 讀資料夾內記憶檔的摘要（給索引用）。skipRecentMs 內被改過的檔案仍列入（只是不會被引擎改寫）。被扣住的檔案依 syncedTexts 處理。
 * gitDates：metadata.modified 缺漏的項目用 git 首次加入的時間補上 modified（排序用）。
 */
export async function readDirEntries(dir, { exclude = [PROJECT_INDEX, SCOPE_INDEX], gitDates = false } = {}) {
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
  if (gitDates) await fillGitDates(entries, dir);
  return entries;
}

/**
 * 正規化某專案的 MEMORY.md。
 * reads：檔名 → 近 90 天讀取次數（索引放不下、依排名省略時用）；省略時從記憶庫的同步摘要取。
 * @returns {Promise<{ changed: boolean, skipped?: string }>}
 */
export async function normalizeProjectIndex(memDir, { appendOnly = false, skipRecentMs = 10_000, now = Date.now(), reads } = {}) {
  const indexPath = path.join(memDir, PROJECT_INDEX);
  if (skipRecentMs && now - mtimeMs(indexPath) < skipRecentMs) return { changed: false, skipped: 'recent' };
  // 相容模式：還有舊版電腦在用時，專案索引照 1.6.0 的方式整理（不自動縮短與省略），兩台才不會互相改寫
  if ((await compatMachines(memDir, now)).length) {
    try {
      return await legacy.normalizeProjectIndex(memDir, { appendOnly, skipRecentMs, now });
    } catch (err) {
      // 1.6.0 的 localTarget 對連結做 decodeURI 沒有接例外：索引裡有讀不懂的 % 連結會丟 URIError（1.6.0 那台的整理也會失敗）。
      // 這一版不讓同步因此中斷；這個專案的索引這一輪不動（不改用新規則：那會和舊版電腦互相改寫）
      if (!(err instanceof URIError)) throw err;
      return { changed: false, skipped: 'legacy-uri' };
    }
  }
  const files = await readDirEntries(memDir);
  const current = await readText(indexPath);
  if (current === null && files.length === 0) return { changed: false };
  let plan = planMemoryIndex(current ?? '', files, { appendOnly, now, reads });
  if (plan.ranked) {
    // 要依排名省略了：才補上 git 首次加入的時間（缺 modified 的）與讀取統計，再算一次
    await fillGitDates(files, memDir);
    let r = reads;
    if (!r) {
      const root = vaultRoot(memDir);
      if (root) r = await (await import('./usage.mjs')).readsForScope(root, path.relative(root, memDir).split(path.sep).join('/'));
    }
    plan = planMemoryIndex(current ?? '', files, { appendOnly, now, reads: r });
  }
  const next = plan.text;
  if (current !== null && next === current.replace(/\r\n/g, '\n')) return { changed: false };
  if (current === next) return { changed: false };
  const ok = await safeWrite(indexPath, next, { expectHash: current === null ? null : sha1(current) });
  return ok ? { changed: true } : { changed: false, skipped: 'race' };
}

/**
 * 產生全域或單機 INDEX.md 的內容（不含時間戳記，R-13）。
 * layers：'on' 時只列規則層（feedback、user、釘選），結尾一行說明參考類記憶的筆數（P2）；'off'（預設）照舊。
 * 相容模式（記憶庫裡有版本低於 2.0.0、近 7 天內有活動的電腦，見 compatMachines）：全域索引（所有電腦都會寫）用 1.6.0 的原樣產生，
 * 單機索引（只有那台自己寫）照現行規則、但不分層（layers 一律當成 'off'）。now：判斷「近 7 天」的基準，預設現在。
 * @param {{ kind: 'global'|'machine', dir: string, userHome: string, label?: string, projectNames?: Map<string,string>, layers?: 'on'|'off', now?: number }} o
 */
export async function renderScopeIndex(o) {
  if ((await compatMachines(o.dir, o.now ?? Date.now())).length) {
    return o.kind === 'global' ? legacy.renderScopeIndex(o) : (await planScopeIndex({ ...o, layers: 'off' })).text;
  }
  return (await planScopeIndex(o)).text;
}

/** 同 renderScopeIndex；另外回報參考類（不是規則層）的記憶有幾筆（並行觀察的統計用，不論 layers 是什麼都算） */
export async function planScopeIndex({ kind, dir, userHome, label, projectNames = new Map(), budget: lineBudget, reads, layers = 'off' }) {
  // 缺 metadata.modified 的記憶（舊版 engram remember 寫的）用 git 首次加入的時間補上，不然排序會退化成檔名字母序
  const entries = await readDirEntries(dir, { gitDates: true });
  // 預算是整份 INDEX.md 的行數；扣掉檔頭 4 行、溢出說明 2 行後才是可列的筆數
  const total = lineBudget ?? INDEX_BUDGET[kind] ?? 60;
  const budget = scopeSlots(entries.length, total);
  // 1.4.0：放不下時，依「釘選 → 近 90 天讀取次數（所有電腦合計，同步的摘要）→ 修改時間」挑出要列的；
  // 列出來的仍依「釘選 → 修改時間」排序。讀取統計只在放不下時才有影響，平常不會因為統計更新而改寫索引。
  // 2.0.0：釘選的、feedback 與 user 永遠列出、不參與截斷（先擠掉其他類型；用完預算時由健康檢查 H35 提醒）。
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
  const all = kind === 'machine' ? entries.filter((e) => !e.project) : entries;
  const projectOnly = entries.length - all.length;
  const reference = all.filter((e) => !isRuleLayer(e)).length;
  // P2：分層時只有規則層參與挑選；參考類一律不列（由情境召回帶出）
  const listed = layers === 'on' ? all.filter(isRuleLayer) : all;
  let shown = listed;
  if (listed.length > budget) {
    // 保留順序：釘選 → feedback／user → 其他。前兩類永遠列出（可以超過行數預算），名額用完才輪到其他類型
    const always = listed.filter(alwaysListed);
    const others = listed.filter((e) => !alwaysListed(e)).sort(keepOrder({ now: Date.now(), reads })).slice(0, Math.max(0, budget - always.length));
    const chosen = new Set([...always, ...others]);
    shown = listed.filter((e) => chosen.has(e));
  }
  body.push(...shown.map(line));
  if (listed.length > shown.length) body.push('', `- 另有 ${listed.length - shown.length} 筆未列出，可用 \`engram search <關鍵字>\` 查詢。`);
  if (layers === 'on' && reference) body.push('', layerLine(reference));
  if (projectOnly) body.push('', `- 另有 ${projectOnly} 筆只與特定專案有關，開啟該專案時會自動列出。`);
  void projectNames;
  return { text: `${[...head, ...body].join('\n')}\n`, reference };
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
