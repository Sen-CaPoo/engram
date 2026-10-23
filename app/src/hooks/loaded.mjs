// InstructionsLoaded：記錄這次對話實際載入了哪些 CLAUDE.md、rules、import 與 MEMORY.md。
// 寫入 local/loaded/<sessionId>.json，格式見 40 號 §15 LoadedFiles；管理介面用它顯示「這次對話載入了什麼」。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { countLines, readJson, safeName, withFileLock, writeJsonAtomic } from '../cli/fsutil.mjs';

const MEMORY_TYPE_KIND = { User: 'user', Project: 'project', Local: 'local' };

/** MEMORY.md → memory-index；有 parent → import；rules 底下 → rule；其他依 memory_type。 */
export function fileKind({ file_path: file, memory_type: type, parent_file_path: parent }) {
  const p = String(file ?? '').replace(/\\/g, '/');
  if (p.split('/').pop() === 'MEMORY.md') return 'memory-index';
  if (parent) return 'import';
  if (p.includes('/rules/')) return 'rule';
  return MEMORY_TYPE_KIND[type] ?? 'user'; // Managed（組織政策）等其他層級歸在 user
}

// Claude Code 只載入 MEMORY.md 的前 200 行或 25KB（與健康檢查 H01 同一個上限），記錄的是載入的部分
const INDEX_LIMIT = { lines: 200, bytes: 25 * 1024 };

function loadedPart(text) {
  let out = '';
  let n = 0;
  for (const line of text.split('\n')) {
    if (n >= INDEX_LIMIT.lines || Buffer.byteLength(`${out}${line}\n`) > INDEX_LIMIT.bytes) break;
    out += `${line}\n`;
    n++;
  }
  return out;
}

export async function describeLoadedFile(input) {
  const buf = await fsp.readFile(input.file_path).catch(() => null);
  const kind = fileKind(input);
  let text = buf ? buf.toString('utf8') : '';
  let bytes = buf ? buf.length : 0;
  if (kind === 'memory-index' && (bytes > INDEX_LIMIT.bytes || countLines(text) > INDEX_LIMIT.lines)) {
    text = loadedPart(text);
    bytes = Buffer.byteLength(text);
  }
  const entry = {
    path: input.file_path,
    kind,
    bytes,
    lines: buf ? countLines(text) : 0,
    loadReason: input.load_reason ?? null,
  };
  if (input.parent_file_path) entry.parent = input.parent_file_path;
  return entry;
}

const loadedFile = (deps, sessionId) => path.join(deps.paths.loaded, `${safeName(sessionId)}.json`);

/**
 * 把一筆載入的檔案加進 local/loaded/<sessionId>.json（同一路徑覆蓋）。
 * 同一個對話的多個 InstructionsLoaded 與 SessionStart 可能同時執行，所以「讀取 → 加一筆 → 寫回」放在鎖裡。
 */
async function addLoadedFile({ sessionId, cwd, pid }, entry, deps) {
  const file = loadedFile(deps, sessionId);
  await withFileLock(`${file}.lock`, async () => {
    const rec = (await readJson(file)) ?? {
      sessionId,
      at: null,
      cwd: cwd ?? null,
      pid: null,
      files: [],
    };
    if (rec.pid == null && pid) rec.pid = pid;
    rec.at = new Date(deps.now()).toISOString();
    const i = rec.files.findIndex((f) => f.path === entry.path);
    if (i >= 0) rec.files[i] = entry;
    else rec.files.push(entry);
    await writeJsonAtomic(file, rec);
  });
}

export async function instructionsLoaded(input, deps) {
  if (!input.file_path || !input.session_id) return null;
  const entry = await describeLoadedFile(input);
  // 記錄還沒有 pid 時才解析（需要載入引擎），而且在鎖外進行；SessionStart 可能先建立了沒有 pid 的記錄（當時未綁定）
  const pid = (await readJson(loadedFile(deps, input.session_id)))?.pid ? null : await resolvePid(deps, input.cwd);
  await addLoadedFile({ sessionId: input.session_id, cwd: input.cwd, pid }, entry, deps);
  return null;
}

/**
 * 補記專案的 MEMORY.md：Claude Code 載入自動記憶的索引時不觸發 InstructionsLoaded，
 * 所以由 SessionStart 依引擎算出的路徑（sessionContext 的 memoryIndex）寫進同一份記錄。
 */
export async function recordMemoryIndex(input, memoryIndex, pid, deps) {
  if (!memoryIndex || !input.session_id) return;
  const entry = await describeLoadedFile({
    file_path: memoryIndex,
    memory_type: 'Project',
    load_reason: input.source === 'compact' ? 'compact' : 'session_start',
  });
  await addLoadedFile({ sessionId: input.session_id, cwd: input.cwd, pid }, entry, deps);
}

async function resolvePid(deps, cwd) {
  if (!cwd) return null;
  try {
    const eg = await deps.loadEngine();
    return (await eg.identity.resolve(cwd))?.pid ?? null;
  } catch (err) {
    deps.log.debug('instructions-loaded', err);
    return null;
  }
}
