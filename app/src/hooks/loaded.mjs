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

export async function describeLoadedFile(input) {
  const buf = await fsp.readFile(input.file_path).catch(() => null);
  const entry = {
    path: input.file_path,
    kind: fileKind(input),
    bytes: buf ? buf.length : 0,
    lines: buf ? countLines(buf.toString('utf8')) : 0,
    loadReason: input.load_reason ?? null,
  };
  if (input.parent_file_path) entry.parent = input.parent_file_path;
  return entry;
}

/** 同一個對話的多個 InstructionsLoaded 可能同時執行，所以「讀取 → 加一筆 → 寫回」放在鎖裡。 */
export async function instructionsLoaded(input, deps) {
  if (!input.file_path || !input.session_id) return null;
  const file = path.join(deps.paths.loaded, `${safeName(input.session_id)}.json`);
  const entry = await describeLoadedFile(input);
  // pid 只在第一次建立記錄時解析（需要載入引擎），而且在鎖外進行
  const pid = (await readJson(file)) ? null : await resolvePid(deps, input.cwd);
  await withFileLock(`${file}.lock`, async () => {
    const rec = (await readJson(file)) ?? {
      sessionId: input.session_id,
      at: null,
      cwd: input.cwd ?? null,
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
  return null;
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
