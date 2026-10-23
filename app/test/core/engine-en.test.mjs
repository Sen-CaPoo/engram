// 引擎文字的英文版（1.1.0）：衝突摘要、錯誤訊息、範圍分類理由、改名阻擋原因。
// 中文欄位不變；英文放在 en 底下，管理介面切到英文時才用。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { quarantine } from '../../src/core/conflicts.mjs';
import { machineSpecific, suggestScope } from '../../src/core/classify.mjs';
import { BLOCKED_LABEL, BLOCKED_LABEL_EN } from '../../src/core/rename.mjs';
import { machinePaths, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

let root; let eg;
before(async () => {
  root = mkTmp();
  const m = machinePaths(root, 'office');
  await init({ ...m, machineLabel: '公司電腦', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
});
after(() => rmTmp(root));

const hasHan = (s) => /[\u4e00-\u9fff]/.test(s);

describe('衝突摘要的英文版', () => {
  test('quarantine 的 summaryEn 存在 meta.en.summary，列出衝突時一併回傳', async () => {
    const vault = eg.paths.vault;
    await quarantine(vault, { ref: 'global/a.md', kind: 'modify-delete', ours: 'x', summary: '中文摘要', summaryEn: 'English summary' });
    const c = (await eg.conflicts.list()).find((x) => x.ref === 'global/a.md');
    assert.equal(c.summary, '中文摘要');
    assert.deepEqual(c.en, { summary: 'English summary' });
    const meta = JSON.parse(fs.readFileSync(path.join(vault, 'conflicts', c.id, 'meta.json'), 'utf8'));
    assert.deepEqual(meta.en, { summary: 'English summary' });
  });

  test('沒有傳 summary 時，預設的中英文摘要都有；只傳中文時不附 en', async () => {
    const vault = eg.paths.vault;
    await quarantine(vault, { ref: 'global/b.md', ours: 'x' });
    await quarantine(vault, { ref: 'global/c.md', ours: 'x', summary: '只有中文' });
    const list = await eg.conflicts.list();
    const b = list.find((x) => x.ref === 'global/b.md');
    assert.match(b.summary, /在兩台電腦有不同的修改/);
    assert.equal(b.en.summary, 'global/b.md was modified differently on two computers');
    const c = list.find((x) => x.ref === 'global/c.md');
    assert.equal(c.summary, '只有中文');
    assert.ok(!('en' in c));
  });

  test('舊的衝突紀錄（meta.json 沒有 en）照常列出', async () => {
    const dir = path.join(eg.paths.vault, 'conflicts', 'cf_20261001_old');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: 'cf_20261001_old', ref: 'global/old.md', kind: 'content', createdAt: '2026-10-01T00:00:00.000Z', summary: '舊的摘要' }));
    const c = (await eg.conflicts.list()).find((x) => x.id === 'cf_20261001_old');
    assert.equal(c.summary, '舊的摘要');
    assert.ok(!('en' in c));
  });
});

describe('錯誤訊息的英文版', () => {
  test('EngramError 附 en.message，中文 message 不變，toJSON 帶出 en', async () => {
    const err = await eg.memories.read('global/nope.md').then(() => null, (e) => e);
    assert.equal(err.code, 'E_NOT_FOUND');
    assert.equal(err.message, '找不到記憶：global/nope.md');
    assert.equal(err.en.message, 'Memory not found: global/nope.md');
    assert.equal(err.toJSON().en.message, 'Memory not found: global/nope.md');
  });

  test('invariant 的英文版（第 4 個參數）', async () => {
    const e1 = await eg.conflicts.resolve('../core', { choice: 'ours' }).then(() => null, (e) => e);
    assert.equal(e1.code, 'E_INVALID');
    assert.equal(e1.en.message, 'Invalid conflict id');
    const e2 = await eg.memories.create({ scope: { kind: 'global' }, name: 'x', type: 'bogus', description: 'd' }).then(() => null, (e) => e);
    assert.equal(e2.en.message, 'type must be one of user, feedback, project, reference');
    assert.match(e2.message, /type 必須是/);
    const e3 = await eg.memories.merge(['global/only-one.md'], { text: 'x' }).then(() => null, (e) => e);
    assert.equal(e3.en.message, 'At least two memories are needed to merge');
  });

  test('有提示的錯誤：英文訊息與英文提示都有', async () => {
    // 合併後的內容沒有 frontmatter、目標記憶也不存在
    const err = await eg.memories.merge(['global/ghost-1.md', 'global/ghost-2.md'], { into: 'global/ghost-1.md', text: '沒有 frontmatter 的內容' }).then(() => null, (e) => e);
    assert.equal(err?.code, 'E_INVALID', err?.message);
    assert.match(err.message, /沒有 frontmatter/);
    assert.equal(err.en.message, 'The merged content has no frontmatter, and the target memory does not exist');
    assert.match(err.en.hint, /^Provide complete content with name, description and metadata\.type/);
    assert.ok(!hasHan(err.en.hint));
  });
});

describe('範圍分類理由的英文版', () => {
  test('suggestScope：每一種理由都有 en.reason，machineSpecific 的 reasonsEn 與 reasons 一一對應', () => {
    const cases = [
      { type: 'user', text: 'x' },
      { type: 'feedback', text: '簡報用圖大於表大於文' },
      { type: 'project', text: '專案筆記' },
      { type: 'reference', text: '這台電腦的網路設定' },
      { type: 'project', text: '已安裝在 C:\\tools\\cua' },
      { type: 'project', text: 'D 槽寫滿了', hostnames: [] },
      { type: 'project', text: '主機 SHPC-T5EB 的設定', hostnames: ['SHPC-T5EB'] },
    ];
    for (const c of cases) {
      const s = suggestScope(c);
      assert.ok(s.reason && s.en.reason && !hasHan(s.en.reason), `${c.text}：${s.en.reason}`);
      const m = machineSpecific(c);
      assert.equal(m.reasonsEn.length, m.reasons.length);
    }
    assert.equal(suggestScope({ type: 'reference', text: '這台電腦的網路設定' }).en.reason, 'Mentions this computer');
    assert.equal(suggestScope({ type: 'user', text: 'x' }).en.reason, 'User-level information that applies to all projects');
  });
});

describe('改名阻擋原因的英文版', () => {
  test('BLOCKED_LABEL_EN 與 BLOCKED_LABEL 的鍵完全相同，而且沒有中文', () => {
    assert.deepEqual(Object.keys(BLOCKED_LABEL_EN).sort(), Object.keys(BLOCKED_LABEL).sort());
    for (const [k, v] of Object.entries(BLOCKED_LABEL_EN)) assert.ok(v && !hasHan(v), k);
  });
});
