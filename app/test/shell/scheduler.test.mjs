// 工作排程器：登入工作的 XML 內容、UTF-16 編碼、schtasks 參數、狀態查詢；JScript 啟動器；Windows 通知。
// 不會真的建立工作排程器工作（install 用注入的假 exec）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createNotifier, POWERSHELL_AUMID, toastScript, toastXml } from '../../src/scheduler/notify.mjs';
import {
  buildTaskXml, createArgs, encodeTaskXml, install, launcherFromXml, remove, status, TASK_NAME,
} from '../../src/scheduler/task.mjs';
import { mkTmp, rmTmp, useHomes } from './helpers.mjs';

const APP = 'C:\\Users\\Sen\\Desktop\\Claude_專案記憶\\app';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const base = { userId: 'DEVPC\\Sen', nodePath: NODE, appDir: APP, systemRoot: 'C:\\Windows' };
const tag = (xml, name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];

let root;
before(() => {
  root = mkTmp();
  useHomes(root);
});
after(() => rmTmp(root));

describe('登入工作 XML', () => {
  const xml = buildTaskXml(base);

  test('預設啟動器是 wscript ＋ launch-hidden.js', () => {
    assert.equal(tag(xml, 'Command'), 'C:\\Windows\\System32\\wscript.exe');
    assert.equal(
      tag(xml, 'Arguments'),
      `//B //Nologo &quot;${APP}\\src\\scheduler\\launch-hidden.js&quot; &quot;${NODE}&quot; &quot;${APP}\\bin\\engram.mjs&quot; agent`,
    );
    assert.equal(tag(xml, 'WorkingDirectory'), APP);
  });

  test('觸發與設定照規格', () => {
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-16"\?>/);
    assert.equal(tag(xml, 'URI'), TASK_NAME);
    assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>DEVPC\\Sen<\/UserId>\s*<Delay>PT30S<\/Delay>\s*<\/LogonTrigger>/);
    assert.match(xml, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>3<\/Count>\s*<\/RestartOnFailure>/);
    assert.equal(tag(xml, 'DisallowStartIfOnBatteries'), 'false');
    assert.equal(tag(xml, 'StopIfGoingOnBatteries'), 'false');
    assert.equal(tag(xml, 'ExecutionTimeLimit'), 'PT0S');
    assert.equal(tag(xml, 'MultipleInstancesPolicy'), 'IgnoreNew');
    assert.equal(tag(xml, 'Hidden'), 'true');
    assert.equal(tag(xml, 'RunLevel'), 'LeastPrivilege');
    assert.equal(tag(xml, 'LogonType'), 'InteractiveToken');
  });

  test('標籤成對、屬性字元已跳脫', () => {
    const opens = [...xml.matchAll(/<([A-Za-z]+)[\s>]/g)].map((m) => m[1]);
    for (const name of new Set(opens)) {
      const open = (xml.match(new RegExp(`<${name}[\\s>]`, 'g')) || []).length;
      const close = (xml.match(new RegExp(`</${name}>`, 'g')) || []).length;
      assert.equal(open, close, `<${name}> 沒有成對`);
    }
    const odd = buildTaskXml({ ...base, appDir: 'C:\\A&B <x>' });
    assert.ok(odd.includes('C:\\A&amp;B &lt;x&gt;'));
    assert.ok(!odd.includes('A&B'));
  });

  test('conhost 與 direct 啟動器', () => {
    const c = buildTaskXml({ ...base, launcher: 'conhost' });
    assert.equal(tag(c, 'Command'), 'C:\\Windows\\System32\\conhost.exe');
    assert.ok(tag(c, 'Arguments').startsWith(`--headless &quot;${NODE}&quot;`));
    const d = buildTaskXml({ ...base, launcher: 'direct' });
    assert.equal(tag(d, 'Command'), NODE);
    assert.equal(tag(d, 'Arguments'), `&quot;${APP}\\bin\\engram.mjs&quot; agent`);
    assert.throws(() => buildTaskXml({ ...base, launcher: 'vbscript' }), (e) => e.code === 'E_USAGE');
  });

  test('UTF-16 LE 加 BOM、CRLF', () => {
    const buf = encodeTaskXml(xml);
    assert.deepEqual([...buf.subarray(0, 2)], [0xff, 0xfe]);
    const text = buf.subarray(2).toString('utf16le');
    assert.ok(text.includes('\r\n<Task'));
    assert.ok(text.includes('Engram 憶跡常駐程式'));
    assert.ok(!/[^\r]\n/.test(text));
  });

  test('schtasks 參數與啟動器判讀', () => {
    assert.deepEqual(createArgs('C:\\t.xml'), ['/Create', '/TN', '\\Engram\\Agent', '/XML', 'C:\\t.xml', '/F']);
    assert.equal(launcherFromXml(xml), 'wscript');
    assert.equal(launcherFromXml(buildTaskXml({ ...base, launcher: 'conhost' })), 'conhost');
    assert.equal(launcherFromXml(buildTaskXml({ ...base, launcher: 'direct' })), 'direct');
    assert.equal(launcherFromXml('<Task/>'), null);
  });
});

