// 記憶範圍的規則判斷（收編建議與健康檢查 H08、H09 共用）。原則是保守：寧可留在專案，再由收件匣建議搬移。
// 把專案記憶誤判成單機的代價遠大於反過來：另一台電腦開同一個專案時，那些記憶不會載入，而且使用者不會察覺。
// 規則依真實資料演練校正（claude-25 的匯入演練，2026-10-22，兩輪）：
// - 只提到磁碟路徑不算單機（很多專案記憶都會寫路徑）
// - 中文「本機」多半是 local 的意思（本機驗證、本機開發、在本機跑），單獨出現不算
// - 強訊號只有「這台電腦／這台機器／this machine」與主機名稱
// - 「本機＋環境詞」「安裝位置」「網路設定」必須搭配磁碟路徑或主機名稱才算；「磁碟狀態」（C 槽寫滿、磁碟空間）單獨成立（22 號規則）
// - 規則只產生建議：例如雲端 VM 的磁碟監控也會被當成磁碟狀態，匯入精靈與收件匣讓使用者更正
// - type=user 一律視為跨專案，不判成單機

const STRONG = /這台[^，。；\n]{0,12}?(電腦|機器|主機|PC)|this (windows )?(machine|pc|computer)\b|on this (pc|computer|machine)\b/i;
const LOCAL_ENV = /本機(的)?(安裝|網路|路徑|環境|設定|磁碟|硬碟|IP)/;
const INSTALL_AT = /安裝(在|於|到|位置|路徑)|installed (at|in|to|under)\b|install(ation)? (path|dir|location)/i;
const DISK_STATE = /[A-Z]\s?槽(寫滿|空間|容量|已滿)|磁碟(空間|容量|寫滿|已滿)|disk (is )?(full|space)/i;
const NETWORK_SET = /(網路|網卡|IP\s?位址|DNS|路由器|MTU|TCP)(設定|基準|環境|優化|參數)|network (baseline|settings|adapter|tuning)/i;
const DRIVE_PATH = /(?:^|[\s(`"'（「=])[A-Za-z]:[\\/]/m;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * 判斷內容是否只在某台電腦成立。
 * @param {{ type?: string, text: string, hostnames?: string[] }} input
 * @returns {{ yes: boolean, reasons: string[] }}
 */
export function machineSpecific({ type, text, hostnames = [] }) {
  if (type === 'user') return { yes: false, reasons: [] };
  const reasons = [];
  if (STRONG.test(text)) reasons.push('提到這台電腦');
  let host = null;
  for (const h of hostnames) {
    if (h && h.length >= 4 && new RegExp(`\\b${escapeRe(h)}\\b`, 'i').test(text)) { host = h; break; }
  }
  if (host) reasons.push(`提到主機名稱 ${host}`);
  if (!reasons.length) {
    const anchored = DRIVE_PATH.test(text);
    if (anchored && LOCAL_ENV.test(text)) reasons.push('描述本機環境，並含本機路徑');
    else if (anchored && INSTALL_AT.test(text)) reasons.push('記錄安裝位置');
    else if (DISK_STATE.test(text)) reasons.push('描述磁碟狀況');
    else if (anchored && NETWORK_SET.test(text)) reasons.push('記錄網路設定');
  }
  return { yes: reasons.length > 0, reasons };
}

/**
 * 收編時的預設範圍建議。
 * @returns {{ scope: 'project'|'global'|'machine', reason: string }}
 */
export function suggestScope({ type, text, hostnames = [] }) {
  if (type === 'user') return { scope: 'global', reason: '使用者層級的資訊，所有專案都適用' };
  const m = machineSpecific({ type, text, hostnames });
  if (m.yes) return { scope: 'machine', reason: m.reasons.join('、') };
  return { scope: 'project', reason: type === 'feedback' ? '回饋類型先留在專案，收件匣會建議是否升級為全域' : '專案相關' };
}

/** 寬鬆比對名稱：忽略大小寫、空白、. - _ */
export function looseName(s) {
  return String(s ?? '').toLowerCase().replace(/[\s._\-]+/g, '');
}
