// 護欄（2.0.0 WP4b）的引擎端：設定、規則清單、測試指令、停用與啟用、命中統計、開場訊息的後備提示。
// 規則的正反案例在 test/plugin/guard.test.mjs，mod 的行為在 plugin/test/guard.test.ts。
// 全部用合成資料，不會碰到真正的 ~/.engram 或 ~/.claude。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { machinePaths, makeRepo, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

let root;
let m;
let eg;
let repo;

// 規則 2（擋下）：單引號參數裡的兩個反斜線；規則 4（擋下）：雙引號裡的 powershell -Command 含 $ 變數
const BLOCKED = String.raw`node -e 'console.log("C:\\temp")'`;
const HINTED = 'rm -rf $BUILD_DIR';
const rulesFile = () => path.join(eg.paths.vault, 'guardrails', 'rules.json');
const overridesFile = () => path.join(eg.paths.local, 'guardrails-overrides.json');
const approvedFile = () => path.join(eg.paths.local, 'guardrails-approved.json');
const customRule = (over = {}) => ({ id: 'my-rule', tool: 'Bash', pattern: 'danger', flags: '', unless: '', action: 'block', message: '不要這樣寫。', source: '測試', addedAt: '2026-11-20', by: 'tester', ...over });
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
const reset = () => {
  for (const f of [rulesFile(), overridesFile(), approvedFile(), path.join(eg.paths.local, 'settings.json')]) fs.rmSync(f, { force: true });
  fs.rmSync(path.join(eg.paths.local, 'usage'), { recursive: true, force: true });
  fs.rmSync(path.join(eg.paths.local, 'cache', 'session'), { recursive: true, force: true });
};

