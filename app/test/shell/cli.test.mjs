// CLI：參數解析、指令分派、人看的輸出與 --json、錯誤格式與結束碼。引擎一律用假引擎。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { parseCommandArgs, parseDuration, parsePositiveInt } from '../../src/cli/args.mjs';
import { COMMANDS, extraArgs, main } from '../../src/cli/main.mjs';
import { capture, mkTmp, rmTmp, stdinFrom, useHomes } from './helpers.mjs';
import { createFakeEngine } from './fake-engine.mjs';

const PKG_VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
let root;
let paths;
before(() => {
  root = mkTmp();
  paths = useHomes(root);
});
after(() => rmTmp(root));

/** 執行 engram 指令，回傳 { code, out, err, eg } */
async function engram(argv, { eg = createFakeEngine({ home: paths.home }), stdin, ...deps } = {}) {
  const out = capture();
  const err = capture();
  const code = await main(argv, {
    loadEngine: async () => eg,
    stdout: out.stream,
    stderr: err.stream,
    stdin: stdin ?? { isTTY: true },
    cwd: path.join(root, 'proj'),
    ...deps,
  });
  return { code, out: out.text, err: err.text, eg };
}

const stubScheduler = (st = { installed: false, state: null, launcher: null, lastRunAt: null }) => ({
  TASK_NAME: '\\Engram\\Agent',
  LAUNCHERS: ['wscript', 'conhost', 'direct'],
  calls: [],
  async status() { return st; },
  async install(o) { this.calls.push(['install', o]); return { ok: true, task: '\\Engram\\Agent', launcher: o.launcher }; },
  async remove() { this.calls.push(['remove']); return { ok: true, removed: true }; },
});

describe('參數解析', () => {
  test('選項、值與位置參數', () => {
    const { opts, args } = parseCommandArgs(['a', '--local', '--debounce', '30s', 'b', '--json'], { local: { type: 'boolean' }, debounce: { type: 'string' } });
    assert.deepEqual(args, ['a', 'b']);
    assert.equal(opts.local, true);
    assert.equal(opts.debounce, '30s');
    assert.equal(opts.json, true);
  });

  test('--name=值 的寫法', () => {
    const { opts } = parseCommandArgs(['--name=x-y'], { name: { type: 'string' } });
    assert.equal(opts.name, 'x-y');
  });

  test('不認得的選項 → E_USAGE，訊息為中文', () => {
    assert.throws(() => parseCommandArgs(['--bogus']), (e) => e.code === 'E_USAGE' && /不認得的選項：--bogus/.test(e.message));
  });

  test('選項少了值 → E_USAGE', () => {
    assert.throws(() => parseCommandArgs(['--scope'], { scope: { type: 'string' } }), (e) => e.code === 'E_USAGE');
  });

  test('時間長度', () => {
    assert.equal(parseDuration('30s'), 30_000);
    assert.equal(parseDuration('10m'), 600_000);
    assert.equal(parseDuration('500ms'), 500);
    assert.equal(parseDuration('2'), 2000);
    assert.equal(parseDuration('1h'), 3_600_000);
    assert.throws(() => parseDuration('soon'), (e) => e.code === 'E_USAGE');
  });

  test('正整數', () => {
    assert.equal(parsePositiveInt('4777', '--port', { max: 65535 }), 4777);
    assert.throws(() => parsePositiveInt('0', '--port'), (e) => e.code === 'E_USAGE');
    assert.throws(() => parsePositiveInt('70000', '--port', { max: 65535 }), (e) => e.code === 'E_USAGE');
  });

  test('每個指令都有中文說明與用法', () => {
    for (const name of ['status', 'sync', 'bind', 'unbind', 'projects', 'search', 'remember', 'doctor', 'ui', 'agent', 'hook', 'import', 'schedule', 'merge-driver', 'install', 'uninstall', 'version', 'help']) {
      assert.ok(COMMANDS[name], `缺少指令 ${name}`);
      assert.match(COMMANDS[name].summary, /[一-鿿]/, `${name} 的說明應為中文`);
    }
  });

  // 1.4.1：多出來的位置參數不能被默默丟掉；新加的指令忘了宣告就會在這裡失敗
  test('每個指令都宣告位置參數上限（hook、merge-driver 除外）', () => {
    for (const [name, c] of Object.entries(COMMANDS)) {
      if (c.neverFail) continue;
      assert.ok(typeof c.args === 'number' || (c.args && typeof c.args === 'object'), `${name} 沒有宣告 args`);
    }
  });

  test('extraArgs：數字上限、子指令上限、不認得的子指令交給指令本身', () => {
    assert.deepEqual(extraArgs(0, []), []);
    assert.deepEqual(extraArgs(1, ['a', 'b', 'c']), ['b', 'c']);
    assert.deepEqual(extraArgs(Infinity, ['a', 'b']), []);
    const spec = { '': 0, show: Infinity, apply: 1 };
    assert.deepEqual(extraArgs(spec, []), []);
    assert.deepEqual(extraArgs(spec, ['apply', 'x']), []);
    assert.deepEqual(extraArgs(spec, ['apply', 'x', 'y']), ['y']);
    assert.deepEqual(extraArgs(spec, ['show', 'x', 'y', 'z']), []);
    assert.deepEqual(extraArgs(spec, ['nope', 'x', 'y']), []);
    assert.deepEqual(extraArgs(spec, ['toString', 'x']), [], '原型鏈上的名稱不能被當成子指令');
    assert.deepEqual(extraArgs(undefined, ['a']), []);
  });
});

