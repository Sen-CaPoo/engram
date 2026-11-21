// 開場 hook 的快速路徑（2.0.0 S5）：常駐程式預先把「已綁定的資料夾」的開場資料寫進 local/cache/session/state.json
// （core/session.mjs 的 writeSessionCache），SessionStart hook 先試這裡，不載入整個引擎。
// 這個模組要保持輕量：只用 node:fs、路徑工具、文字組法（sessiontext.mjs）與護欄的後備提示（guardrails.mjs，和完整路徑呼叫同一個函式）。
//
// 什麼時候不用快取、退回完整路徑（回傳 null）：
// - 快取不存在、格式不對、超過 15 分鐘；
// - 這個資料夾不在快取裡（沒有綁定、撞名、搬家、要當場綁定，這些都可能要寫入）；
// - 寫快取時讀過的任何檔案（狀態、收件匣、衝突、綁定、專案名稱、單機記憶、junction、MEMORY.md、產生文字的程式碼）修改時間或大小變了；
// - 安裝的版本與 commit（local/install.json）或程式的版本和寫快取時不同（更新 Engram 之後第一次開場）。
// 和時間有關的文字（最後同步幾分鐘前、同步失敗多久）在這裡用現在的時間重新算，所以和完整路徑一字不差。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardrailFallback } from './guardrails.mjs';
import { encodeProjectPath, memoryRootFor, samePath } from './paths.mjs';
import { renderSession } from './sessiontext.mjs';

export const SESSION_CACHE_V = 1;
export const SESSION_CACHE_MAX_AGE_MS = 15 * 60_000;
export const sessionCacheFile = (local) => path.join(local, 'cache', 'session', 'state.json');

/**
 * 產生開場文字的程式碼：開發模式（原地改檔）改過之後，舊程式寫的快取就不用。
 * 部署版的新版裝在新的資料夾、舊資料夾的檔案不會變，所以另外比對安裝的版本與 commit（installInfo）與程式的版本（codeVersion）。
 */
export const CODE_FILES = ['session.mjs', 'sessiontext.mjs', 'sessioncache.mjs', 'identity.mjs', 'normalize.mjs', 'paths.mjs']
  .map((f) => fileURLToPath(new URL(f, import.meta.url)));

/** 這台安裝的版本與 commit（local/install.json；更新 Engram 時會改寫）；沒有安裝清單（開發、測試）是 null */
export function installInfo(local) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(local, 'install.json'), 'utf8'));
    return { version: typeof j?.version === 'string' ? j.version : null, commit: typeof j?.commit === 'string' ? j.commit : null, appDir: typeof j?.appDir === 'string' ? j.appDir : null };
  } catch {
    return null;
  }
}

/** 這份程式的版本（app/package.json）：寫快取的常駐程式與讀快取的 hook 不是同一版時不用快取 */
export function codeVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).version ?? '');
  } catch {
    return '';
  }
}

/** 檔案或資料夾的簽章：連結（junction）是指向哪裡，資料夾是修改時間，檔案是修改時間與大小；不存在是 '-' */
export function signature(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return `l:${fs.readlinkSync(p)}`;
    if (st.isDirectory()) return `d:${Math.round(st.mtimeMs)}`;
    return `f:${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return '-';
  }
}

/** { 路徑: 簽章 } */
export function signatures(files) {
  const out = {};
  for (const f of files) out[f] = signature(f);
  return out;
}

const unchanged = (sources) => !!sources && typeof sources === 'object' && Object.entries(sources).every(([p, sig]) => signature(p) === sig);

/**
 * 快速路徑。回傳和 sessionContext 一樣的 { text, binding, memoryIndex }；不能用快取時回傳 null（呼叫端改走完整路徑）。
 * homes 是這個程序開引擎時會用的路徑（core/paths.mjs 的 resolveHomes）：和寫快取的常駐程式不一樣時（例如家目錄不同，路徑的 ~ 寫法會不同）不用快取。
 * @param {{ homes: { home: string, vault: string, local: string, claudeHome: string, userHome: string }, cwd?: string, sessionId?: string, now?: number }} o
 */
export async function fastSessionContext({ homes, cwd, sessionId, now = Date.now() }) {
  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(sessionCacheFile(homes.local), 'utf8'));
  } catch {
    return null;
  }
  if (cache?.v !== SESSION_CACHE_V || !Array.isArray(cache.roots) || !cache.shared) return null;
  if (!['home', 'claudeHome', 'userHome'].every((k) => samePath(cache.homes?.[k], homes[k]))) return null;
  // 更新 Engram 之後：安裝的版本或 commit、或程式本身的版本和寫快取的那一版不同，就走完整路徑
  if (JSON.stringify(installInfo(homes.local)) !== JSON.stringify(cache.install ?? null) || codeVersion() !== cache.engine) return null;
  const age = now - Date.parse(cache.at ?? '');
  if (!(age >= 0 && age <= SESSION_CACHE_MAX_AGE_MS)) return null;
  const dir = cwd ?? process.cwd();
  const { root } = memoryRootFor(dir);
  const fromSub = !samePath(path.resolve(dir), root);
  const entry = cache.roots.find((r) => samePath(r.root, root));
  if (!entry || encodeProjectPath(root) !== entry.encoded) return null;
  const v = fromSub ? entry.sub : entry.top;
  if (!v || !unchanged(cache.sources) || !unchanged(entry.sources)) return null;
  const guard = await guardrailFallback({ vault: homes.vault, local: homes.local }, { sessionId }).catch(() => null);
  const { text } = renderSession({
    label: cache.label, mid: cache.mid, projectPart: v.projectPart, bindState: v.bindState, bindingWarnings: v.warnings ?? [],
    shared: cache.shared, machineWarning: entry.machineWarning ?? null, guard, now,
  });
  return { text, binding: { ...entry.binding, state: v.bindState }, memoryIndex: v.memoryIndex ?? null };
}
