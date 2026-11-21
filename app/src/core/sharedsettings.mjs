// 所有電腦共用的設定（2.0.0 WP4a）：vault/settings.json，隨記憶庫同步。目前只有 indexLayers（索引分層）。
// 全域與單機 INDEX.md 的產生只看這裡的值，所以兩台電腦算出來一定一樣，不會互相改寫。
// 這個檔不是記憶：不在 global/、projects/、machines/ 底下，不進索引、搜尋與健康檢查的記憶清單；寫入後照一般的 commit 與同步流程。
// 兩台同時修改（git 合併衝突）時留 updatedAt 較新的一份（core/sync.mjs 的 resolveUnmerged）。
import path from 'node:path';
import { readJson } from './fsx.mjs';

export const SHARED_SETTINGS = 'settings.json';
export const INDEX_LAYERS = Object.freeze(['observe', 'on', 'off']);
export const sharedSettingsFile = (vaultDir) => path.join(vaultDir, SHARED_SETTINGS);

/** 共用設定；檔案不存在或看不懂的值用預設（indexLayers: observe） */
export async function readSharedSettings(vaultDir) {
  const s = (await readJson(sharedSettingsFile(vaultDir), null)) ?? {};
  return {
    indexLayers: INDEX_LAYERS.includes(s?.indexLayers) ? s.indexLayers : 'observe',
    updatedAt: typeof s?.updatedAt === 'string' ? s.updatedAt : null,
    by: typeof s?.by === 'string' ? s.by : null,
  };
}

/**
 * 合併兩台同時改過的 settings.json：留 updatedAt 較新的那份原文（一樣新時留字典序較後的原文，兩台合併結果相同）；
 * 其中一邊讀不懂就留另一邊；兩邊都讀不懂回傳 null（交給一般的衝突處理）。
 */
export function mergeSharedSettings(ours, theirs) {
  const read = (text) => {
    try {
      const j = JSON.parse(text);
      return j && typeof j === 'object' && !Array.isArray(j) ? { text, at: Date.parse(j.updatedAt) || 0 } : null;
    } catch {
      return null;
    }
  };
  const a = read(ours);
  const b = read(theirs);
  if (!a || !b) return (a ?? b)?.text ?? null;
  if (a.at !== b.at) return (b.at > a.at ? b : a).text;
  return a.text >= b.text ? a.text : b.text;
}