describe('分派與錯誤格式', () => {
  test('version', async () => {
    const r = await engram(['version']);
    assert.equal(r.code, 0);
    // 版本號的單一來源是 app/package.json（S6）：測試不寫死版本，改版本時不必動這裡
    assert.ok(r.out.startsWith(`engram ${PKG_VERSION}（Node v`), r.out);
    const j = await engram(['version', '--json']);
    assert.equal(JSON.parse(j.out).version, PKG_VERSION);
  });

  test('沒有這個指令 → exit 2，印出錯誤與建議', async () => {
    const r = await engram(['nope']);
    assert.equal(r.code, 2);
    assert.match(r.err, /錯誤：沒有這個指令：nope（E_USAGE）/);
    assert.match(r.err, /建議：/);
  });

  test('--json 的錯誤是 { error: { code, message, hint } }', async () => {
    const r = await engram(['search', '--json']);
    assert.equal(r.code, 2);
    const e = JSON.parse(r.out).error;
    assert.equal(e.code, 'E_USAGE');
    assert.ok(e.message && e.hint);
  });

  test('引擎錯誤沿用 code 與 hint，exit 1', async () => {
    const eg = createFakeEngine({ home: paths.home });
    eg.status = async () => { throw Object.assign(new Error('這台電腦還沒有設定 Engram'), { code: 'E_NOT_FOUND', hint: '執行 engram install' }); };
    const r = await engram(['status'], { eg });
    assert.equal(r.code, 1);
    assert.match(r.err, /這台電腦還沒有設定 Engram（E_NOT_FOUND）\n建議：執行 engram install/);
  });

  test('help 列出所有指令；help <指令> 顯示單一用法', async () => {
    const r = await engram(['help']);
    assert.equal(r.code, 0);
    for (const n of ['remember', 'search', 'status', 'schedule', 'uninstall']) assert.match(r.out, new RegExp(`\\b${n}\\b`));
    const one = await engram(['sync', '--help']);
    assert.match(one.out, /用法：engram sync \[--local\]/);
  });
});

describe('記憶指令', () => {
  test('search：輸出名稱、說明、範圍與完整路徑', async () => {
    const r = await engram(['search', 'powershell', 'bom']);
    assert.equal(r.code, 0);
    assert.match(r.out, /找到 1 筆/);
    assert.match(r.out, /powershell-bom — 含中文的 \.ps1 要加 BOM（全域）/);
    assert.ok(r.out.includes(path.join(paths.vault, 'global', 'powershell-bom.md')));
    assert.deepEqual(r.eg.calls.find((c) => c.name === 'search').args, ['powershell bom', { limit: 10 }]);
  });

  test('search：沒有關鍵字 → exit 2；--json 回傳 Hit[]', async () => {
    assert.equal((await engram(['search'])).code, 2);
    const j = await engram(['search', 'x', '--json', '--limit', '5']);
    assert.ok(Array.isArray(JSON.parse(j.out)));
    assert.equal(j.eg.calls.find((c) => c.name === 'search').args[1].limit, 5);
  });

  test('remember：內文從標準輸入，寫入全域記憶，輸出一行確認', async () => {
    const r = await engram(['remember', '--scope', 'global', '--name', 'answer-in-zh', '--type', 'feedback', '--description', '一律用正體中文回答'], {
      stdin: stdinFrom('回答使用正體中文。\n**Why:** 使用者偏好\n'),
    });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), '已記住：global/answer-in-zh.md（全域）');
    const input = r.eg.calls.find((c) => c.name === 'memories.create').args[0];
    assert.deepEqual(input.scope, { kind: 'global' });
    assert.equal(input.type, 'feedback');
    assert.match(input.body, /^回答使用正體中文。/);
  });

  test('remember --scope machine --project：範圍帶本機 mid，project 標註相關專案', async () => {
    const r = await engram(['remember', '--scope', 'machine', '--name', 'proxy', '--type', 'reference', '--description', '公司代理', '--project', 'acme-gateway-3fa9k', '--body', 'proxy.corp:8080']);
    assert.equal(r.code, 0, r.err);
    const input = r.eg.calls.find((c) => c.name === 'memories.create').args[0];
    assert.deepEqual(input.scope, { kind: 'machine', mid: 'office-7k2q' });
    assert.equal(input.project, 'acme-gateway-3fa9k');
  });

  test('remember --scope project：pid 由目前資料夾解析', async () => {
    const r = await engram(['remember', '--scope', 'project', '--name', 'deploy', '--type', 'project', '--description', '部署步驟', '--body', '先跑測試']);
    assert.equal(r.code, 0, r.err);
    const input = r.eg.calls.find((c) => c.name === 'memories.create').args[0];
    assert.deepEqual(input.scope, { kind: 'project', pid: 'acme-gateway-3fa9k' });
    assert.equal(input.project, undefined);
  });

  test('remember 缺少必要選項或內文 → exit 2', async () => {
    assert.equal((await engram(['remember', '--scope', 'global', '--name', 'x', '--description', 'd', '--body', 'b'])).code, 2, '缺 --type');
    assert.equal((await engram(['remember', '--scope', 'everywhere', '--name', 'x', '--type', 'user', '--description', 'd', '--body', 'b'])).code, 2, '範圍不正確');
    assert.equal((await engram(['remember', '--scope', 'global', '--name', 'x', '--type', 'user', '--description', 'd'])).code, 2, '終端機沒有內文');
  });
});

