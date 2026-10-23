// 「這不是金鑰」清單。以值的雜湊識別（不存值、不依賴行號或檔案），存在 vault/not-secrets/<雜湊>，隨記憶庫同步：
// 搬移、合併後仍認得，另一台電腦也不會再把它當成金鑰扣住（審查 N1、N2）。檔案內容只放預覽（前 4 字元與長度），
// 兩台電腦標記同一個值時內容完全相同，不會產生合併衝突。
// 舊格式：local/secret-allow.json 的 { [ref]: [{ kind, preview, hash? }] }，只在那台電腦、那個檔案有效，照舊讀取。
// 健康檢查 H13、同步的密鑰關卡、commit 前的最後檢查與引擎的寫入關卡都會套用。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { E, EngramError } from './errors.mjs';
import { readJson, safeWrite } from './fsx.mjs';
import { isAllowedHit, scanSecrets, secretHash } from './secrets.mjs';

export const NOT_SECRETS_DIR = 'not-secrets';
const HASH_RE = /^[0-9a-f]{32}$/;

function legacyFile(localDir) { return path.join(localDir, 'secret-allow.json'); }
/** vault 與 local 是同一個 Engram home 底下的兄弟資料夾（resolveHomes） */
function vaultOf(localDir) { return path.join(path.dirname(localDir), 'vault'); }

/** @returns {Promise<Record<string, object[]>>} 舊格式的每檔項目，另加 '*'：vault 裡所有雜湊（不分檔案） */
export async function loadAllow(localDir) {
  const legacy = (await readJson(legacyFile(localDir), {})) ?? {};
  const names = await fsp.readdir(path.join(vaultOf(localDir), NOT_SECRETS_DIR)).catch(() => []);
  return { ...legacy, '*': names.filter((n) => HASH_RE.test(n)).map((hash) => ({ hash })) };
}

/** 某個檔案適用的項目：不分檔案的雜湊＋舊格式裡這個檔案自己的項目 */
export function allowEntries(allow, ref) {
  return [...(allow?.[ref] ?? []), ...(allow?.['*'] ?? [])];
}

/**
 * 記入「不是金鑰」：寫 vault/not-secrets/<hash>，回傳 vault 內的相對路徑（呼叫端要把它和記憶放在同一個 commit，
 * 另一台電腦才會同時收到兩者）。
 */
export async function addAllow(localDir, _ref, { preview, hash }) {
  if (!HASH_RE.test(String(hash ?? ''))) throw new EngramError(E.INVALID, '「不是金鑰」清單需要值的雜湊');
  const rel = `${NOT_SECRETS_DIR}/${hash}`;
  const abs = path.join(vaultOf(localDir), NOT_SECRETS_DIR, hash);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await safeWrite(abs, `${String(preview ?? '').replace(/[\r\n]/g, '')}\n`);
  return rel;
}

/** 清單裡的項目：{ hash, preview } */
export async function listAllowed(localDir) {
  const dir = path.join(vaultOf(localDir), NOT_SECRETS_DIR);
  const out = [];
  for (const n of (await fsp.readdir(dir).catch(() => [])).filter((x) => HASH_RE.test(x)).sort()) {
    out.push({ hash: n, preview: (await fsp.readFile(path.join(dir, n), 'utf8').catch(() => '')).trim() });
  }
  return out;
}

/** 掃描並排除「不是金鑰」清單的項目。 */
export function scanWithAllow(text, ref, allow = {}) {
  const ok = allowEntries(allow, ref);
  return scanSecrets(text).filter((h) => !isAllowedHit(h, ok, text));
}

const valueOf = (text, h) => String(text).slice(h.offset, h.offset + h.length);
// 訊息只列行號與種類，不帶出值的任何片段（H13 的原則；封存、移動的對象不一定是 Claude 寫的內容）
const describe = (hits) => `第 ${[...new Set(hits.map((h) => h.line))].join('、')} 行，${[...new Set(hits.map((h) => h.kind))].join('、')}`;

/**
 * M5：引擎的寫入 API 不把疑似金鑰帶進記憶庫。含金鑰的檔案不會 commit（只能留在這台），之後再封存、移動或合併就會遺失或只提交一半，
 * 所以在入口就拒絕。before 是原本的內容：裡面已經有的值不算新增（編輯一筆早就含金鑰、還沒處理的記憶仍然可以）。
 * allowSecrets：使用者在管理介面確認這些不是金鑰 → 記入清單後照常寫入。回傳這次新增的清單檔（要一起 commit）。
 */
export async function assertNoNewSecrets(localDir, ref, text, { before = null, allowSecrets = false, what = '內容' } = {}) {
  let hits = scanWithAllow(text, ref, await loadAllow(localDir));
  if (before) {
    const old = new Set(scanSecrets(before).map((h) => secretHash(valueOf(before, h))));
    hits = hits.filter((h) => !old.has(secretHash(valueOf(text, h))));
  }
  if (!hits.length) return [];
  if (!allowSecrets) {
    throw new EngramError(E.SECRET, `${what}疑似含有金鑰（${describe(hits)}），Engram 不會寫入`,
      '記憶裡只記金鑰存放在哪裡、怎麼取得（例如 Windows 認證管理員的項目名稱）。確定不是金鑰時：管理介面會詢問是否照樣儲存；或由你在自己的終端機（不是 Claude Code）執行 engram not-secret --value <那個值>，再寫一次。',
      { kinds: [...new Set(hits.map((h) => h.kind))], lines: [...new Set(hits.map((h) => h.line))] });
  }
  const added = [];
  for (const h of hits) added.push(await addAllow(localDir, ref, { preview: h.preview, hash: secretHash(valueOf(text, h)) }));
  return [...new Set(added)];
}

/**
 * 會刪除或搬走檔案的動作遇到含疑似金鑰的檔案（N7：只擋真的會出事的情況）：
 * - 封存、合併掉（removable）：目前內容和 HEAD 一樣（歷史找得回來）就允許；不一樣或沒進過歷史就拒絕，刪掉會永久遺失。
 * - 移動：一律拒絕，新位置的檔案不會同步，另一台電腦會失去這筆記憶。
 */
export async function assertNotHeld(localDir, ref, raw, what, { headRaw = null, removable = true } = {}) {
  if (raw == null) return;
  const hits = scanWithAllow(raw, ref, await loadAllow(localDir));
  if (!hits.length) return;
  if (removable && headRaw !== null && headRaw.replace(/\r\n/g, '\n') === raw.replace(/\r\n/g, '\n')) return;
  const why = removable
    ? '最新的內容還沒進同步歷史，' + what + '後就找不回來'
    : '搬到新位置後不會同步，另一台電腦會失去這筆記憶';
  throw new EngramError(E.SECRET, `${ref} 疑似含有金鑰（${describe(hits)}），不能${what}：${why}`,
    `請先在收件匣遮蔽金鑰（或在管理介面確認「這不是金鑰」），再${what}。`);
}
