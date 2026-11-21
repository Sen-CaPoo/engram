// 管理介面 2.0.0（保留區、環境、護欄、每週摘要、設定）：
// - api.js 的每個方法，展示版（demo.js）都有實作（展示版是截圖與審查用的介面，少一個方法頁面就會壞）
// - 介面用的純函式：沒有推送的檔案分類、最近一輪為什麼停止
// - 展示版的主要操作：保留區採用（成功、記憶被改過）與不需要、環境設定核可／套用／還原、外掛停用、護欄試試看與核可、每週摘要的形狀
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { api as httpApi } from '../../src/ui/src/api.js';
import { demoApi } from '../../src/ui/src/demo.js';
import { heldFileKind, latestStop } from '../../src/ui/src/util.js';
import { compileRules } from '../../plugin/hooks/lens/guard.mjs';

describe('api.js 與展示版', () => {
  test('api.js 的每個方法在展示版都有實作', () => {
    const missing = Object.keys(httpApi).filter((k) => typeof httpApi[k] === 'function' && typeof demoApi[k] !== 'function');
    assert.deepEqual(missing, []);
  });
});

describe('介面用的純函式', () => {
  test('沒有推送的檔案：記憶與核心準則、環境設定、保留區、護欄規則、其他', () => {
    assert.equal(heldFileKind('global/a.md'), 'memory');
    assert.equal(heldFileKind('projects/p1/memory/b.md'), 'memory');
    assert.equal(heldFileKind('machines/m1/c.md'), 'memory');
    assert.equal(heldFileKind('core/CORE.md'), 'memory');
    assert.equal(heldFileKind('env/profile.json'), 'env');
    assert.equal(heldFileKind('env/skills/notes/SKILL.md'), 'env', 'env/ 底下的 .md 是技能檔，不是記憶');
    assert.equal(heldFileKind('machines/m1/env-overrides.json'), 'env');
    assert.equal(heldFileKind('machines/m1/env.json'), 'env');
    assert.equal(heldFileKind('holding/hd-20261120-101500-ab2c.json'), 'holding');
    assert.equal(heldFileKind('guardrails/rules.json'), 'guardrails');
    assert.equal(heldFileKind('machines/m1/autopilot.json'), 'other');
    assert.equal(heldFileKind('settings.json'), 'other');
  });

  test('最近一輪為什麼停止：略過執行中的一輪，只認 limit、auth、budget、busy', () => {
    assert.equal(latestStop([]), null);
    assert.equal(latestStop([{ status: 'done', summary: { stopped: null } }]), null);
    assert.equal(latestStop([{ status: 'running', summary: null }, { status: 'done', summary: { stopped: 'auth' } }]).reason, 'auth');
    assert.equal(latestStop([{ status: 'done', summary: { stopped: 'limit' } }, { status: 'done', summary: { stopped: 'auth' } }]).reason, 'limit', '只看最近一輪');
    assert.equal(latestStop([{ status: 'done', summary: { stopped: 'busy' } }]).reason, 'busy');
    assert.equal(latestStop([{ status: 'done', summary: { stopped: 'cancelled' } }]), null);
  });
});