describe('同步、綁定與專案', () => {
  test('status：人看的摘要與 --json', async () => {
    const r = await engram(['status']);
    assert.equal(r.code, 0);
    assert.match(r.out, /Engram 憶跡 · 公司電腦（office-7k2q）/);
    assert.match(r.out, /同步：已同步/);
    assert.match(r.out, /目前資料夾：.* → acme-gateway-3fa9k（已綁定）/);
    assert.match(r.out, /常駐程式：沒有在執行/);
    const j = JSON.parse((await engram(['status', '--json'])).out);
    assert.equal(j.machine.id, 'office-7k2q');
    assert.equal(j.here.pid, 'acme-gateway-3fa9k');
    assert.equal(j.agentProcess.running, false);
  });

  test('status：索引是相容模式時多一行（哪幾台還是舊版、更新後自動切換），--json 帶 indexCompat；不是相容模式沒有這一行', async () => {
    const eg = createFakeEngine({ home: paths.home });
    const base = await eg.status();
    assert.doesNotMatch((await engram(['status'], { eg })).out, /索引：相容模式/);
    const compat = { active: true, since: '2.0.0', machines: [{ mid: 'old-1', label: '舊筆電', version: '1.6.0', lastActiveAt: '2026-11-20T00:00:00.000Z' }, { mid: 'old-2', label: '門市桌機', version: null, lastActiveAt: null }], message: 'm', en: { message: 'm' } };
    eg.status = async () => ({ ...base, indexCompat: compat });
    const r = await engram(['status'], { eg });
    assert.match(r.out, /索引：相容模式（舊筆電（1\.6\.0）、門市桌機（版本不明） 還是舊版，共用的索引暫時照舊版的方式產生；那幾台更新之後會自動切換）/);
    assert.deepEqual(JSON.parse((await engram(['status', '--json'], { eg })).out).indexCompat, compat);
    eg.status = async () => ({ ...base, indexCompat: { active: false, since: '2.0.0', machines: [] } });
    assert.doesNotMatch((await engram(['status'], { eg })).out, /索引：相容模式/);
  });

  test('sync --local 只做本機存檔', async () => {
    const r = await engram(['sync', '--local']);
    assert.equal(r.code, 0);
    assert.deepEqual(r.eg.calls.find((c) => c.name === 'sync').args[0], { network: false });
    assert.match(r.out, /已完成本機存檔/);
  });

  test('sync：拿不到鎖時略過（exit 0）；其他失敗 exit 1 並附建議', async () => {
    const eg = createFakeEngine({ home: paths.home });
    eg.sync = async () => ({ ok: false, state: 'locked', error: { code: 'E_LOCKED', message: '鎖被占用', hint: '' } });
    const locked = await engram(['sync'], { eg });
    assert.equal(locked.code, 0);
    assert.match(locked.out, /另一個同步正在進行/);
    eg.sync = async () => ({ ok: false, state: 'offline', error: { code: 'E_OFFLINE', message: '連不到 GitHub', hint: '檢查網路' } });
    const offline = await engram(['sync'], { eg });
    assert.equal(offline.code, 1);
    assert.match(offline.err, /連不到 GitHub（E_OFFLINE）\n建議：檢查網路/);
  });

  test('sync --debounce：短時間內的多個要求只執行最後一個', async () => {
    const eg = createFakeEngine({ home: paths.home });
    const first = engram(['sync', '--local', '--debounce', '400ms'], { eg });
    await new Promise((r) => setTimeout(r, 100));
    const second = engram(['sync', '--local', '--debounce', '400ms'], { eg });
    const [a, b] = await Promise.all([first, second]);
    assert.match(a.out, /已有較新的同步要求/);
    assert.match(b.out, /已完成本機存檔/);
    assert.equal(eg.calls.filter((c) => c.name === 'sync').length, 1);
  });

  test('bind：--create 建立新專案；--pid 與 --create 不能同時使用', async () => {
    const r = await engram(['bind', 'sub', '--create', '王品集團']);
    assert.equal(r.code, 0, r.err);
    const [dir, target] = r.eg.calls.find((c) => c.name === 'identity.bind').args;
    assert.equal(dir, path.join(root, 'proj', 'sub'));
    assert.deepEqual(target, { create: { name: '王品集團' } });
    assert.match(r.out, /已綁定：.*（新專案）/);
    assert.equal((await engram(['bind', '--pid', 'a', '--create', 'b'])).code, 2);
  });

  test('projects 與 unbind', async () => {
    const p = await engram(['projects']);
    assert.match(p.out, /共 1 個專案/);
    assert.match(p.out, /Acme_Gateway（acme-gateway-3fa9k）· 3 筆記憶/);
    const u = await engram(['unbind']);
    assert.match(u.out, /已解除綁定（acme-gateway-3fa9k）/);
  });

  test('import：未指定子指令 → exit 2；apply 沒有 --yes 不執行', async () => {
    assert.equal((await engram(['import'])).code, 2);
    const r = await engram(['import', 'apply']);
    assert.equal(r.code, 2);
    assert.equal(r.eg.calls.length, 0);
  });
});