before(async () => {
  root = mkTmp();
  m = machinePaths(root, 'home');
  await init({ ...m, machineLabel: '家裡電腦', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
  repo = makeRepo(path.join(root, 'work', 'shop'));
  await eg.identity.bind(repo, { create: { name: '商店' } });
});
after(() => rmTmp(root));

describe('設定 guardrails', () => {
  test('預設 block；可以改成 hint、off；看不懂的值被拒絕；寫進本機設定', async () => {
    reset();
    assert.equal((await eg.settings.get()).guardrails, 'block');
    assert.equal((await eg.settings.set({ guardrails: 'hint' })).guardrails, 'hint');
    assert.equal(JSON.parse(fs.readFileSync(path.join(eg.paths.local, 'settings.json'), 'utf8')).guardrails, 'hint');
    assert.equal((await eg.settings.set({ guardrails: 'off' })).guardrails, 'off');
    await assert.rejects(eg.settings.set({ guardrails: 'maybe' }), (e) => e.code === 'E_INVALID' && /guardrails/.test(e.message));
    assert.equal((await eg.settings.get()).guardrails, 'off');
    writeJson(path.join(eg.paths.local, 'settings.json'), { guardrails: 'nonsense' });
    assert.equal((await eg.settings.get()).guardrails, 'block', '設定檔裡看不懂的值用預設');
    assert.equal((await eg.settings.set({ autopilotBudget: 50 })).guardrails, 'block', '改別的設定不會動到它');
  });
});

describe('規則清單', () => {
  test('沒有規則檔 → 內建的 6 條預設規則，並標示目前實際的動作', async () => {
    reset();
    const l = await eg.guardrails.list();
    assert.equal(l.source, 'default');
    assert.equal(l.mode, 'block');
    assert.equal(l.rules.length, 6);
    assert.deepEqual(l.rules.filter((r) => r.effective === 'block').map((r) => r.id), ['inline-script-double-backslash', 'powershell-command-shell-variable']);
    assert.ok(l.rules.every((r) => r.override === null && r.by === 'engram' && r.source));
    assert.ok(l.rules.every((r) => r.approval === 'builtin'), '內建規則不需要核可');
    assert.deepEqual(l.rules.filter((r) => r.silentFailure).map((r) => r.id), ['inline-script-double-backslash', 'inline-script-cjk']);
    assert.deepEqual(l.skipped, []);
  });

  test('設定 hint 時所有規則實際上都只提醒；off 時全部是 off', async () => {
    reset();
    await eg.settings.set({ guardrails: 'hint' });
    assert.ok((await eg.guardrails.list()).rules.every((r) => r.effective === 'hint'));
    await eg.settings.set({ guardrails: 'off' });
    assert.ok((await eg.guardrails.list()).rules.every((r) => r.effective === 'off'));
    reset();
  });

  test('vault/guardrails/rules.json 存在就只用它；壞掉的規則被略過並說明原因', async () => {
    reset();
    const good = customRule();
    writeJson(rulesFile(), { v: 1, rules: [good, { ...good, id: 'bad-regex', pattern: '(' }, { ...good, id: 'unfinished', pattern: 'x(?<a' }, { ...good, id: 'slow', pattern: '(a+)+$' }] });
    const l = await eg.guardrails.list();
    assert.equal(l.source, 'file');
    assert.deepEqual(l.rules.map((r) => r.id), ['my-rule']);
    assert.deepEqual(l.skipped.map((s) => s.id), ['bad-regex', 'unfinished', 'slow']);
    assert.match(l.skipped[0].reason, /編譯失敗/);
    assert.match(l.skipped[1].reason, /編譯失敗/);
    assert.match(l.skipped[2].reason, /卡住/);
    // 規則檔來的 block 規則沒核可：目前只當提醒
    assert.equal(l.rules[0].approval, 'pending');
    assert.equal(l.rules[0].effective, 'hint');
    assert.equal(l.rules[0].action, 'block');

    writeJson(rulesFile(), '{oops');
    const broken = await eg.guardrails.list();
    assert.equal(broken.source, 'default');
    assert.match(broken.problem, /預設規則/);
    assert.equal(broken.rules.length, 6);
    reset();
  });

  test('規則檔不是記憶：不出現在記憶清單、搜尋與健康檢查', async () => {
    reset();
    const before = JSON.stringify({ memories: (await eg.memories.list()).map((x) => x.ref), findings: (await eg.health()).map((f) => f.id) });
    writeJson(rulesFile(), { v: 1, rules: [{ id: 'findme-rule', tool: 'Bash', pattern: 'findme', action: 'hint', message: 'findme 獨一無二的規則說明。' }] });
    const after = JSON.stringify({ memories: (await eg.memories.list()).map((x) => x.ref), findings: (await eg.health()).map((f) => f.id) });
    assert.equal(after, before);
    assert.deepEqual(await eg.search('findme 獨一無二'), []);
    reset();
  });
});

describe('測試一個指令', () => {
  test('block、hint、pass 三種結果；擋下時附上給模型的說明', async () => {
    reset();
    const blocked = await eg.guardrails.test(BLOCKED);
    assert.equal(blocked.verdict, 'block');
    assert.deepEqual(blocked.matches.map((x) => x.id), ['inline-script-double-backslash']);
    assert.match(blocked.deny, /寫檔工具/);
    const hinted = await eg.guardrails.test(HINTED);
    assert.equal(hinted.verdict, 'hint');
    assert.equal(hinted.hints.length, 1);
    assert.equal(hinted.deny, undefined);
    const pass = await eg.guardrails.test('git status');
    assert.equal(pass.verdict, 'pass');
    assert.deepEqual(pass.matches, []);
  });

  test('預設只測 Bash；PowerShell 工具不套用只針對 Bash 的規則；工具名稱不對會被拒絕', async () => {
    reset();
    assert.equal((await eg.guardrails.test(BLOCKED, { tool: 'PowerShell' })).verdict, 'pass');
    await assert.rejects(eg.guardrails.test(BLOCKED, { tool: 'Read' }), (e) => e.code === 'E_INVALID');
    await assert.rejects(eg.guardrails.test('   '), (e) => e.code === 'E_INVALID');
  });

  test('設定與本機覆寫都會反映在結果裡', async () => {
    reset();
    await eg.settings.set({ guardrails: 'hint' });
    assert.equal((await eg.guardrails.test(BLOCKED)).verdict, 'hint');
    await eg.settings.set({ guardrails: 'off' });
    assert.equal((await eg.guardrails.test(BLOCKED)).verdict, 'pass');
    reset();
  });
});

describe('停用與啟用', () => {
  test('disable 只寫本機覆寫，規則檔不動；停用後測試與清單都反映；enable 恢復', async () => {
    reset();
    const r = await eg.guardrails.disable('inline-script-double-backslash');
    assert.deepEqual(r, { ok: true, id: 'inline-script-double-backslash', changed: true });
    assert.equal(fs.existsSync(rulesFile()), false, '沒有動到會同步的規則檔');
    const saved = JSON.parse(fs.readFileSync(overridesFile(), 'utf8'));
    assert.equal(saved.v, 1);
    assert.equal(saved.rules['inline-script-double-backslash'].action, 'off');
    assert.equal(saved.rules['inline-script-double-backslash'].reason, 'manual');

    assert.equal((await eg.guardrails.test(BLOCKED)).verdict, 'pass');
    const row = (await eg.guardrails.list()).rules.find((x) => x.id === 'inline-script-double-backslash');
    assert.equal(row.effective, 'off');
    assert.equal(row.action, 'block', '規則本來的動作不變');
    assert.equal((await eg.guardrails.disable('inline-script-double-backslash')).changed, false, '重複停用不算變更');

    assert.deepEqual(await eg.guardrails.enable('inline-script-double-backslash'), { ok: true, id: 'inline-script-double-backslash', changed: true });
    assert.equal((await eg.guardrails.test(BLOCKED)).verdict, 'block');
    assert.deepEqual(await eg.guardrails.enable('inline-script-double-backslash'), { ok: true, id: 'inline-script-double-backslash', changed: false });
  });

  test('enable 也會恢復被誤擋降成提醒的規則（mod 寫的覆寫）', async () => {
    reset();
    const until = new Date(Date.now() + 10 * 86_400_000).toISOString();
    writeJson(overridesFile(), { v: 1, rules: { 'inline-script-double-backslash': { action: 'hint', at: '2026-11-20T01:00:00.000Z', reason: 'falseBlock', until } } });
    assert.equal((await eg.guardrails.test(BLOCKED)).verdict, 'hint');
    const o = (await eg.guardrails.list()).rules.find((x) => x.id === 'inline-script-double-backslash').override;
    assert.equal(o.reason, 'falseBlock');
    assert.equal(o.until, until);
    await eg.guardrails.enable('inline-script-double-backslash');
    assert.equal((await eg.guardrails.test(BLOCKED)).verdict, 'block');
    assert.equal(fs.existsSync(overridesFile()), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(overridesFile(), 'utf8')).rules, {});
  });

  test('M2：降級到期後自動恢復：清單與測試都不再算那筆覆寫；比對太慢被停用的規則清單標示原因', async () => {
    reset();
    writeJson(overridesFile(), { v: 1, rules: { 'inline-script-double-backslash': { action: 'hint', at: '2026-11-01T01:00:00.000Z', reason: 'falseBlock', until: '2026-11-15T01:00:00.000Z' }, 'rm-shell-variable': { action: 'off', at: '2026-11-20T01:00:00.000Z', reason: 'slow' } } });
    assert.equal((await eg.guardrails.test(BLOCKED)).verdict, 'block', '到期了，恢復成擋下');
    const rules = (await eg.guardrails.list()).rules;
    const expired = rules.find((x) => x.id === 'inline-script-double-backslash');
    assert.equal(expired.effective, 'block');
    assert.equal(expired.override, null, '到期的覆寫不顯示');
    const slow = rules.find((x) => x.id === 'rm-shell-variable');
    assert.equal(slow.effective, 'off');
    assert.equal(slow.override.reason, 'slow');
    assert.equal((await eg.guardrails.test(HINTED)).verdict, 'pass');
    await eg.guardrails.enable('rm-shell-variable');
    assert.equal((await eg.guardrails.test(HINTED)).verdict, 'hint');
    reset();
  });

  test('不存在的規則 → E_NOT_FOUND；覆寫檔裡殘留、規則已經不在的 id 仍然可以 enable 清掉', async () => {
    reset();
    await assert.rejects(eg.guardrails.disable('nope'), (e) => e.code === 'E_NOT_FOUND');
    await assert.rejects(eg.guardrails.enable('nope'), (e) => e.code === 'E_NOT_FOUND');
    writeJson(overridesFile(), { v: 1, rules: { 'old-rule': { action: 'off' } } });
    assert.equal((await eg.guardrails.enable('old-rule')).changed, true);
    reset();
  });
});

describe('M1：核可同步來的擋下規則', () => {
  const readApproved = () => JSON.parse(fs.readFileSync(approvedFile(), 'utf8'));

  test('沒核可只當提醒；approve 記下內容雜湊之後才真的擋下；規則內容改過要重新核可', async () => {
    reset();
    writeJson(rulesFile(), { v: 1, rules: [customRule()] });
    assert.equal((await eg.guardrails.test('run danger')).verdict, 'hint');
    assert.equal((await eg.guardrails.list()).rules[0].approval, 'pending');

    const r = await eg.guardrails.approve('my-rule');
    assert.deepEqual([r.ok, r.changed, r.approval], [true, true, 'approved']);
    assert.equal(r.rule.pattern, 'danger');
    assert.equal(r.rule.message, '不要這樣寫。');
    const saved = readApproved();
    assert.equal(saved.v, 1);
    assert.match(saved.rules['my-rule'].hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(saved).includes('danger'), '只記雜湊，不記規則內容');
    assert.equal((await eg.guardrails.test('run danger')).verdict, 'block');
    const listed = (await eg.guardrails.list()).rules[0];
    assert.deepEqual([listed.approval, listed.effective], ['approved', 'block']);
    assert.equal((await eg.guardrails.approve('my-rule')).changed, false, '已經核可過不再寫入');

    // 同步來的新版本改了訊息：雜湊不同，核可失效
    writeJson(rulesFile(), { v: 1, rules: [customRule({ message: '改過的訊息。' })] });
    assert.equal((await eg.guardrails.test('run danger')).verdict, 'hint');
    assert.equal((await eg.guardrails.list()).rules[0].approval, 'pending');
    assert.equal((await eg.guardrails.approve('my-rule')).changed, true);
    assert.equal((await eg.guardrails.test('run danger')).verdict, 'block');
    reset();
  });

  test('規則裡的 by 欄位不能拿來當核可；內建規則與提醒類的規則不需要核可', async () => {
    reset();
    writeJson(rulesFile(), { v: 1, rules: [customRule({ by: 'engram' }), customRule({ id: 'just-a-hint', action: 'hint', pattern: 'hintme' })] });
    assert.equal((await eg.guardrails.test('run danger')).verdict, 'hint');
    const [a, b] = (await eg.guardrails.list()).rules;
    assert.deepEqual([a.approval, b.approval], ['pending', 'not-needed']);
    assert.deepEqual((await eg.guardrails.approve('just-a-hint')).approval, 'not-needed');
    assert.equal(fs.existsSync(approvedFile()), false, '不需要核可的不寫核可紀錄');
    reset();
    const builtin = await eg.guardrails.approve('inline-script-double-backslash');
    assert.deepEqual([builtin.changed, builtin.approval], [false, 'builtin']);
    assert.equal(fs.existsSync(approvedFile()), false);
  });

  test('把預設規則整份複製進規則檔：內容相同，仍然視為內建，擋下不需要核可', async () => {
    reset();
    const defaults = (await eg.guardrails.list()).rules;
    writeJson(rulesFile(), { v: 1, rules: defaults });
    const l = await eg.guardrails.list();
    assert.equal(l.source, 'file');
    assert.deepEqual(l.skipped, []);
    assert.ok(l.rules.every((r) => r.approval === 'builtin'));
    assert.equal((await eg.guardrails.test(BLOCKED)).verdict, 'block');
    reset();
  });

  test('不存在的規則 → E_NOT_FOUND', async () => {
    reset();
    await assert.rejects(eg.guardrails.approve('nope'), (e) => e.code === 'E_NOT_FOUND');
  });

  test('核可紀錄只在這台電腦（local），不是記憶，不影響記憶清單', async () => {
    reset();
    writeJson(rulesFile(), { v: 1, rules: [customRule()] });
    const before = (await eg.memories.list()).length;
    await eg.guardrails.approve('my-rule');
    assert.equal((await eg.memories.list()).length, before);
    assert.ok(approvedFile().startsWith(eg.paths.local));
    reset();
  });
});

describe('defaults: true 的規則檔（內建規則排在前面，檔案的規則加在後面）', () => {
  const writeDefaultsFile = (rules) => writeJson(rulesFile(), { v: 1, defaults: true, rules });

  test('list：內建 6 條（不需要核可）在前、檔案的規則在後（沒核可的擋下類只提醒）；defaults 標示出來', async () => {
    reset();
    writeDefaultsFile([customRule(), customRule({ id: 'a-hint', action: 'hint', pattern: 'hintme' })]);
    const l = await eg.guardrails.list();
    assert.equal(l.source, 'file');
    assert.equal(l.defaults, true);
    assert.deepEqual(l.rules.map((r) => r.id).slice(-2), ['my-rule', 'a-hint']);
    assert.equal(l.rules.length, 8);
    assert.ok(l.rules.slice(0, 6).every((r) => r.approval === 'builtin' && r.by === 'engram'));
    assert.deepEqual(l.rules.slice(6).map((r) => [r.approval, r.effective]), [['pending', 'hint'], ['not-needed', 'hint']]);
    assert.deepEqual(l.skipped, []);
    reset();
  });

  test('test：內建的擋下照擋、不需要核可；檔案的擋下類核可之後才擋；改過內容要重新核可', async () => {
    reset();
    writeDefaultsFile([customRule()]);
    assert.equal((await eg.guardrails.test(BLOCKED)).verdict, 'block', '內建規則 2');
    assert.equal((await eg.guardrails.test('run danger')).verdict, 'hint');
    assert.deepEqual((await eg.guardrails.approve('inline-script-double-backslash')).approval, 'builtin');
    assert.equal(fs.existsSync(approvedFile()), false, '內建的不寫核可紀錄');
    const ok = await eg.guardrails.approve('my-rule');
    assert.deepEqual([ok.changed, ok.approval], [true, 'approved']);
    assert.equal((await eg.guardrails.test('run danger')).verdict, 'block');
    assert.equal((await eg.guardrails.test(BLOCKED)).verdict, 'block');
    writeDefaultsFile([customRule({ message: '改過的訊息。' })]);
    assert.equal((await eg.guardrails.test('run danger')).verdict, 'hint');
    assert.equal((await eg.guardrails.list()).rules.find((r) => r.id === 'my-rule').approval, 'pending');
    reset();
  });

  test('檔案的規則照樣逐條驗證（慢的、沒寫完的、太寬的、同 id 的略過並說明原因），內建的不受影響', async () => {
    reset();
    writeDefaultsFile([customRule(), customRule({ id: 'slow', pattern: '.*a.*b.*c' }), customRule({ id: 'unfinished', pattern: 'x(?<a' }), customRule({ id: 'rm-shell-variable', pattern: 'rm' })]);
    const l = await eg.guardrails.list();
    assert.equal(l.rules.length, 7);
    assert.deepEqual(l.skipped.map((s) => s.id), ['slow', 'unfinished', 'rm-shell-variable']);
    assert.match(l.skipped[0].reason, /大範圍字元/);
    assert.equal(l.skipped[2].reason, 'id 重複');
    assert.equal((await eg.guardrails.test(HINTED)).verdict, 'hint', '內建的 rm 規則沒被取代');
    reset();
  });

  test('覆寫、停用、啟用、設定對兩邊都有效；status 的統計照樣算', async () => {
    reset();
    writeDefaultsFile([customRule()]);
    await eg.guardrails.approve('my-rule');
    await eg.guardrails.disable('inline-script-double-backslash');
    await eg.guardrails.disable('my-rule');
    assert.equal((await eg.guardrails.test(BLOCKED)).verdict, 'pass');
    assert.equal((await eg.guardrails.test('run danger')).verdict, 'pass');
    const rows = (await eg.guardrails.status()).rules;
    assert.deepEqual([rows[1].effective, rows.at(-1).effective], ['off', 'off']);
    await eg.guardrails.enable('inline-script-double-backslash');
    await eg.guardrails.enable('my-rule');
    assert.equal((await eg.guardrails.test('run danger')).verdict, 'block');
    await eg.settings.set({ guardrails: 'hint' });
    assert.equal((await eg.guardrails.test('run danger')).verdict, 'hint');
    assert.ok((await eg.guardrails.list()).rules.every((r) => r.effective === 'hint'));
    reset();
  });

  test('開場訊息的後備提示：內建的在前，最多 6 條', async () => {
    reset();
    writeDefaultsFile([customRule({ message: '檔案的規則。後面是細節。' })]);
    const text = (await eg.sessionContext({ cwd: repo, sessionId: 'sess-defaults' })).text;
    assert.equal(text.split('\n').filter((l) => /^ {2}- /.test(l)).length, 6);
    assert.doesNotMatch(text, /檔案的規則/, '前 6 條都是內建的');
    reset();
  });
});

describe('命中統計', () => {
  const NOW = Date.parse('2026-11-20T12:00:00.000Z');
  const row = (rule, kind) => JSON.stringify({ at: '2026-11-20T01:00:00.000Z', session: 's1', rule, kind });
  const usageDay = (date, rows) => writeJson(path.join(eg.paths.local, 'usage', 'guardrails', `${date}.jsonl`), `${rows.join('\n')}\n`);

  test('近 30 天（含今天）的命中數、擋下數與誤擋數，依規則彙整；更早的不算', async () => {
    reset();
    usageDay('2026-11-20', [row('inline-script-double-backslash', 'block'), row('inline-script-double-backslash', 'block'), row('inline-script-double-backslash', 'falseBlock'), row('inline-script-double-backslash', 'confirmed'), row('inline-script-double-backslash', 'confirmed'), row('rm-shell-variable', 'hint')]);
    usageDay('2026-11-19', [row('msys-path-conversion', 'slow')]);
    usageDay('2026-10-22', [row('rm-shell-variable', 'hint')]);
    usageDay('2026-10-21', [row('rm-shell-variable', 'hint'), row('rm-shell-variable', 'hint'), row('rm-shell-variable', 'confirmed')]);
    const s = await eg.guardrails.status({ now: NOW });
    assert.equal(s.days, 30);
    const by = Object.fromEntries(s.rules.map((r) => [r.id, r]));
    assert.deepEqual([by['inline-script-double-backslash'].hits, by['inline-script-double-backslash'].blocks, by['inline-script-double-backslash'].falseBlocks, by['inline-script-double-backslash'].confirmed], [2, 2, 1, 2], 'confirmed 是獨立的計數，不算命中、也不算誤擋');
    assert.deepEqual([by['rm-shell-variable'].hits, by['rm-shell-variable'].hints, by['rm-shell-variable'].confirmed], [2, 2, 0]);
    assert.deepEqual(s.totals, { hits: 4, blocks: 2, falseBlocks: 1, confirmed: 2, slow: 1 });
    assert.deepEqual([by['msys-path-conversion'].hits, by['msys-path-conversion'].slow], [0, 1], 'slow 也是獨立的計數');
    const raw = await eg.guardrails.usage({ now: NOW });
    assert.deepEqual(raw['inline-script-double-backslash'], { hits: 2, blocks: 2, hints: 0, falseBlocks: 1, confirmed: 2, slow: 0 });
  });

  test('沒有任何紀錄、檔案壞掉或有壞行時不會出錯', async () => {
    reset();
    const none = await eg.guardrails.status({ now: NOW });
    assert.deepEqual(none.totals, { hits: 0, blocks: 0, falseBlocks: 0, confirmed: 0, slow: 0 });
    usageDay('2026-11-20', ['not json', row('rm-shell-variable', 'hint'), JSON.stringify({ kind: 'hint' }), '']);
    fs.writeFileSync(path.join(eg.paths.local, 'usage', 'guardrails', 'notes.txt'), 'x');
    const s = await eg.guardrails.status({ now: NOW });
    assert.equal(s.totals.hits, 1);
    reset();
  });
});

describe('開場訊息的後備提示（mod 沒有載入時）', () => {
  const marker = (id) => path.join(eg.paths.local, 'cache', 'session', `${id}.mod`);

  test('沒有標記檔 → 加一段「已知的指令寫法問題」，最多 6 條、每條一句，整段仍在開場訊息的上限內', async () => {
    reset();
    const ctx = await eg.sessionContext({ cwd: repo, sessionId: 'sess-1' });
    assert.match(ctx.text, /這台電腦已知的指令寫法問題/);
    const lines = ctx.text.split('\n').filter((l) => /^ {2}- /.test(l));
    assert.equal(lines.length, 6);
    for (const l of lines) assert.equal((l.match(/。/g) ?? []).length, 1);
    assert.ok(ctx.text.split('\n').length <= 12 && ctx.text.length <= 1200, `${ctx.text.split('\n').length} 行、${ctx.text.length} 字`);
  });

  test('這場對話的標記檔存在（mod 已載入）→ 不加；別場對話的標記檔不算', async () => {
    reset();
    writeJson(marker('sess-2'), 'guard\n');
    assert.doesNotMatch((await eg.sessionContext({ cwd: repo, sessionId: 'sess-2' })).text, /已知的指令寫法問題/);
    assert.match((await eg.sessionContext({ cwd: repo, sessionId: 'sess-3' })).text, /已知的指令寫法問題/);
    assert.match((await eg.sessionContext({ cwd: repo })).text, /已知的指令寫法問題/, '沒有 session id 也不會出錯');
  });

  test('設定為 off 不加；停用的規則不列；規則檔的規則會列出', async () => {
    reset();
    await eg.settings.set({ guardrails: 'off' });
    assert.doesNotMatch((await eg.sessionContext({ cwd: repo, sessionId: 'sess-4' })).text, /已知的指令寫法問題/);
    await eg.settings.set({ guardrails: 'block' });
    await eg.guardrails.disable('rm-shell-variable');
    const text = (await eg.sessionContext({ cwd: repo, sessionId: 'sess-4' })).text;
    assert.equal(text.split('\n').filter((l) => /^ {2}- /.test(l)).length, 5);
    assert.doesNotMatch(text, /rm／rmdir/);
    reset();
    writeJson(rulesFile(), { v: 1, rules: [{ id: 'only-one', tool: 'Bash', pattern: 'onlyone', action: 'hint', message: '只有這一條規則。後面是細節。' }] });
    const custom = (await eg.sessionContext({ cwd: repo, sessionId: 'sess-5' })).text;
    assert.match(custom, /只有這一條規則。/);
    assert.doesNotMatch(custom, /後面是細節/);
    reset();
  });

  test('規則檔是空的清單 → 沒有東西可列，就不加', async () => {
    reset();
    writeJson(rulesFile(), { v: 1, rules: [] });
    assert.doesNotMatch((await eg.sessionContext({ cwd: repo, sessionId: 'sess-6' })).text, /已知的指令寫法問題/);
    reset();
  });

  test('優先序最低：其他警告已經佔滿時先被省略，不會擠掉它們', async () => {
    reset();
    const statePath = path.join(eg.paths.local, 'state.json');
    const before = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null;
    // 三個比後備提示重要的警告：登入失效、GitHub 擋下推送、有記憶疑似含金鑰
    writeJson(statePath, { sync: { state: 'auth', error: { code: 'E_PUSH_PROTECTED' }, blockedBySecrets: ['a', 'b'] } });
    try {
      const ctx = await eg.sessionContext({ cwd: repo, sessionId: 'sess-7' });
      assert.match(ctx.text, /GitHub 登入已失效/);
      assert.match(ctx.text, /GitHub 擋下了推送/);
      assert.match(ctx.text, /疑似含有金鑰/);
      assert.doesNotMatch(ctx.text, /已知的指令寫法問題/);
      assert.ok(ctx.text.split('\n').length <= 12 && ctx.text.length <= 1200);
    } finally {
      if (before === null) fs.rmSync(statePath, { force: true }); else fs.writeFileSync(statePath, before);
    }
  });
});