describe('展示版：保留區', () => {
  test('列出保留中的項目，欄位和後端一致', async () => {
    const held = await demoApi.holding({ status: 'held' });
    assert.ok(held.length >= 3);
    for (const x of held) {
      assert.match(x.id, /^hd-\d{8}-\d{6}-[a-z0-9]{4}$/);
      assert.ok(['rejected', 'cross-scope', 'reverted'].includes(x.kind));
      assert.ok(x.ops.length > 0);
      assert.equal(typeof x.local, 'boolean');
    }
    assert.ok(held.some((x) => x.grounded === true && x.keep.length > 0), '有一項核心事實有依據');
  });

  test('採用：寫進記憶、狀態變成已採用、有整理記錄可以復原', async () => {
    const [x] = (await demoApi.holding({ status: 'held' })).filter((h) => h.ops[0].op === 'write');
    const r = await demoApi.holdingAdopt(x.id);
    assert.equal(r.ok, true);
    assert.ok(r.record);
    assert.ok((await demoApi.tidyRecord(r.record)).items.length === 1);
    const after = (await demoApi.holding()).find((h) => h.id === x.id);
    assert.equal(after.status, 'adopted');
    const mem = await demoApi.memory(x.ops[0].ref);
    assert.ok(x.ops[0].content.endsWith(mem.body), '寫進的是保留區裡的內容');
  });

  test('採用失敗（記憶後來被改過）：E_CONFLICT 附中英文原因，項目留在保留區', async () => {
    const x = (await demoApi.holding({ status: 'held' })).find((h) => h.action === 'merge');
    await assert.rejects(demoApi.holdingAdopt(x.id), (e) => e.code === 'E_CONFLICT' && /保留區/.test(e.message) && /holding area/.test(e.en.message) && !!e.hint);
    assert.equal((await demoApi.holding()).find((h) => h.id === x.id).status, 'held');
  });

  test('不需要：狀態變成不需要，不能再採用', async () => {
    const x = (await demoApi.holding({ status: 'held' })).find((h) => h.action !== 'merge');
    await demoApi.holdingDismiss(x.id);
    assert.equal((await demoApi.holding()).find((h) => h.id === x.id).status, 'dismissed');
    await assert.rejects(demoApi.holdingAdopt(x.id));
  });

  test('記憶畢業的提案：內容是護欄規則或環境設定，採用時交給記憶畢業（沒有整理記錄）', async () => {
    const grads = (await demoApi.holding({ status: 'held' })).filter((h) => h.task === 'graduate');
    assert.deepEqual(grads.map((h) => h.graduate.to).sort(), ['env', 'guardrail']);
    for (const h of grads) {
      assert.equal(h.action, 'graduate');
      assert.equal(h.category, h.graduate.to, '類別和 autopilot/guard.mjs 的 categoryOf 一致');
      assert.equal(h.ops[0].op, h.graduate.to);
      assert.deepEqual(JSON.parse(h.ops[0].content), h.graduate.to === 'env' ? h.graduate.env : h.graduate.rule);
      assert.deepEqual([h.ops[1].op, h.ops[1].ref, h.ops[1].to], ['graduate', h.graduate.ref, h.graduate.to]);
      assert.match(h.ops[1].content, new RegExp(`graduated:\\n\\s+to: ${h.graduate.to}`), '原記憶只記下去向');
    }
    const rule = grads.find((h) => h.graduate.to === 'guardrail').graduate.rule;
    assert.equal(rule.action, 'hint', '記憶畢業的規則一律只提醒');
    assert.deepEqual(compileRules([rule]).skipped, [], '規則通過和外掛載入規則檔時相同的驗證');
    const r = await demoApi.holdingAdopt(grads[0].id);
    assert.deepEqual([r.ok, r.record, r.graduate.to, r.undo], [true, null, grads[0].graduate.to, []]);
    assert.equal((await demoApi.holding()).find((h) => h.id === grads[0].id).status, 'adopted');
  });
});

