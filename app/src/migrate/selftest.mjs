// 綁定還原的自我測試（R-51）：用全合成資料在沙盒跑一次「匯入 → 綁定 → 匯入後修改 → 一鍵還原」。
// 真實資料的演練不能碰使用者的專案資料夾，所以 junction、設定檔綁定、settings.json 與專案資料夾足跡的還原，改在這裡驗證。
// 情境與檢查項目移植自 claude-57 的 D1 演練。全程只在 sandbox 底下，不碰真實的 ~/.claude、~/.engram 或任何專案資料夾。
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isLink } from '../core/fsx.mjs';
import { encodeProjectPath } from '../core/paths.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

function setAge(p, ms) {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(p, t, t);
}

function ageTree(dir, ms) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) ageTree(p, ms);
    else if (e.isFile()) setAge(p, ms);
  }
}

function memoryText({ name, description, originSessionId, body = '內容。' }) {
  return `---
name: ${name}
description: "${description}"
metadata:
  node_type: memory
  type: project
${originSessionId ? `  originSessionId: ${originSessionId}\n` : ''}  modified: 2026-10-01T00:00:00.000Z
---

${body}
`;
}

/** 建立一筆兩小時前的對話紀錄，讓引擎從中認出資料夾的真實路徑。 */
function transcript(claudeHome, cwd) {
  const dir = path.join(claudeHome, 'projects', encodeProjectPath(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const sessionId = `selftest-${crypto.randomBytes(4).toString('hex')}`;
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd, sessionId, message: { content: 'hi' } })}\n`);
  setAge(file, 2 * 3600_000);
  return sessionId;
}

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Engram Self-test');
  git(dir, 'config', 'user.email', 'selftest@example.invalid');
  fs.writeFileSync(path.join(dir, 'README.md'), '# shop-app\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** 資料夾內每個檔案的雜湊（不含 .git）；junction 記成指向的位置。 */
function hashTree(dir, out = {}, base = dir) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) { out[path.relative(base, p)] = `link:${fs.readlinkSync(p)}`; continue; }
    if (e.isDirectory()) { if (e.name !== '.git') hashTree(p, out, base); continue; }
    out[path.relative(base, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  }
  return out;
}

const changedKeys = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
const readOr = (p, fallback) => { try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; } };

/**
 * 執行自我測試。
 * @param {{ engine: { init: Function, open: Function }, sandbox: string }} o  sandbox：可寫入、結束後由呼叫端刪除的空資料夾
 * @returns {Promise<{ ok: boolean, ms: number, checks: { name: string, ok: boolean, detail: string, en: { name: string, detail: string } }[] }>}
 */
export async function bindingSelfTest({ engine, sandbox }) {
  const t0 = Date.now();
  const checks = [];
  // en：管理介面切到英文時顯示的名稱與說明（detailEn 預設與中文相同，適用於原始輸出）
  const check = (name, nameEn, ok, detail = '', detailEn = detail) => checks.push({ name, ok: !!ok, detail, en: { name: nameEn, detail: detailEn } });
  try {
    // ── 匯入前的合成世界：一個 git 專案，加上兩個路徑編碼相同的中文資料夾 ──
    const userHome = path.join(sandbox, 'user');
    const claudeHome = path.join(userHome, '.claude');
    const home = path.join(userHome, '.engram');
    const desk = path.join(userHome, 'Desktop');
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(path.join(claudeHome, 'settings.json'), `${JSON.stringify({ permissions: { defaultMode: 'auto' } }, null, 2)}\n`);

    const proj = makeRepo(path.join(desk, 'shop-app'));
    const sP = transcript(claudeHome, proj);
    const legacyP = path.join(claudeHome, 'projects', encodeProjectPath(proj), 'memory');
    fs.mkdirSync(legacyP, { recursive: true });
    fs.writeFileSync(path.join(legacyP, 'deploy-rule.md'), memoryText({ name: 'deploy-rule', description: '部署規則', originSessionId: sP, body: 'v1：週二部署。' }));
    fs.writeFileSync(path.join(legacyP, 'MEMORY.md'), '- [部署規則](deploy-rule.md) — 部署規則\n');

    const a = path.join(desk, '甲方專案');
    const b = path.join(desk, '乙方專案');
    for (const [dir, text] of [[a, 'a'], [b, 'b']]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'notes.txt'), text);
    }
    const sA = transcript(claudeHome, a);
    const sB = transcript(claudeHome, b);
    const legacyC = path.join(claudeHome, 'projects', encodeProjectPath(a), 'memory');
    fs.mkdirSync(legacyC, { recursive: true });
    fs.writeFileSync(path.join(legacyC, 'a-client.md'), memoryText({ name: 'a-client', description: '甲方聯絡窗口', originSessionId: sA }));
    fs.writeFileSync(path.join(legacyC, 'b-client.md'), memoryText({ name: 'b-client', description: '乙方聯絡窗口', originSessionId: sB }));
    fs.writeFileSync(path.join(legacyC, 'MEMORY.md'), '- [甲方](a-client.md) — 甲方\n- [乙方](b-client.md) — 乙方\n');

    const before = { settings: readOr(path.join(claudeHome, 'settings.json'), null), a: hashTree(a), b: hashTree(b), proj: hashTree(proj) };

    // ── 安裝並匯入（含綁定） ──
    await engine.init({ home, claudeHome, userHome, machineLabel: '自我測試電腦' });
    const eg = await engine.open({ home, claudeHome, userHome });
    const plan = await eg.sweepLegacy({ dryRun: true });
    const res = await eg.sweepLegacy({ dryRun: false, plan, bindSources: true });
    const method = Object.fromEntries((res.bound ?? []).map((x) => [path.basename(x.path), x.method]));
    check('撞名資料夾以設定檔綁定（甲方）', 'Colliding folder A bound through the settings file', method['甲方專案'] === 'settings', `方式：${method['甲方專案'] ?? '未綁定'}`, `Method: ${method['甲方專案'] ?? 'not bound'}`);
    check('撞名資料夾以設定檔綁定（乙方）', 'Colliding folder B bound through the settings file', method['乙方專案'] === 'settings', `方式：${method['乙方專案'] ?? '未綁定'}`, `Method: ${method['乙方專案'] ?? 'not bound'}`);
    check('撞名的共用記憶資料夾沒有換成 junction', 'The shared memory folder of the colliding folders was not replaced with a junction', !isLink(legacyC));
    check('一般 git 專案以 junction 綁定', 'A regular git project is bound through a junction', method['shop-app'] === 'junction' && isLink(legacyP), `方式：${method['shop-app'] ?? '未綁定'}`, `Method: ${method['shop-app'] ?? 'not bound'}`);

    // ── 匯入後：Claude 改了既有記憶、又新增一筆，常駐程式存檔 ──
    fs.writeFileSync(path.join(legacyP, 'deploy-rule.md'), memoryText({ name: 'deploy-rule', description: '部署規則', originSessionId: sP, body: 'v2：改成週四部署（匯入後的修改）。' }));
    fs.writeFileSync(path.join(legacyP, 'new-after-import.md'), memoryText({ name: 'new-after-import', description: '匯入後新寫的記憶' }));
    ageTree(eg.paths.vault, 60_000);
    await eg.sync({ network: false });

    // ── 一鍵還原（與「還原到匯入前」同一套程式） ──
    const rb = await eg.rollbackImport(res.restorePoint);
    check('一鍵還原完成', 'One-click restore completed', rb?.ok !== false, rb?.ok === false ? String(rb?.error ?? rb?.message ?? '') : '');
    check('還原後 git 專案的記憶資料夾換回實體資料夾', "After the restore, the git project's memory folder is a real folder again", !isLink(legacyP));
    check('匯入後的修改沒有遺失', 'Changes made after the import were not lost', /v2/.test(readOr(path.join(legacyP, 'deploy-rule.md'), '')));
    check('匯入後新寫的記憶放回原資料夾', 'Memories written after the import were put back in the original folder', fs.existsSync(path.join(legacyP, 'new-after-import.md')));
    check('settings.json 逐位元組回到匯入前', 'settings.json is byte-for-byte the same as before the import', readOr(path.join(claudeHome, 'settings.json'), null) === before.settings);
    for (const [label, labelEn, dir, key] of [['甲方', 'colliding folder A', a, 'a'], ['乙方', 'colliding folder B', b, 'b'], ['git 專案', 'git project folder', proj, 'proj']]) {
      const d = changedKeys(before[key], hashTree(dir));
      check(`${label}資料夾逐檔回到匯入前`, `The ${labelEn} is file-for-file identical to before the import`, d.length === 0, d.join('、'), d.join(', '));
    }
  } catch (err) {
    check('自我測試執行完畢', 'The self-test ran to completion', false, String(err?.message ?? err), String(err?.en?.message ?? err?.message ?? err));
  }
  return { ok: checks.length > 0 && checks.every((c) => c.ok), ms: Date.now() - t0, checks };
}
