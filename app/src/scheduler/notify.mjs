// Windows 通知（21 號文件「通知」）：透過 PowerShell 呼叫 WinRT ToastNotificationManager，隱藏視窗執行，失敗一律靜默。
// 只在需要使用者動手時通知：健康檢查出現「高」等級、同步連續失敗超過 24 小時、相容性探測失敗。
// 同一件事（key）24 小時內最多通知一次，記錄在 local/notify.json；點擊通知會開啟管理介面的對應頁面。
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../cli/fsutil.mjs';
import { run } from '../cli/proc.mjs';

// 借用 PowerShell 的 AUMID：未簽章的 Node 程式沒有自己的 AppUserModelID
export const POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
export const DEDUPE_MS = 24 * 3_600_000;

const escapeXml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
// PowerShell 單引號字串只需要把 ' 寫成 ''
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** activationType="protocol"：點擊通知時以預設瀏覽器開啟 launch 網址 */
export function toastXml(title, body, launchUrl) {
  const launch = launchUrl ? ` activationType="protocol" launch="${escapeXml(launchUrl)}"` : '';
  return `<toast${launch}><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${escapeXml(body)}</text></binding></visual></toast>`;
}

export function toastScript(title, body, launchUrl) {
  return [
    "$ErrorActionPreference='Stop'",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml(${psQuote(toastXml(title, body, launchUrl))})`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psQuote(POWERSHELL_AUMID)}).Show($toast)`,
  ].join('\n');
}

/** 顯示一則通知；成功回傳 true。中文經 -EncodedCommand（UTF-16 LE）傳遞，不受主控台字碼頁影響。 */
export async function showToast(title, body, launchUrl, { exec = run } = {}) {
  if (process.platform !== 'win32') return false;
  try {
    const encoded = Buffer.from(toastScript(title, body, launchUrl), 'utf16le').toString('base64');
    const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { timeoutMs: 15_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

/**
 * 有去重功能的通知器。
 * @param {{ paths: { local: string }, baseUrl?: string, show?: typeof showToast, now?: () => number }} deps
 * @returns {{ notify(n: { key: string, title: string, body: string, page?: string }): Promise<boolean> }}
 *   page 為管理介面的路由，例如 'inbox'、'devices'、'schedule'
 */
export function createNotifier({ paths, baseUrl = 'http://127.0.0.1:4777/', show = showToast, now = Date.now }) {
  const file = path.join(paths.local, 'notify.json');
  return {
    async notify({ key, title, body, page }) {
      try {
        const sent = (await readJson(file, {})) ?? {};
        const last = Date.parse(sent[key] ?? '');
        if (Number.isFinite(last) && now() - last < DEDUPE_MS) return false;
        // 只保留 24 小時內的紀錄，檔案不會無限長大
        const kept = Object.fromEntries(Object.entries(sent).filter(([, at]) => now() - Date.parse(at) < DEDUPE_MS));
        kept[key] = new Date(now()).toISOString();
        await writeJsonAtomic(file, kept);
        return await show(title, body, page ? `${baseUrl}#/${page}` : baseUrl);
      } catch {
        return false;
      }
    },
  };
}