describe('展示版：環境', () => {
  test('這台的發現：可以修的卡片修完就消失，只是提醒的不能修', async () => {
    const env = await demoApi.env();
    const fixable = env.findings.find((f) => f.fix);
    const remind = env.findings.find((f) => !f.fix);
    assert.equal(fixable.fix.action, 'env-fix');
    await demoApi.envFix(fixable.id);
    assert.ok(!(await demoApi.env()).findings.some((f) => f.id === fixable.id));
    await assert.rejects(demoApi.envFix(remind.id));
  });

  test('兩台差異：每一項都有每台的值', async () => {
    const d = await demoApi.envDiff();
    assert.equal(d.compared, 2);
    for (const it of d.items) assert.deepEqual(Object.keys(it.values).sort(), d.machines.map((m) => m.mid).sort());
  });

  test('設定同步：核可之後才會套用；套用後沒有要改的，還原後回來', async () => {
    const p0 = await demoApi.envPlan();
    assert.ok(p0.pending > 0);
    assert.ok(p0.blocked.some((b) => b.key === 'statusLine'), 'statusLine 列在不會同步的項目');
    const w = p0.items.find((i) => i.approved === false);
    await assert.rejects(demoApi.envApprove(`${w.area}:${w.key}`, 'not-the-hash'), (e) => e.code === 'E_CONFLICT');
    await demoApi.envApprove(`${w.area}:${w.key}`, w.hash);
    const p1 = await demoApi.envPlan();
    assert.equal(p1.pending, p0.pending - 1);
    assert.equal(p1.changes, p0.changes + 1);
    const a = await demoApi.envApply();
    assert.equal(a.applied, p1.changes);
    assert.equal((await demoApi.envPlan()).changes, 0);
    await demoApi.envUndo();
    assert.equal((await demoApi.envPlan()).changes, p1.changes);
  });

  test('近 30 天沒用過的外掛：停用後不再列出、可以再啟用', async () => {
    const p = await demoApi.envPlan();
    const key = p.unused.plugins[0].key;
    assert.ok(Array.isArray(p.disabledPlugins) && p.disabledPlugins.length > 0, '原本就停用的外掛列在 disabledPlugins');
    assert.ok(!p.disabledPlugins.includes(key));
    const r = await demoApi.envPlugin(key, false);
    assert.deepEqual([r.changed, r.enabled], [true, false]);
    const p1 = await demoApi.envPlan();
    assert.ok(!p1.unused.plugins.some((x) => x.key === key));
    assert.ok(p1.disabledPlugins.includes(key), '停用之後馬上列在 disabledPlugins（重新整理後仍能再啟用）');
    assert.equal((await demoApi.envPlugin(key, false)).changed, false, '已經停用了');
    assert.equal((await demoApi.env()).fingerprint.settings.enabledPlugins[key], true, '和真的一樣：環境指紋是每天的快取，不會馬上變');
    assert.equal((await demoApi.envPlugin(key, true)).enabled, true);
    assert.ok(!(await demoApi.envPlan()).disabledPlugins.includes(key));
  });

  test('共用設定檔：這台略過與從設定檔移除', async () => {
    const before = await demoApi.envProfile();
    const key = Object.keys(before.profile.env)[0];
    await demoApi.envProfileAction('skip', `env:${key}`);
    assert.ok((await demoApi.envProfile()).overrides.skip.includes(`env:${key}`));
    await demoApi.envProfileAction('unskip', `env:${key}`);
    assert.ok(!(await demoApi.envProfile()).overrides.skip.includes(`env:${key}`));
    await demoApi.envProfileAction('unset', key);
    assert.ok(!(key in (await demoApi.envProfile()).profile.env));
  });
});

describe('展示版：護欄', () => {
  test('規則有核可狀態與覆寫；試試看用和外掛相同的比對', async () => {
    const g = await demoApi.guardrails();
    assert.ok(g.rules.every((r) => ['builtin', 'approved', 'pending', 'not-needed'].includes(r.approval)));
    const pending = g.rules.find((r) => r.approval === 'pending');
    assert.ok(pending, '有一條同步來、等待核可的規則');
    assert.ok(g.rules.every((r) => typeof r.messageEn === 'string' && r.messageEn), '規則的英文訊息是 messageEn（和後端相同，不是 en.message）');
    const hit = (await demoApi.guardrailsTest('git push --force origin main')).matches[0];
    assert.deepEqual(Object.keys(hit).sort(), ['action', 'declared', 'id', 'message'], '試試看的命中和後端一樣只有中文的 message');
    assert.ok(g.rules.some((r) => r.override?.until), '誤擋後降級的覆寫有期限');
    assert.equal((await demoApi.guardrailsTest('git status')).verdict, 'pass');
    assert.equal((await demoApi.guardrailsTest('git push --force origin main')).verdict, 'hint', '核可之前只提醒');
    const r = await demoApi.guardrailsApprove(pending.id);
    assert.deepEqual([r.changed, r.approval], [true, 'approved']);
    assert.equal((await demoApi.guardrailsTest('git push --force origin main')).verdict, 'block', '核可之後擋下');
    assert.equal((await demoApi.guardrailsTest('git push --force-with-lease origin main')).verdict, 'pass', '例外不擋');
  });

  test('規則檔寫了 defaults: true（內建規則照樣生效），沒有生效的規則是 { id, reason } 的清單', async () => {
    const g = await demoApi.guardrails();
    assert.equal(g.defaults, true);
    assert.ok(Array.isArray(g.skipped));
    assert.ok(g.rules.some((r) => r.approval === 'builtin'));
  });

  test('停用與啟用只影響這台', async () => {
    await demoApi.guardrailsDisable('rm-shell-variable');
    assert.equal((await demoApi.guardrails()).rules.find((r) => r.id === 'rm-shell-variable').effective, 'off');
    await demoApi.guardrailsEnable('rm-shell-variable');
    assert.equal((await demoApi.guardrails()).rules.find((r) => r.id === 'rm-shell-variable').effective, 'hint');
  });
});

