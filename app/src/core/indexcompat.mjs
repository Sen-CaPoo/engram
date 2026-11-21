// 索引相容模式的判斷（2.0.0）：記憶庫裡有沒有「Engram 版本低於 2.0.0、而且近 7 天內有活動」的電腦。
// 有的話，兩台電腦都會寫的共用索引（global/INDEX.md 與各專案的 MEMORY.md）要和 1.6.0 產生的內容逐位元相同
// （core/normalize.mjs 在產生索引內容的函式裡切換到 core/normalize-legacy.mjs），不然兩台每一輪同步都互相改寫。
// 只看記憶庫裡同步來的 machines/<mid>/machine.json，所以常駐程式、CLI、hook 呼叫都會得到同樣的結果；每次都重新判斷、不快取，
// 舊版電腦升級（machine.json 的版本變成 2.0.0 以上）之後，下一次整理就切換。
import path from 'node:path';
import { readJson } from './fsx.mjs';
import { versionAtLeast } from './usage.mjs';
import { ENGINE_VERSION, listMachineIds, machineDir } from './vault.mjs';

const DAY = 86_400_000;

/** 共用的索引分層與相容模式從這一版開始；開發中的版本號比它舊時以目前的版本為準（同一份程式的電腦彼此看得懂） */
export const SHARED_LAYERS_SINCE = '2.0.0';
export const layersMinVersion = () => (versionAtLeast(ENGINE_VERSION, SHARED_LAYERS_SINCE) ? SHARED_LAYERS_SINCE : ENGINE_VERSION);

/** 相容模式看的活動期間：舊版電腦最近 7 天內有活動才算 */
export const INDEX_COMPAT_WITHIN_MS = 7 * DAY;

/**
 * 讀不懂共用設定、會照舊產生完整索引的電腦：版本低於 layersMinVersion、而且 withinMs 內有活動
 * （machine.json 的最後上線或最後同步時間，取較晚的）。缺 engramVersion 算「舊版」。
 * 最後上線與最後同步時間都沒有（包含 machine.json 不存在或讀不懂）的不算：1.0.0 起每一版在登記電腦時都會寫最後上線時間，
 * 沒有的不會是真的在用的電腦；算進來的話相容模式會永遠開著，使用者只能手動刪資料夾。
 * selfMid：這台自己不算（剛升級、心跳還沒更新 machine.json 的版本時，不能被自己的舊版本號拖進相容模式）。
 * @returns {Promise<{ mid: string, label: string, version: string|null, lastActiveAt: string|null }[]>}
 */
export async function olderMachines(vaultDir, { now = Date.now(), withinMs, selfMid = null } = {}) {
  const out = [];
  const min = layersMinVersion();
  for (const mid of await listMachineIds(vaultDir)) {
    if (mid === selfMid) continue;
    // 第五輪審查 N-5：machine.json 是同步來的，讀不了（例如被做成資料夾）不能讓整理索引與同步跟著失敗，當成沒有這台
    const m = (await readJson(path.join(machineDir(vaultDir, mid), 'machine.json'), null).catch(() => null)) ?? {};
    // N-6：時間在未來一天以上的不算數（否則一筆寫錯或被改過的時間會讓相容模式一直開著）
    const times = [m.lastSeenAt, m.lastSyncAt].map((t) => (typeof t === 'string' ? Date.parse(t) : NaN)).filter((t) => Number.isFinite(t) && t <= now + DAY);
    if (!times.length || now - Math.max(...times) > withinMs) continue;
    if (!versionAtLeast(m.engramVersion, min)) {
      out.push({ mid, label: m.label ?? mid, version: m.engramVersion ?? null, lastActiveAt: new Date(Math.max(...times)).toISOString() });
    }
  }
  return out;
}

/**
 * 索引目前是不是相容模式，給 engram status 與管理介面（GET /api/status、GET /api/recall）用。
 * 相容模式時 message 與 en.message 說明原因（哪幾台還是舊版），並說明那幾台更新之後會自動切換。
 * @returns {Promise<{ active: boolean, since: string, machines: { mid: string, label: string, version: string|null, lastActiveAt: string|null }[], message?: string, en?: { message: string } }>}
 */
export async function indexCompat(vaultDir, { now = Date.now(), selfMid = null } = {}) {
  const machines = await olderMachines(vaultDir, { now, withinMs: INDEX_COMPAT_WITHIN_MS, selfMid });
  const since = layersMinVersion();
  if (!machines.length) return { active: false, since, machines };
  const list = machines.map((m) => `${m.label}（${m.version ?? '版本不明'}）`).join('、');
  const listEn = machines.map((m) => `${m.label} (${m.version ?? 'unknown version'})`).join(', ');
  return {
    active: true,
    since,
    machines,
    message: `索引目前是相容模式：${list} 還是舊版的 Engram（低於 ${since}），共用的索引（全域 INDEX.md 與各專案的 MEMORY.md）暫時照舊版的方式產生，兩邊才不會輪流改寫。那幾台更新 Engram 之後會自動切換，不需要做任何事。`,
    en: {
      message: `Index compatibility mode is on: ${listEn} still run an older Engram (below ${since}), so the shared indexes (global INDEX.md and each project's MEMORY.md) are written the old way for now, which keeps the computers from rewriting each other's files. Once those computers are updated, it switches back by itself; there is nothing to do.`,
    },
  };
}