describe('install／remove／status（注入假的 exec，不建立真的工作）', () => {
  test('install：寫出 UTF-16 XML 給 schtasks /Create /XML，完成後刪掉暫存檔', async () => {
    let seen;
    const exec = async (cmd, args) => {
      const file = args[args.indexOf('/XML') + 1];
      seen = { cmd, args, xml: fs.readFileSync(file).subarray(2).toString('utf16le') };
      return { code: 0, stdout: '', stderr: '' };
    };
    const r = await install({ exec });
    assert.deepEqual(r, { ok: true, task: TASK_NAME, launcher: 'wscript' });
    assert.equal(seen.cmd, 'schtasks.exe');
    assert.match(seen.xml, /<Command>[^<]*wscript\.exe<\/Command>/);
    assert.equal(fs.existsSync(seen.args[4]), false);
  });

  test('install 失敗 → E_SCHTASKS，附建議', async () => {
    await assert.rejects(install({ exec: async () => ({ code: 1, stdout: '', stderr: 'denied' }) }), (e) => e.code === 'E_SCHTASKS' && /conhost/.test(e.hint));
  });

  test('remove', async () => {
    const r = await remove({ exec: async (cmd, args) => ({ code: args[0] === '/Delete' ? 0 : 1 }) });
    assert.equal(r.removed, true);
  });

  test('status：查不到 → installed=false；查得到 → 啟動器與狀態', async () => {
    assert.deepEqual(await status({ exec: async () => ({ code: 1, stdout: '', stderr: '錯誤' }) }), { installed: false, state: null, launcher: null, lastRunAt: null, lastResult: null });
    const exec = async (cmd) => (cmd === 'schtasks.exe'
      ? { code: 0, stdout: buildTaskXml(base), stderr: '' }
      : { code: 0, stdout: '{"state":"Running","lastRunAt":"2026-10-22T01:00:00.0000000Z","lastResult":267009}', stderr: '' });
    assert.deepEqual(await status({ exec }), { installed: true, state: 'running', launcher: 'wscript', lastRunAt: '2026-10-22T01:00:00.0000000Z', lastResult: 267009 });
  });

  test('status 實際查詢 schtasks（這台電腦沒有建立工作時回傳 installed=false）', { skip: process.platform !== 'win32' }, async () => {
    const r = await status();
    assert.equal(typeof r.installed, 'boolean');
  });
});

describe('JScript 啟動器', () => {
  const file = new URL('../../src/scheduler/launch-hidden.js', import.meta.url);
  const src = fs.readFileSync(file, 'utf8');

  test('純 JScript：WScript.Shell.Run(命令, 0, true)，結束碼傳回工作排程器', () => {
    assert.match(src, /new ActiveXObject\('WScript\.Shell'\)/);
    assert.match(src, /WScript\.Quit\(shell\.Run\(parts\.join\(' '\), 0, true\)\)/);
    assert.doesNotMatch(src, /CreateObject|VBScript|Dim /i);
  });

  test('只含 ASCII（WSH 以系統字碼頁讀檔，UTF-8 中文會破壞腳本）', () => {
    assert.ok([...fs.readFileSync(file)].every((b) => b < 0x80));
  });
});

describe('Windows 通知', () => {
  test('toast XML：點擊以 protocol 開啟管理介面的對應頁面，文字已跳脫', () => {
    const xml = toastXml('Engram 憶跡', '有 1 個 <衝突> & 待處理', 'http://127.0.0.1:4777/#/inbox');
    assert.match(xml, /^<toast activationType="protocol" launch="http:\/\/127\.0\.0\.1:4777\/#\/inbox">/);
    assert.ok(xml.includes('有 1 個 &lt;衝突&gt; &amp; 待處理'));
  });

  test('PowerShell 腳本使用 PowerShell 的 AUMID，單引號已跳脫', () => {
    const s = toastScript("Sen's", '內容', 'http://127.0.0.1:4777/');
    assert.ok(s.includes(POWERSHELL_AUMID));
    assert.ok(s.includes('Sen&apos;s'));
    assert.match(s, /ToastNotificationManager\]::CreateToastNotifier/);
  });

  test('同一件事 24 小時內只通知一次，記錄在 local/notify.json', async () => {
    const paths = useHomes(root);
    let now = Date.parse('2026-10-22T09:30:00Z');
    const shown = [];
    const n = createNotifier({ paths, baseUrl: 'http://127.0.0.1:4777/', show: async (title, body, url) => { shown.push({ title, body, url }); return true; }, now: () => now });
    assert.equal(await n.notify({ key: 'sync-failed', title: 'Engram 憶跡', body: '同步失敗', page: 'devices' }), true);
    assert.equal(await n.notify({ key: 'sync-failed', title: 'Engram 憶跡', body: '同步失敗', page: 'devices' }), false);
    await n.notify({ key: 'health:H01', title: 'Engram 憶跡', body: '健康檢查', page: 'inbox' });
    assert.deepEqual(shown.map((s) => s.url), ['http://127.0.0.1:4777/#/devices', 'http://127.0.0.1:4777/#/inbox']);
    const saved = JSON.parse(fs.readFileSync(path.join(paths.local, 'notify.json'), 'utf8'));
    assert.deepEqual(Object.keys(saved).sort(), ['health:H01', 'sync-failed']);
    now += 24 * 3_600_000 + 1;
    await n.notify({ key: 'sync-failed', title: 'Engram 憶跡', body: '同步失敗', page: 'devices' });
    assert.equal(shown.length, 3);
  });
});