describe('展示版：每週摘要、情境召回、自動更新、偏好', () => {
  test('每週摘要的形狀和約定一致，可以看前幾週', async () => {
    const d = await demoApi.digest();
    for (const k of ['week', 'generatedAt', 'learned', 'graduated', 'holding', 'preferences', 'guardrails', 'recall', 'env', 'autopilot', 'previous']) assert.ok(k in d, `缺少 ${k}`);
    assert.ok(Array.isArray(d.learned.created) && Array.isArray(d.learned.updated));
    assert.deepEqual([typeof d.preferences.used, typeof d.preferences.pending], ['number', 'number'], '偏好是筆數（與 autopilot/digest.mjs 相同）');
    assert.ok(d.autopilot.stopped.every((s) => ['limit', 'auth', 'budget', 'busy'].includes(s.reason)), '摘要只記這四種提前停止');
    assert.ok(d.autopilot.stopped.some((s) => s.reason === 'busy'), '有一輪是 Claude 暫時忙碌而停下');
    assert.ok(d.graduated.every((g) => ['core', 'guardrail', 'env', 'archive'].includes(g.to)));
    // 第三輪審查 B：記憶畢業的現況與偏好候選的筆數（與偏好區塊列出的一致）；更早的週沒有這兩個欄位
    assert.deepEqual(Object.keys(d.graduation).sort(), ['candidates', 'needsConfirm', 'unconfirmed']);
    assert.ok(Object.values(d.graduation).every((n) => Number.isInteger(n) && n >= 0));
    const prefs = await demoApi.autopilotPreferences();
    assert.equal(d.preferences.candidates, prefs.candidates.length);
    assert.ok(prefs.pending.some((x) => x.graduation === 'core'), '還沒採用的也可能是記憶畢業等你確認的');
    assert.equal(d.graduation.needsConfirm, [...prefs.pending, ...prefs.candidates].filter((x) => x.graduation).length, '兩種去向（core、guardrail）都算');
    assert.ok(d.previous.length > 0);
    assert.equal((await demoApi.digest(d.previous[0])).week, d.previous[0]);
    const older = await demoApi.digest(d.previous[0]);
    assert.ok(!('graduation' in older) && !('candidates' in older.preferences), '以前存下來的週沒有新欄位，介面要照常顯示');
    assert.equal(await demoApi.digest('1999-01-04'), null, '沒有那一週就是還沒有摘要');
  });

  test('索引分層：情境召回關閉時不能開啟，另一台是舊版時也不能開啟（原因列出電腦）', async () => {
    const r = await demoApi.recall();
    assert.deepEqual([r.recall, r.indexLayers, r.recallForced], ['on', 'observe', false]);
    assert.ok(r.observe.scopes.global.bytes.on < r.observe.scopes.global.bytes.off);
    await assert.rejects(demoApi.saveSettings({ indexLayers: 'on' }), (e) => e.code === 'E_INVALID' && /升級/.test(e.message));
    await demoApi.saveSettings({ recall: 'off' });
    await assert.rejects(demoApi.saveSettings({ indexLayers: 'on' }), (e) => /情境召回關閉/.test(e.message));
    await demoApi.saveSettings({ recall: 'on' });
  });

  test('自動更新與偏好', async () => {
    const u = await demoApi.update();
    assert.equal(u.autoUpdate, 'on');
    assert.ok(u.last.status);
    const p = await demoApi.autopilotPreferences();
    assert.ok(p.used.length > 0 && p.pending.length > 0);
    // 來源是代碼（與 autopilot/prompts.mjs 的 preferenceItems 相同），介面換成文字
    assert.ok(p.used.every((x) => ['user', 'baseline', 'off', 'no-baseline'].includes(x.source)));
    assert.ok(p.pending.every((x) => ['claude', 'request', 'autopilot', 'none'].includes(x.source) && x.sha));
    await demoApi.reviewConfirm([{ ref: p.pending[0].ref, sha: p.pending[0].sha }]);
    assert.ok(!(await demoApi.autopilotPreferences()).pending.some((x) => x.ref === p.pending[0].ref), '確認之後不再列在還沒採用');
  });

  test('偏好的候選：常用、但還沒由你確認的其他記憶，可以逐筆確認；記憶畢業等你確認的排最前面', async () => {
    const p = await demoApi.autopilotPreferences();
    assert.ok(p.candidates.length >= 3);
    for (const x of p.candidates) {
      for (const k of ['ref', 'sha', 'name', 'description', 'type', 'scope', 'source', 'reads', 'recalled']) assert.ok(k in x, `${x.ref} 缺少 ${k}`);
      assert.ok(['global', 'machine'].includes(x.scope) && ['claude', 'request', 'autopilot', 'none'].includes(x.source), x.ref);
      assert.ok(!(x.scope === 'global' && ['feedback', 'user'].includes(x.type)), '全域的回饋與使用者記憶在還沒採用裡，不重複');
      assert.ok((await demoApi.memory(x.ref)).raw, `${x.ref} 讀得到全文`);
    }
    // 記憶畢業等你確認的（core｜guardrail）排最前面
    assert.ok(['core', 'guardrail'].includes(p.candidates[0].graduation));
    assert.ok([...p.pending, ...p.candidates].every((x) => !x.graduation || ['core', 'guardrail'].includes(x.graduation)));
    assert.deepEqual(new Set([...p.pending, ...p.candidates].map((x) => x.graduation).filter(Boolean)), new Set(['core', 'guardrail']), '展示資料兩種都有');
    const r =await demoApi.reviewConfirm([{ ref: p.candidates[1].ref, sha: p.candidates[1].sha }]);
    assert.deepEqual(r.confirmed, [p.candidates[1].ref]);
    assert.ok(!(await demoApi.autopilotPreferences()).candidates.some((x) => x.ref === p.candidates[1].ref), '確認之後不再列出');
  });
});

