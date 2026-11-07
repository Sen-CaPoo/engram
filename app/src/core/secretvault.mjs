// 本機保管區（1.5.0）：自動駕駛把記憶裡真的金鑰移到這裡，記憶改寫成只記存放位置，之後就能正常同步。
// 位置 ~/.engram/local/secrets/<名稱>.json（local 不同步）；值用 Windows DPAPI（CurrentUser）加密，
// 只有這台電腦的這個使用者解得開。取出：engram secret get <名稱>。
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { E, EngramError, invariant } from './errors.mjs';

export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const dirOf = (local) => path.join(local, 'secrets');
const fileOf = (local, name) => path.join(dirOf(local), `${name}.json`);

// 值一律從 stdin 傳 base64，不出現在命令列
const PS_PROTECT = "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
const PS_UNPROTECT = "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";

function powershell(script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      const text = Buffer.concat(out).toString('utf8').trim();
      if (code !== 0 || !/^[A-Za-z0-9+/=]+$/.test(text)) reject(new EngramError('E_INTERNAL', `本機保管區加解密失敗：${Buffer.concat(err).toString('utf8').trim().slice(0, 200) || `結束碼 ${code}`}`).withEn('The local secret store could not encrypt or decrypt'));
      else resolve(text);
    });
    child.stdin.end(input);
  });
}

/** 測試可替換的加解密（預設 DPAPI） */
export const crypto = {
  protect: async (value) => powershell(PS_PROTECT, Buffer.from(String(value), 'utf8').toString('base64')),
  unprotect: async (data) => Buffer.from(await powershell(PS_UNPROTECT, data), 'base64').toString('utf8'),
};

/** 存入；同名且同值時沿用，同名不同值時在名稱後面加數字 */
export async function putSecret(local, { name, value, label = '', from = null, kind = null }) {
  invariant(NAME_RE.test(String(name ?? '')), `保管區名稱要是 kebab-case 英數：${String(name ?? '').slice(0, 40)}`, undefined, { message: 'The secret name must be kebab-case letters and digits' });
  invariant(typeof value === 'string' && value.length > 0, '沒有要保管的值', undefined, { message: 'No value to store' });
  await fsp.mkdir(dirOf(local), { recursive: true });
  let n = name;
  for (let i = 2; i < 100; i++) {
    const cur = await readEntry(local, n);
    if (!cur) break;
    if ((await crypto.unprotect(cur.data).catch(() => null)) === value) return { name: n, reused: true };
    n = `${name}-${i}`;
  }
  const entry = { v: 1, name: n, label: String(label).slice(0, 200), from, kind, createdAt: new Date().toISOString(), data: await crypto.protect(value) };
  await fsp.writeFile(fileOf(local, n), `${JSON.stringify(entry, null, 2)}\n`, { flag: 'wx' });
  return { name: n, reused: false };
}

async function readEntry(local, name) {
  try { return JSON.parse(await fsp.readFile(fileOf(local, name), 'utf8')); } catch { return null; }
}

export async function getSecret(local, name) {
  invariant(NAME_RE.test(String(name ?? '')), '保管區名稱格式不正確', undefined, { message: 'Invalid secret name' });
  const e = await readEntry(local, name);
  if (!e) throw new EngramError(E.NOT_FOUND, `保管區裡沒有「${name}」`, 'engram secret list 可以列出這台電腦保管的項目').withEn(`No "${name}" in the local secret store`, 'engram secret list shows what this computer stores');
  return crypto.unprotect(e.data);
}

/** 清單（不含值） */
export async function listSecrets(local) {
  const out = [];
  for (const n of (await fsp.readdir(dirOf(local)).catch(() => [])).filter((x) => x.endsWith('.json')).sort()) {
    const e = await readEntry(local, n.slice(0, -5));
    if (e?.name) out.push({ name: e.name, label: e.label ?? '', from: e.from ?? null, kind: e.kind ?? null, createdAt: e.createdAt ?? null });
  }
  return out;
}

/**
 * 保管區裡所有值（解不開的略過）。對話回顧匯出對話文字時用來遮蔽：Claude 依記憶執行 engram secret get 之後，
 * 值會以原樣出現在對話紀錄的工具結果裡，一般的金鑰偵測不一定認得出來（例如沒有前綴的短密碼）。
 * 保管區是空的時候不會啟動 PowerShell。
 */
const valueCache = new Map(); // local → { at, values }：同一個程序 10 分鐘內不重複解密（每筆都要啟動一次 PowerShell）

export async function vaultValues(local) {
  const hit = valueCache.get(local);
  const names = (await fsp.readdir(dirOf(local)).catch(() => [])).filter((x) => x.endsWith('.json')).sort().join('|');
  if (!names) return [];
  if (hit && hit.names === names && Date.now() - hit.at < 600_000) return hit.values;
  const out = [];
  let failed = false;
  for (const n of (await fsp.readdir(dirOf(local)).catch(() => [])).filter((x) => x.endsWith('.json'))) {
    const e = await readEntry(local, n.slice(0, -5));
    if (!e?.data) continue;
    const value = await crypto.unprotect(e.data).catch(() => null);
    if (typeof value !== 'string') { failed = true; continue; }
    if (value.length >= 4) out.push({ name: e.name, value });
  }
  const values = out.sort((a, b) => b.value.length - a.value.length);
  // 有解不開的：這次不能保證遮蔽完整，交給呼叫端決定（對話回顧會先不匯出）；也不快取，下次再試
  if (failed) throw new EngramError('E_VAULT', '本機保管區有項目解不開，這次先不匯出對話（避免金鑰值出現在匯出的文字裡）', '稍後再試；一直失敗時執行 engram secret list 檢查保管區').withEn('Some items in the local secret store could not be decrypted, so conversations were not exported this time', 'Try again later');
  valueCache.set(local, { at: Date.now(), names, values });
  return values;
}

/** 把文字裡出現的保管區值換成標記 */
export function scrubVault(text, values, { short = true } = {}) {
  let t = String(text ?? '');
  for (const v of values) {
    if (!t.includes(v.value)) continue;
    const mark = `‹保管區：${v.name}›`;
    if (v.value.length >= 8) { t = t.split(v.value).join(mark); continue; }
    if (!short) continue;
    // 短值（未滿 8 字）：值的頭尾是英數字時，前後也不能緊接英數字，免得換掉一般文字的片段
    const esc = v.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pre = /^[A-Za-z0-9]/.test(v.value) ? '(?<![A-Za-z0-9])' : '';
    const post = /[A-Za-z0-9]$/.test(v.value) ? '(?![A-Za-z0-9])' : '';
    t = t.replace(new RegExp(`${pre}${esc}${post}`, 'g'), () => mark);
  }
  return t;
}

/** 記憶裡取代金鑰值的文字 */
export const placeholder = (name) => `‹存放在 Engram 本機保管區：${name}（engram secret get ${name}）›`;
