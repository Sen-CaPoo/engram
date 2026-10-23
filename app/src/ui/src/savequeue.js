// 自動儲存的待送清單（記憶整理頁的決定與備註）：每一欄記下最後一次修改的序號，
// 送出失敗要放回時，只放回之後沒有再改過、也還沒在清單裡的欄位，舊值永遠不會蓋掉新值。

export function createSaveQueue() {
  let pending = {}; // 還沒送出的修改：{ 項目: { 欄位: 值 } }
  const latest = {}; // 每一欄最後一次修改的序號：{ 項目: { 欄位: n } }
  let seq = 0;
  return {
    /** 記下一次修改 */
    change(item, patch) {
      pending[item] = { ...(pending[item] || {}), ...patch };
      seq += 1;
      latest[item] = { ...(latest[item] || {}) };
      for (const f of Object.keys(patch)) latest[item][f] = seq;
    },
    /** 取出要送的修改（清單清空），附上各欄當時的序號 */
    take() {
      const changes = pending;
      pending = {};
      const seqs = {};
      for (const [k, v] of Object.entries(changes)) seqs[k] = Object.fromEntries(Object.keys(v).map((f) => [f, latest[k][f]]));
      return { changes, seqs };
    },
    /** 送出失敗：把之後沒有再改過的欄位放回清單 */
    putBack({ changes, seqs }) {
      for (const [k, v] of Object.entries(changes)) {
        for (const [f, val] of Object.entries(v)) {
          if (latest[k]?.[f] !== seqs[k]?.[f]) continue; // 之後又改過（新值在清單裡，或已經送出）
          if (pending[k] && Object.hasOwn(pending[k], f)) continue;
          pending[k] = { ...(pending[k] || {}), [f]: val };
        }
      }
    },
    has(item) { return !!pending[item]; },
    get size() { return Object.keys(pending).length; },
    snapshot() { return pending; },
  };
}