describe('展示版：自動駕駛與收件匣（2.0.0 收尾）', () => {
  test('自動駕駛：有 limit 欄位（沒碰到上限是 null）、記憶畢業的動作、標成不需要而略過的提案', async () => {
    const s = await demoApi.autopilot();
    assert.ok('limit' in s);
    assert.equal(s.limit, null);
    const runs = await Promise.all(s.runs.map((r) => demoApi.autopilotRun(r.id)));
    const g = runs.flatMap((r) => r.actions).find((a) => a.kind === 'graduate');
    assert.ok(g, '有一項記憶畢業');
    assert.deepEqual([g.task, g.to, g.graduate.to], ['graduate', 'core', 'core']);
    assert.ok(g.graduate.ref && g.graduate.line && g.undo.length > 0);
    assert.ok(runs.some((r) => r.summary?.byTask?.graduate >= 1), 'byTask 有 graduate（與 autopilot/run.mjs 的 summarize 相同）');
    assert.ok(runs.flatMap((r) => r.rejected).some((x) => x.dismissed === true), '有一項因為你在保留區標成不需要而略過');
  });

  test('收件匣：疑似同一個專案（H34）合併之後還原，回報重新接回原本專案的資料夾', async () => {
    const f = (await demoApi.findings()).find((x) => x.code === 'H34');
    assert.equal(f.fix.action, 'link-projects');
    assert.ok(f.fix.args.from && f.fix.args.to && f.fix.args.from !== f.fix.args.to);
    const r = await demoApi.apply(f.fix);
    assert.ok(!(await demoApi.findings()).some((x) => x.id === f.id));
    const u = await demoApi.undo(r.undo.sha);
    assert.equal(u.realigned.length, 1);
    assert.ok((await demoApi.findings()).some((x) => x.id === f.id), '還原之後卡片回來');
    assert.ok((await demoApi.findings()).some((x) => x.code === 'H35' && !x.fix), 'H35 只提醒，沒有一鍵修正');
  });

  test('收件匣：同步自動修復留下的衝突（by: heal），改用對方的版本時回報這台原檔的備份位置', async () => {
    const c = (await demoApi.conflicts()).find((x) => x.by === 'heal');
    assert.ok(c && c.ours.includes('‹'), '這台的版本已遮蔽金鑰');
    const r = await demoApi.resolveConflict(c.id, 'theirs');
    assert.match(r.backup, new RegExp(`^backup/\\d{8}T\\d{9}Z/${c.ref}$`), '位置相對於 local/，與 core/healbackup.mjs 相同');
  });

  test('收件匣：環境設定檔的衝突只有兩個選項；不適用的選項回 E_INVALID、紀錄留著；成功時回報做了什麼（中英）', async () => {
    const c = (await demoApi.conflicts()).find((x) => x.ref === 'env/profile.json');
    assert.deepEqual(c.choices, ['theirs', 'ours']);
    assert.ok(!c.by && c.ours && c.theirs && c.base, '紀錄裡有兩個版本與共同版本');
    // 第四輪審查 F-01：預設是 other（這筆是另一台電腦記的，後端已經把兩邊對調成「這台／另一台」）
    assert.equal(c.view, 'other');
    assert.equal(c.sides.ours.label, (await demoApi.status()).devices.find((d) => d.isSelf).label);
    assert.equal(c.otherMachine, c.sides.theirs.label);
    assert.match(c.choiceLabels.theirs, /另一台/);
    assert.match(c.en.choiceLabels.theirs, /other computer/);
    assert.ok(c.en.summary && !/這台|對方|this computer|theirs/.test(c.summary + c.en.summary), '說明不寫「這台／對方」');
    for (const choice of ['both', 'manual']) {
      await assert.rejects(demoApi.resolveConflict(c.id, choice, '{}'), (e) => e.code === 'E_INVALID' && /只能選/.test(e.message) && /can only be resolved/.test(e.en.message) && !!e.hint && !!e.en.hint);
    }
    assert.ok((await demoApi.conflicts()).some((x) => x.id === c.id), '被拒絕時紀錄留著');
    const r = await demoApi.resolveConflict(c.id, 'theirs');
    assert.deepEqual([r.ok, r.changed, r.ref], [true, true, 'env/profile.json']);
    assert.match(r.message, /BASH_DEFAULT_TIMEOUT_MS/);
    assert.match(r.en.message, /BASH_DEFAULT_TIMEOUT_MS/);
    assert.ok(r.undo.sha, '可以復原');
    assert.ok(!(await demoApi.conflicts()).some((x) => x.id === c.id));
    await demoApi.undo(r.undo.sha);
    assert.ok((await demoApi.conflicts()).some((x) => x.id === c.id), '復原之後紀錄回來');
    const same = await demoApi.resolveConflict(c.id, 'ours');
    assert.deepEqual([same.changed, /維持不變/.test(same.message), /was kept/.test(same.en.message)], [false, true, true]);
  });
});

