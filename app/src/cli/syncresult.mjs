// eg.sync() 的結果判讀。引擎失敗時不丟例外，而是回傳 { ok:false, state, error }；
// state 為 'locked' 表示另一個同步正在進行（稍後再試即可）。

export function isLocked(res) {
  return res?.ok === false && (res.state === 'locked' || res.error?.code === 'E_LOCKED');
}

/** 失敗時回傳 { code, message, hint }；成功回傳 null */
export function syncFailure(res) {
  if (res?.ok !== false) return null;
  return res.error ?? { code: 'E_SYNC', message: `同步失敗（${res.state ?? '未知狀態'}）`, hint: '', en: { message: `Sync failed (${res.state ?? 'unknown state'})` } };
}

/** 給人看的摘要（字串陣列）；network=false 表示只做本機 commit */
export function summarizeSync(res, { network = true } = {}) {
  const lines = [
    network
      ? `同步完成：本機 commit ${res?.committed ?? 0} 次、拉取 ${res?.pulled ?? 0} 個 commit、${res?.pushed ? '已推送' : '沒有需要推送的變更'}。`
      : `已完成本機存檔：commit ${res?.committed ?? 0} 次（未連網）。`,
  ];
  if (res?.conflicts?.length) lines.push(`有 ${res.conflicts.length} 筆衝突，對方版本已隔離到 vault/conflicts/，請在管理介面處理。`);
  if (res?.skipped?.secrets?.length) lines.push(`有 ${res.skipped.secrets.length} 個檔案疑似含有金鑰，沒有同步；記憶裡請只記「存放位置」。`);
  if (res?.held?.length) lines.push('偵測到大量刪除，這些刪除暫不提交，請在管理介面確認。');
  return lines;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** summarizeSync 的英文版（管理介面切到英文時顯示）；代入的數值與中文版完全相同 */
export function summarizeSyncEn(res, { network = true } = {}) {
  const committed = res?.committed ?? 0;
  const pulled = res?.pulled ?? 0;
  const lines = [
    network
      ? `Sync complete: ${plural(committed, 'local commit', 'local commits')}, pulled ${plural(pulled, 'commit', 'commits')}, ${res?.pushed ? 'pushed' : 'no changes to push'}.`
      : `Local save complete: ${plural(committed, 'commit', 'commits')} (not online).`,
  ];
  if (res?.conflicts?.length) lines.push(`${plural(res.conflicts.length, 'conflict', 'conflicts')} found. The other computer's version was set aside in vault/conflicts/. Resolve in the dashboard.`);
  if (res?.skipped?.secrets?.length) lines.push(`${plural(res.skipped.secrets.length, 'file was', 'files were')} not synced because of a possible secret. In memories, record only where the secret is stored.`);
  if (res?.held?.length) lines.push('Mass deletions detected. These deletions are not committed yet. Confirm them in the dashboard.');
  return lines;
}