describe('系統指令', () => {
  test('doctor：引擎檢查、常駐程式、登入工作、健康檢查', async () => {
    const r = await engram(['doctor'], { scheduler: stubScheduler() });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /✓ git 執行檔/);
    assert.match(r.out, /✗ 常駐程式：沒有在執行/);
    assert.match(r.out, /✗ 登入工作：尚未建立/);
    assert.match(r.out, /\[高\] H01 專案索引超過載入上限/);
  });

  test('doctor --probe：契約失敗時 exit 1，列出暫停的自動化', async () => {
    const runProbe = async () => ({ at: new Date().toISOString(), claudeVersion: '2.1.306', ok: false, checks: [
      { id: 'C2', label: '子資料夾', ok: false, detail: '路徑不同' },
      { id: 'C7', label: 'symlink', ok: true, detail: '' },
    ] });
    const r = await engram(['doctor', '--probe'], { scheduler: stubScheduler(), runProbe });
    assert.equal(r.code, 1);
    assert.match(r.out, /相容性探測（Claude Code 2\.1\.306）：1\/2 通過/);
    assert.match(r.out, /已暫停的自動化：背景綁定、junction 熱切換/);
    const j = JSON.parse((await engram(['doctor', '--probe', '--json'], { scheduler: stubScheduler(), runProbe })).out);
    assert.deepEqual(j.paused, ['bind', 'junction']);
  });

  test('doctor：引擎無法載入仍會完成其他檢查', async () => {
    const r = await engram(['doctor'], {
      scheduler: stubScheduler(),
      loadEngine: async () => { throw Object.assign(new Error('無法載入 Engram 引擎'), { code: 'E_ENGINE_MISSING' }); },
    });
    assert.equal(r.code, 1);
    assert.match(r.out, /✗ 引擎無法載入/);
    assert.match(r.out, /登入工作/);
  });

  test('schedule：status、install（預設 wscript）、錯誤的啟動器', async () => {
    const s = stubScheduler();
    assert.match((await engram(['schedule', 'status'], { scheduler: s })).out, /尚未建立登入工作/);
    const r = await engram(['schedule', 'install'], { scheduler: s });
    assert.equal(r.code, 0);
    assert.deepEqual(s.calls[0], ['install', { launcher: 'wscript' }]);
    assert.match(r.out, /已建立登入工作 \\Engram\\Agent（wscript（隱藏視窗））/);
    assert.equal((await engram(['schedule', 'install', '--launcher', 'powershell'], { scheduler: s })).code, 2);
    assert.equal((await engram(['schedule'], { scheduler: s })).code, 2);
  });

  test('install／uninstall 的選項驗證', async () => {
    assert.equal((await engram(['install', '--bogus'])).code, 2);
    assert.equal((await engram(['uninstall', '--force'])).code, 2);
    assert.match((await engram(['install', '--help'])).out, /--create-remote/);
  });

  test('hook 與 merge-driver 永遠 exit 0', async () => {
    const h = await engram(['hook', 'no-such-event', '--bogus']);
    assert.equal(h.code, 0);
    assert.equal(h.out, '');
    const m = await engram(['merge-driver', path.join(root, 'nope-O'), path.join(root, 'nope-A'), path.join(root, 'nope-B'), 'global/x.md']);
    assert.equal(m.code, 0);
  });

  test('ui：常駐程式在跑時直接開瀏覽器；不在時啟動它並等心跳', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(req.headers['x-engram-token'] === 'tok' ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    fs.mkdirSync(paths.local, { recursive: true });
    fs.writeFileSync(paths.agentFile, JSON.stringify({ pid: 1, port, token: 'tok', beatAt: new Date().toISOString() }));
    const opened = [];
    const spawned = [];
    const r = await engram(['ui'], { openUrl: (u) => opened.push(u), spawnNode: (a) => spawned.push(a) });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(opened, [`http://127.0.0.1:${port}/`]);
    assert.equal(spawned.length, 0);

    fs.rmSync(paths.agentFile);
    const down = await engram(['ui'], { openUrl: (u) => opened.push(u), spawnNode: (a) => spawned.push(a), agentWaitMs: 300 });
    assert.equal(down.code, 1);
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].slice(1), ['agent']);
    assert.match(down.err, /E_AGENT_DOWN/);
    server.close();
  });

  test('常駐程式啟動失敗會寫進日誌；ui 等不到時說出原因', async () => {
    const quiet = { stdout: capture().stream, stderr: capture().stream };
    // 暫存 home 沒有記憶庫，背景啟動的常駐程式會立刻失敗（和連接埠被占用一樣，背景執行時看不到錯誤輸出）
    const r = await engram(['ui'], { openUrl: () => {}, spawnNode: () => { main(['agent', '--port', '47999'], quiet); }, agentWaitMs: 1500 });
    assert.equal(r.code, 1);
    assert.match(r.err, /常駐程式沒有在 10 秒內啟動：啟動失敗：這台電腦還沒有設定 Engram/);
    const logs = fs.readdirSync(paths.logs).filter((n) => n.startsWith('agent-'));
    assert.equal(logs.length, 1);
    assert.match(fs.readFileSync(path.join(paths.logs, logs[0]), 'utf8'), /"level":"error".*啟動失敗/);
  });
});