describe('展示版的狀態變體：設定檔衝突的觀點、保留區採用核心準則、索引相容模式', () => {
  /** 展示版在載入時讀 location.search：換一個網址載入另一份模組（各自獨立的狀態） */
  async function demoWith(search) {
    globalThis.location = { search };
    try { return (await import(`../../src/ui/src/demo.js?${search}`)).demoApi; } finally { delete globalThis.location; }
  }

  test('設定檔衝突的三種觀點與舊紀錄：兩邊是哪台、按鈕的說法（中英）、舊紀錄只有一個選項', async () => {
    const get = async (v) => (await (await demoWith(`?conflict=${v}`)).conflicts()).find((x) => x.ref === 'env/profile.json');
    const recorder = await get('recorder');
    assert.deepEqual([recorder.view, recorder.choices], ['recorder', ['theirs', 'ours']]);
    assert.match(recorder.choiceLabels.ours, /^保留這台（.+）的版本$/);
    assert.match(recorder.en.choiceLabels.theirs, /^Use the other computer's \(.+\) version$/);
    const third = await get('third');
    assert.deepEqual([third.view, third.choices, 'otherMachine' in third], ['third', ['theirs', 'ours'], false]);
    assert.ok(third.sides.ours.label && third.sides.theirs.label && third.sides.ours.label !== third.sides.theirs.label);
    assert.ok(!/這台|another|this computer/i.test(`${third.choiceLabels.ours}${third.choiceLabels.theirs}${third.en.choiceLabels.ours}${third.en.choiceLabels.theirs}`), '第三台的選項用電腦名稱，不出現「這台」');
    const legacy = await get('legacy');
    assert.deepEqual([legacy.view, legacy.choices, Object.keys(legacy.choiceLabels)], ['legacy', ['ours'], ['ours']]);
    assert.equal(legacy.sides.ours.label, null);
    assert.equal(legacy.en.choiceLabels.ours, 'Keep the current value and only remove the record');
    // 舊紀錄：改用另一邊回 E_INVALID（紀錄留著）；維持目前的值只移除紀錄、changed 是 false
    const api = await demoWith('?conflict=legacy');
    await assert.rejects(api.resolveConflict(legacy.id, 'theirs'), (e) => e.code === 'E_INVALID' && !!e.hint && !!e.en.message);
    assert.ok((await api.conflicts()).some((x) => x.id === legacy.id));
    const r = await api.resolveConflict(legacy.id, 'ours');
    assert.deepEqual([r.changed, !!r.message, !!r.en.message], [false, true, true]);
    // 第三台：選項的說法用電腦名稱
    const t3 = await demoWith('?conflict=third');
    const r3 = await t3.resolveConflict(third.id, 'theirs');
    assert.ok(r3.changed && r3.message.includes(third.sides.theirs.label) && r3.en.message.includes(third.sides.theirs.label));
  });

  test('保留區採用記憶畢業的核心準則：來源記憶還沒確認時被拒絕、項目留著；在 Claude Code 裡採用回 coreUnconfirmed', async () => {
    const api = await demoWith('?holding=core');
    const held = (await api.holding({ status: 'held' })).filter((x) => x.graduate?.to === 'core');
    assert.equal(held.length, 2);
    const [claude, rejected] = held;
    await assert.rejects(api.holdingAdopt(rejected.id), (e) => e.code === 'E_INVALID' && /還沒由你本人確認/.test(e.message) && /not been confirmed/.test(e.en.message) && !!e.hint && !!e.en.hint);
    assert.ok((await api.holding({ status: 'held' })).some((x) => x.id === rejected.id), '被拒絕的項目留在保留區');
    const r = await api.holdingAdopt(claude.id);
    assert.equal(r.coreUnconfirmed, true);
    assert.equal(r.graduate.to, 'core');
  });

  test('索引相容模式：預設沒有開；?compat=on 時狀態與召回都有舊版的電腦、那台的版本是舊的', async () => {
    assert.equal((await demoApi.status()).indexCompat.active, false);
    assert.ok((await demoApi.status()).devices.every((d) => d.engramVersion === '2.0.0'));
    const api = await demoWith('?compat=on');
    const st = await api.status();
    assert.equal(st.indexCompat.active, true);
    const old = st.indexCompat.machines[0];
    assert.equal(st.devices.find((d) => d.id === old.mid).engramVersion, old.version, '裝置頁的版本和相容模式列的舊版電腦一致');
    assert.ok(st.devices.find((d) => d.isSelf).engramVersion === '2.0.0');
    assert.deepEqual((await api.recall()).indexCompat, st.indexCompat);
  });
});
