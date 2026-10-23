// CLI：參數解析、指令分派、人看的輸出與 --json、錯誤格式與結束碼。引擎一律用假引擎。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { parseCommandArgs, parseDuration, parsePositiveInt } from '../../src/cli/args.mjs';
import { COMMANDS, main } from '../../src/cli/main.mjs';
import { capture, mkTmp, rmTmp, stdinFrom, useHomes } from './helpers.mjs';
import { createFakeEngine } from './fake-engine.mjs';

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
});

describe('分派與錯誤格式', () => {
  test('version', async () => {
    const r = await engram(['version']);
    assert.equal(r.code, 0);
    assert.match(r.out, /^engram 1\.1\.0（Node v\d+/);
    const j = await engram(['version', '--json']);
    assert.equal(JSON.parse(j.out).version, '1.1.0');
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