describe('環境健檢（2.0.0 R1、R5）', () => {
  test('env：預設是 status，列出環境指紋重點與發現；可修的附 engram env fix 指令', async () => {
    const r = await engram(['env']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /環境健檢：開啟/);
    assert.match(r.out, /Claude Code 2\.1\.329 · Engram 2\.0\.0（a1b2c3d）/);
    assert.match(r.out, /外掛 1、技能 0/);
    assert.match(r.out, /tele@mkt PostToolUse 中位數 1200 毫秒（12 次）/);
    assert.match(r.out, /來源不明 SessionStart 中位數 700 毫秒（8 次，無法確認是否同步）/);
    assert.doesNotMatch(r.out, /quiet@mkt/, '背景執行的 hook 不列');
    assert.match(r.out, /\[低\] H32 沒有設定對話紀錄的保留天數（H32:abc1234567）/);
    assert.match(r.out, /engram env fix H32:abc1234567（設成 60 天）/);
    const j = JSON.parse((await engram(['env', 'status', '--json'])).out);
    assert.deepEqual(Object.keys(j).sort(), ['envHealth', 'findings', 'fingerprint']);
    const refreshed = await engram(['env', 'status', '--refresh']);
    assert.deepEqual(refreshed.eg.calls.find((c) => c.name === 'env.fingerprint').args, [{ refresh: true }]);
  });

  test('env diff：哪裡不一樣、哪一邊比較新；env fix <id> 修正並說明備份位置', async () => {
    const d = await engram(['env', 'diff']);
    assert.match(d.out, /有環境指紋的電腦：公司電腦（這台） 2026-11-20、家裡電腦 2026-11-19/);
    assert.match(d.out, /• 「Claude Code」版本不同.*公司電腦 比較新/);
    const f = await engram(['env', 'fix', 'H32:abc1234567']);
    assert.equal(f.code, 0, f.err);
    assert.deepEqual(f.eg.calls.find((c) => c.name === 'env.fix').args, ['H32:abc1234567']);
    assert.match(f.out, /已把 cleanupPeriodDays 設成 60 天。修改前的備份：C:\\fake\\env-backup/);
  });

  test('env 的用法錯誤：沒有 id、不認得的子指令、多餘的參數 → exit 2', async () => {
    assert.equal((await engram(['env', 'fix'])).code, 2);
    assert.equal((await engram(['env', 'bogus'])).code, 2);
    assert.equal((await engram(['env', 'diff', 'x'])).code, 2);
    assert.equal((await engram(['env', 'fix', 'a', 'b'])).code, 2);
    assert.match((await engram(['env', '--help'])).out, /用法：engram env \[status \[--refresh\]\] \| diff \| fix/);
    assert.match((await engram(['help'])).out, /^ {2}env \[status \[--refresh\]\] \| diff \| fix <卡片 id> \| set <鍵>=<值> \| approve \[項目\] \| unset <鍵> \| remove-skill <名稱> \| remove-plugin <外掛> \| skip <項目> \| unskip <項目> \| export \[--skill <名稱>\]\.\.\. \[--force\] \| plan \| apply \| undo \| disable-plugin <外掛> \| enable-plugin <外掛>$/m);
  });
});

describe('環境設定同步與瘦身（2.0.0 WP8）', () => {
  const call = (r, name) => r.eg.calls.find((c) => c.name === name);
  // 使用者自己的終端機：沒有 CLAUDECODE（測試本身可能就跑在 Claude Code 裡，process.env 會帶著它）
  const terminal = (argv, o = {}) => engram(argv, { env: {}, ...o });

  test('env set <鍵>=<值>：以第一個 = 切開（值可以含 =）；沒有 = 或沒有鍵 → exit 2', async () => {
    const r = await terminal(['env', 'set', 'MY_FLAG=a=b']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(call(r, 'env.set').args, ['MY_FLAG', 'a=b', { approve: true }], '使用者自己的終端機：寫出的內容視為這台已核可');
    assert.match(r.out, /已把環境變數 MY_FLAG 寫進環境設定檔/);
    assert.doesNotMatch(r.out, /需要在終端機或管理介面核可/);
    assert.equal((await terminal(['env', 'set', 'NOEQUALS'])).code, 2);
    assert.equal((await terminal(['env', 'set', '=x'])).code, 2);
    assert.equal((await terminal(['env', 'set'])).code, 2);
  });

  test('env unset／remove-skill／remove-plugin／skip／unskip：轉給引擎、說明已套用的值不會馬上動；缺名稱或多餘參數 → exit 2', async () => {
    const u = await engram(['env', 'unset', 'MY_FLAG']);
    assert.equal(u.code, 0, u.err);
    assert.deepEqual(call(u, 'env.unset').args, ['MY_FLAG']);
    assert.match(u.out, /已從環境設定檔移除環境變數 MY_FLAG/);
    assert.match(u.out, /這台多出來/);
    const us = await engram(['env', 'unset', 'setting:theme']);
    assert.deepEqual(call(us, 'env.unset').args, ['setting:theme']);
    assert.match(us.out, /已從環境設定檔移除設定 theme/);
    const rs = await engram(['env', 'remove-skill', 'alpha-skill']);
    assert.deepEqual(call(rs, 'env.removeSkill').args, ['alpha-skill']);
    assert.match(rs.out, /已從環境設定檔移除技能 alpha-skill，並刪掉記憶庫裡的 env\/skills 副本/);
    assert.match(rs.out, /已經安裝的技能不會被動/);
    const rp = await engram(['env', 'remove-plugin', 'alpha']);
    assert.deepEqual(call(rp, 'env.removePlugin').args, ['alpha']);
    assert.match(rp.out, /已從環境設定檔的外掛清單移除 alpha@mkt/);
    const sk = await engram(['env', 'skip', 'setting:theme']);
    assert.deepEqual(call(sk, 'env.skip').args, ['setting:theme']);
    assert.match(sk.out, /這台電腦之後會略過 setting:theme/);
    const un = await engram(['env', 'unskip', 'setting:theme']);
    assert.deepEqual(call(un, 'env.unskip').args, ['setting:theme']);
    assert.match(un.out, /這台電腦不再略過 setting:theme/);
    const j = JSON.parse((await engram(['env', 'skip', 'model', '--json'])).out);
    assert.deepEqual([j.ok, j.item, j.skip], [true, 'model', true]);
    for (const sub of ['unset', 'remove-skill', 'remove-plugin', 'skip', 'unskip']) {
      assert.equal((await engram(['env', sub])).code, 2, `${sub} 沒有名稱`);
      assert.equal((await engram(['env', sub, 'a', 'b'])).code, 2, `${sub} 多餘的參數`);
    }
  });

  test('env approve [項目]：不給項目就是全部，印出每一項完整的值；沒有等待核可的 → 說明；多餘的參數 → exit 2', async () => {
    const all = await terminal(['env', 'approve']);
    assert.equal(all.code, 0, all.err);
    assert.deepEqual(call(all, 'env.approve').args, []);
    assert.match(all.out, /已核可 1 項（只記在這台電腦，不會同步）/);
    assert.match(all.out, /• 環境變數「GONE_MODE」：新增 1/);
    assert.match(all.out, /engram env apply/);
    const one = await terminal(['env', 'approve', 'env:GONE_MODE']);
    assert.deepEqual(call(one, 'env.approve').args, ['env:GONE_MODE']);
    const none = createFakeEngine({ home: paths.home });
    none.env.approve = async () => ({ ok: true, count: 0, approved: [] });
    assert.match((await terminal(['env', 'approve'], { eg: none })).out, /沒有等待核可的項目/);
    assert.equal((await terminal(['env', 'approve', 'a', 'b'])).code, 2);
  });

  test('env approve 是使用者本人的確認：在 Claude Code 裡（CLAUDECODE、CLAUDE_CODE_ENTRYPOINT，空字串也算）一律拒絕、不呼叫引擎、不寫核可紀錄', async () => {
    for (const env of [{ CLAUDECODE: '1' }, { CLAUDECODE: '' }, { CLAUDE_CODE_ENTRYPOINT: 'cli' }]) {
      for (const argv of [['env', 'approve'], ['env', 'approve', 'env:GONE_MODE']]) {
        const r = await engram(argv, { env });
        assert.equal(r.code, 1, JSON.stringify(env));
        assert.match(r.err, /E_CONFIRM/);
        assert.match(r.err, /要由你本人確認，不能在 Claude Code 裡執行/);
        assert.match(r.err, /你自己的終端機（不是 Claude Code 的對話或 ! 指令）執行 engram env approve|管理介面（engram ui）/);
        assert.equal(call(r, 'env.approve'), undefined, '沒有呼叫引擎：不寫核可紀錄');
      }
    }
    assert.equal((await terminal(['env', 'approve'])).code, 0, '使用者自己的終端機可以');
    assert.equal((await engram(['env', 'plan'], { env: { CLAUDECODE: '1' } })).code, 0, '其他子指令不受影響');
    assert.equal((await engram(['env', 'apply'], { env: { CLAUDECODE: '1' } })).code, 0, 'apply 只套用已核可的，不需要擋');
  });

  test('env set、export 在 Claude Code 裡執行：寫出的內容不自動視為已核可（approve: false），並說明需要在終端機或管理介面核可', async () => {
    for (const env of [{ CLAUDECODE: '1' }, { CLAUDE_CODE_ENTRYPOINT: 'cli' }]) {
      const s = await engram(['env', 'set', 'MY_FLAG=on'], { env });
      assert.equal(s.code, 0, s.err);
      assert.deepEqual(call(s, 'env.set').args, ['MY_FLAG', 'on', { approve: false }]);
      assert.match(s.out, /需要在終端機或管理介面核可/);
      assert.match(s.out, /engram env approve/);
      const x = await engram(['env', 'export', '--skill', 'alpha-skill'], { env });
      assert.equal(x.code, 0, x.err);
      assert.deepEqual(call(x, 'env.export').args, [{ skills: ['alpha-skill'], force: false, approve: false }]);
      assert.match(x.out, /需要在終端機或管理介面核可/);
    }
  });

  test('env plan 與 apply：等待這台核可的項目另列（完整的值），apply 回報有幾項沒套用', async () => {
    const plan = await engram(['env', 'plan']);
    assert.match(plan.out, /等待這台核可的 1 項.*不會被套用.*engram env approve/);
    assert.match(plan.out, /• 環境變數「NEW_MODE」：新增 a-very-long-value-that-is-shown-in-full（等待這台核可）/);
    assert.match(plan.out, /套用後這台電腦會改 1 項/, '等待核可的不算在「會改」裡');
    const eg = createFakeEngine({ home: paths.home });
    eg.env.apply = async () => ({ ok: true, applied: 0, pending: 2, items: [] });
    const a = await engram(['env', 'apply'], { eg });
    assert.match(a.out, /沒有需要套用的變更/);
    assert.match(a.out, /有 2 項還在等這台核可，沒有套用.*engram env approve/);
  });

  test('env plan：環境設定檔移除後留在這台的項目列在「會改」裡（restore）', async () => {
    const eg = createFakeEngine({ home: paths.home });
    eg.env.plan = async () => ({
      v: 1, at: '2026-11-21T00:00:00.000Z', envSync: 'report', profile: { present: true, updatedAt: null, by: null }, overrides: {}, settingsFormat: 'ok',
      items: [{ area: 'env', key: 'GONE_MODE', action: 'restore', from: '1', to: null, summary: '環境變數「GONE_MODE」：環境設定檔已經沒有這項，這台多出來；apply 會還原成套用之前的樣子（沒有這項）', en: { summary: 'x' } }],
      blocked: [], unused: { known: false, windowDays: 30, plugins: [] }, changes: 1,
    });
    const r = await engram(['env', 'plan'], { eg });
    assert.match(r.out, /套用後這台電腦會改 1 項/);
    assert.match(r.out, /這台多出來/);
  });

  test('env export：--skill 可以重複；列出匯出的設定、技能與被擋下的原因（不帶值）', async () => {
    const r = await terminal(['env', 'export', '--skill', 'alpha-skill', '--skill', 'leaky']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(call(r, 'env.export').args, [{ skills: ['alpha-skill', 'leaky'], force: false, approve: true }]);
    assert.match(r.out, /技能 twin 沒有覆蓋：記憶庫裡的版本不是這台上次匯出或核可的那一版.*--force/);
    assert.deepEqual(call(await terminal(['env', 'export', '--skill', 'twin', '--force']), 'env.export').args, [{ skills: ['twin'], force: true, approve: true }]);
    assert.match(r.out, /設定：theme；啟用中的外掛 1 個/);
    assert.match(r.out, /技能：alpha-skill（2 個檔案）/);
    assert.match(r.out, /技能 alpha-skill 略過：big\.bin（超過 1 MB）/);
    assert.match(r.out, /技能 leaky 沒有同步：內容疑似含有金鑰（notes\.txt：anthropic-api-key）/);
    assert.match(r.out, /設定 statusLine 沒有匯出：.*家目錄路徑/);
    assert.deepEqual(call(await terminal(['env', 'export']), 'env.export').args, [{ skills: [], force: false, approve: true }]);
  });

  test('env plan：列出會改的項目、外掛差異、被拒絕的項目、近 30 天沒用過的外掛；--json 是 plan 本身', async () => {
    const r = await engram(['env', 'plan']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /環境設定同步（設定 envSync）：只報告/);
    assert.match(r.out, /套用後這台電腦會改 1 項/);
    assert.match(r.out, /• 設定「theme」：light → dark/);
    assert.match(r.out, /• 外掛「beta@mkt」：這台沒有安裝/);
    assert.match(r.out, /不套用 env MY_API_KEY：名稱含 KEY/);
    assert.match(r.out, /近 30 天沒用過的外掛.*engram env disable-plugin <名稱>/);
    assert.match(r.out, /• idle-one@mkt/);
    assert.match(r.out, /engram env apply/);
    const j = JSON.parse((await engram(['env', 'plan', '--json'])).out);
    assert.equal(j.changes, 1);
    assert.equal(j.unused.plugins[0].key, 'idle-one@mkt');
  });

  test('env apply、undo：說明套用了什麼、備份位置、保留了哪些', async () => {
    const a = await engram(['env', 'apply']);
    assert.equal(a.code, 0, a.err);
    assert.ok(call(a, 'env.apply'));
    assert.match(a.out, /已套用 1 項：/);
    assert.match(a.out, /修改前的備份：C:\\fake\\env-backup\\apply/);
    const u = await engram(['env', 'undo']);
    assert.match(u.out, /已還原最近一次套用（1 項）/);
    assert.match(u.out, /保留 setting:model：套用之後被改過/);
    const none = createFakeEngine({ home: paths.home });
    none.env.apply = async () => ({ ok: true, applied: 0, items: [] });
    assert.match((await engram(['env', 'apply'], { eg: none })).out, /沒有需要套用的變更/);
  });

  test('env disable-plugin／enable-plugin <外掛>：轉給引擎；沒有名稱 → exit 2', async () => {
    const d = await engram(['env', 'disable-plugin', 'idle-one']);
    assert.equal(d.code, 0, d.err);
    assert.deepEqual(call(d, 'env.setPlugin').args, ['idle-one', false]);
    assert.match(d.out, /已停用外掛 idle-one@mkt/);
    const e = await engram(['env', 'enable-plugin', 'idle-one']);
    assert.deepEqual(call(e, 'env.setPlugin').args, ['idle-one', true]);
    assert.match(e.out, /已啟用外掛 idle-one@mkt/);
    assert.equal((await engram(['env', 'disable-plugin'])).code, 2);
    assert.equal((await engram(['env', 'apply', 'x'])).code, 2);
    assert.equal((await engram(['env', 'undo', 'x'])).code, 2);
  });
});
