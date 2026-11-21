// 索引分層（2.0.0 WP4a P2）：三種模式的 INDEX.md、所有電腦共用的 indexLayers（vault/settings.json）、並行觀察的數字、recall 與 indexLayers 的互斥、
// 分層後健康檢查不把參考類記憶當成「不在索引裡」。全部用合成資料，不會碰到真正的 ~/.engram 或 ~/.claude。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApi } from '../../src/agent/api.mjs';
import { init, open } from '../../src/core/index.mjs';
import { readIndexLayers, renderScopeIndex } from '../../src/core/normalize.mjs';
import { git, machinePaths, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

let root;
let m;
let eg;

const settingsFile = () => path.join(eg.paths.local, 'settings.json');
const globalIndex = () => fs.readFileSync(path.join(eg.paths.vault, 'global', 'INDEX.md'), 'utf8');
const machineIndex = () => fs.readFileSync(path.join(eg.paths.vault, 'machines', eg.machine.id, 'INDEX.md'), 'utf8');
const memFile = ({ name, type, pinned = false, project = null }) =>
  `---\nname: ${name}\ndescription: "${name} 的說明"\nmetadata:\n  type: ${type}\n  modified: 2026-11-01T00:00:00.000Z\n${pinned || project ? `  engram:\n${pinned ? '    pinned: true\n' : ''}${project ? `    project: ${project}\n` : ''}` : ''}---\n${name} 的內文。\n`;
const write = (rel, text) => {
  const p = path.join(eg.paths.vault, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const LAYER = /^- 另有 (\d+) 筆參考類記憶不在索引，相關時會自動帶出，也可以用 `engram search <關鍵字>` 查詢。$/m;

before(async () => {
  root = mkTmp();
  m = machinePaths(root, 'home');
  await init({ ...m, machineLabel: '工作室桌機', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
  write('global/rule-feedback.md', memFile({ name: 'rule-feedback', type: 'feedback' }));
  write('global/rule-user.md', memFile({ name: 'rule-user', type: 'user' }));
  write('global/ref-pinned.md', memFile({ name: 'ref-pinned', type: 'reference', pinned: true }));
  for (const n of ['ref-a', 'ref-b', 'ref-c']) write(`global/${n}.md`, memFile({ name: n, type: 'reference' }));
  write('global/proj-note.md', memFile({ name: 'proj-note', type: 'project' }));
  write(`machines/${eg.machine.id}/m-feedback.md`, memFile({ name: 'm-feedback', type: 'feedback' }));
  write(`machines/${eg.machine.id}/m-ref.md`, memFile({ name: 'm-ref', type: 'reference' }));
  write(`machines/${eg.machine.id}/m-proj.md`, memFile({ name: 'm-proj', type: 'reference', project: 'p-demo' }));
});
after(() => rmTmp(root));
// 每個測試從「這台 recall 開啟、共用的 indexLayers 是 observe」開始
beforeEach(async () => {
  fs.rmSync(settingsFile(), { force: true });
  await eg.settings.set({ indexLayers: 'observe' });
});

const syncLocal = () => eg.sync({ network: false });
const sharedFile = () => path.join(eg.paths.vault, 'settings.json');

describe('三種模式的 INDEX.md', () => {
  test('observe（預設）與 off：照舊列出全部，沒有分層的說明行', async () => {
    await syncLocal();
    const observe = globalIndex();
    for (const n of ['rule-feedback', 'rule-user', 'ref-pinned', 'ref-a', 'ref-b', 'ref-c', 'proj-note']) assert.match(observe, new RegExp(`\\[${n}\\]`));
    assert.doesNotMatch(observe, LAYER);
    await eg.settings.set({ indexLayers: 'off' });
    assert.equal(globalIndex(), observe);
    await syncLocal();
    assert.equal(globalIndex(), observe);
  });

  test('on：只列規則層（feedback、user、釘選），結尾一行說明參考類的筆數；標題的筆數不變；改設定當下就重建（不等同步）', async () => {
    await eg.settings.set({ indexLayers: 'on' });
    const text = globalIndex();
    for (const n of ['rule-feedback', 'rule-user', 'ref-pinned']) assert.match(text, new RegExp(`\\[${n}\\]`));
    for (const n of ['ref-a', 'ref-b', 'ref-c', 'proj-note']) assert.doesNotMatch(text, new RegExp(`\\[${n}\\]`));
    assert.equal(LAYER.exec(text)?.[1], '4');
    assert.match(text, /# 全域記憶（7 筆）/);
  });

  test('on：單機索引一樣分層；只與特定專案有關的不算參考類（另外一行照舊）', async () => {
    await eg.settings.set({ indexLayers: 'on' });
    const text = machineIndex();
    assert.match(text, /\[m-feedback\]/);
    assert.doesNotMatch(text, /\[m-ref\]/);
    assert.equal(LAYER.exec(text)?.[1], '1');
    assert.match(text, /另有 1 筆只與特定專案有關/);
  });

  test('冪等：同一個模式連續產生兩次一字不差；寫入記憶時與同步時用同一個設定（不會換來換去）', async () => {
    await eg.settings.set({ indexLayers: 'on' });
    await syncLocal();
    const before = globalIndex();
    await syncLocal();
    assert.equal(globalIndex(), before);
    await eg.memories.create({ scope: { kind: 'global' }, name: 'ref-new', type: 'reference', description: '新的參考', body: '內文' });
    const afterWrite = globalIndex();
    assert.doesNotMatch(afterWrite, /\[ref-new\]/);
    assert.equal(LAYER.exec(afterWrite)?.[1], '5');
    await syncLocal();
    assert.equal(globalIndex(), afterWrite);
  });

  test('索引只看共用的設定：這台的 recall 是什麼都一樣', async () => {
    assert.equal(readIndexLayers({ indexLayers: 'on' }), 'on');
    assert.equal(readIndexLayers({ indexLayers: 'observe' }), 'off');
    assert.equal(readIndexLayers(null), 'off');
    const dir = path.join(eg.paths.vault, 'global');
    const plain = await renderScopeIndex({ kind: 'global', dir, userHome: m.userHome });
    assert.equal(await renderScopeIndex({ kind: 'global', dir, userHome: m.userHome, layers: 'off' }), plain);
  });

  test('分層後參考類記憶不算「不在索引裡」：記憶清單的 indexed 仍是 true，健康檢查沒有 H03', async () => {
    await eg.settings.set({ indexLayers: 'on' });
    const list = await eg.memories.list({ scope: { kind: 'global' } });
    assert.ok(list.length >= 7);
    assert.ok(list.every((x) => x.indexed), list.filter((x) => !x.indexed).map((x) => x.ref).join(', '));
    const findings = await eg.health();
    assert.ok(!findings.some((f) => f.code === 'H03'), JSON.stringify(findings.filter((f) => f.code === 'H03')));
  });
});

describe('設定', () => {
  test('預設 recall: on、indexLayers: observe；看不懂的值用預設；indexLayers 存在記憶庫的 settings.json，不在本機設定', async () => {
    fs.rmSync(sharedFile(), { force: true });
    const s = await eg.settings.get();
    assert.deepEqual([s.recall, s.recallForced, s.indexLayers], ['on', false, 'observe']);
    fs.writeFileSync(settingsFile(), JSON.stringify({ recall: 'maybe', indexLayers: 'on' }));
    fs.writeFileSync(sharedFile(), JSON.stringify({ v: 1, indexLayers: 'sometimes' }));
    assert.deepEqual([(await eg.settings.get()).recall, (await eg.settings.get()).indexLayers], ['on', 'observe'], '本機設定裡的 indexLayers 不算');
    fs.rmSync(settingsFile());
    await eg.settings.set({ indexLayers: 'on' });
    const shared = JSON.parse(fs.readFileSync(sharedFile(), 'utf8'));
    assert.deepEqual([shared.v, shared.indexLayers, shared.by], [1, 'on', eg.machine.id]);
    assert.ok(Date.parse(shared.updatedAt));
    assert.equal(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).indexLayers, undefined, '本機設定不寫 indexLayers');
  });

  test('改設定會 commit 共用設定與重建的索引；值沒變就不動', async () => {
    await eg.settings.set({ indexLayers: 'on' });
    const last = git(eg.paths.vault, 'log', '-1', '--name-only', '--format=%s').trim().split('\n');
    assert.match(last[0], /indexLayers → on/);
    assert.ok(last.includes('settings.json'));
    assert.ok(last.includes('global/INDEX.md'));
    const head = git(eg.paths.vault, 'rev-parse', 'HEAD').trim();
    await eg.settings.set({ indexLayers: 'on' });
    assert.equal(git(eg.paths.vault, 'rev-parse', 'HEAD').trim(), head, '沒變就不產生 commit');
  });

  test('不合法的值被拒絕', async () => {
    await assert.rejects(eg.settings.set({ recall: 'yes' }), (e) => e.code === 'E_INVALID' && /recall/.test(e.message));
    await assert.rejects(eg.settings.set({ indexLayers: 'all' }), (e) => e.code === 'E_INVALID' && e.en?.message === "indexLayers must be 'observe', 'on' or 'off'");
  });

  test('這台 recall 關閉時不能開 indexLayers；一起改可以', async () => {
    await eg.settings.set({ recall: 'off' });
    await assert.rejects(eg.settings.set({ indexLayers: 'on' }), (e) => e.code === 'E_INVALID' && /情境召回關閉時不能開啟索引分層/.test(e.message) && /recall/.test(e.hint) && /context recall is off/.test(e.en?.message));
    assert.equal((await eg.settings.get()).indexLayers, 'observe');
    const s = await eg.settings.set({ recall: 'on', indexLayers: 'on' });
    assert.deepEqual([s.recall, s.indexLayers], ['on', 'on']);
  });

  test('indexLayers 是 on 時 recall 強制開啟：get 回傳 on 與 recallForced；關閉 recall 被拒絕並說明原因', async () => {
    await eg.settings.set({ indexLayers: 'on' });
    const s = await eg.settings.get();
    assert.deepEqual([s.recall, s.recallForced], ['on', true]);
    await assert.rejects(eg.settings.set({ recall: 'off' }), (e) => e.code === 'E_INVALID' && /強制開啟/.test(e.message) && /indexLayers/.test(e.hint) && /forced on/.test(e.en?.message));
    // 另一台把共用設定切成 on 時，這台本機寫著 off 也一樣被強制開啟
    fs.writeFileSync(settingsFile(), JSON.stringify({ recall: 'off' }));
    assert.deepEqual([(await eg.settings.get()).recall, (await eg.settings.get()).recallForced], ['on', true]);
    // 一起改（先關分層）就可以
    const off = await eg.settings.set({ recall: 'off', indexLayers: 'observe' });
    assert.deepEqual([off.recall, off.recallForced, off.indexLayers], ['off', false, 'observe']);
  });

  test('切到 on 之前所有電腦都要是這一版以上；有舊版電腦時拒絕並列出是哪幾台（30 天沒開的不算）', async () => {
    const fake = (mid, value) => {
      const p = path.join(eg.paths.vault, 'machines', mid, 'machine.json');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(value));
    };
    fake('old-pc-0001', { label: '舊筆電', engramVersion: '1.5.0', lastSeenAt: new Date().toISOString() });
    fake('gone-pc-0002', { label: '不用的電腦', engramVersion: '1.0.0', lastSeenAt: new Date(Date.now() - 40 * 86_400_000).toISOString() });
    try {
      await assert.rejects(eg.settings.set({ indexLayers: 'on' }), (e) => e.code === 'E_INVALID' && /舊筆電（1\.5\.0）/.test(e.message) && !/不用的電腦/.test(e.message) && /engram update/.test(e.hint) && /舊筆電 \(1\.5\.0\)/.test(e.en?.message));
      assert.equal((await eg.settings.get()).indexLayers, 'observe');
    } finally {
      fs.rmSync(path.join(eg.paths.vault, 'machines', 'old-pc-0001'), { recursive: true, force: true });
      fs.rmSync(path.join(eg.paths.vault, 'machines', 'gone-pc-0002'), { recursive: true, force: true });
    }
    assert.equal((await eg.settings.set({ indexLayers: 'on' })).indexLayers, 'on');
  });

  test('同步後發現最近 7 天有活動、還是舊版的電腦：共用的 indexLayers 自動改回 observe 並重建索引；沒活動的舊電腦不算', async () => {
    const fake = (mid, value) => {
      const p = path.join(eg.paths.vault, 'machines', mid, 'machine.json');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(value));
    };
    const now = Date.now();
    try {
      await eg.settings.set({ indexLayers: 'on' });
      assert.match(globalIndex(), LAYER);
      // 很久沒開、也沒同步的舊電腦：不動
      fake('idle-pc-0003', { label: '倉庫舊筆電', engramVersion: '1.5.0', lastSeenAt: new Date(now - 40 * 86_400_000).toISOString(), lastSyncAt: new Date(now - 10 * 86_400_000).toISOString() });
      assert.deepEqual((await eg.recall.guardLayers({ now })).reverted, []);
      assert.equal((await eg.settings.get()).indexLayers, 'on');
      // 長假回來的舊電腦：最後上線很久以前，但 2 天前同步過
      fake('back-pc-0004', { label: '門市舊桌機', engramVersion: '1.5.0', lastSeenAt: new Date(now - 40 * 86_400_000).toISOString(), lastSyncAt: new Date(now - 2 * 86_400_000).toISOString() });
      const r = await eg.recall.guardLayers({ now });
      assert.deepEqual(r.reverted.map((x) => [x.mid, x.label, x.version]), [['back-pc-0004', '門市舊桌機', '1.5.0']]);
      assert.equal((await eg.settings.get()).indexLayers, 'observe');
      assert.doesNotMatch(globalIndex(), LAYER, '索引當下就改回完整版');
      assert.match(git(eg.paths.vault, 'log', '-1', '--format=%s'), /indexLayers → observe/);
      assert.deepEqual((await eg.recall.guardLayers({ now })).reverted, [], '已經是 observe：不再動，也不會再通知');
    } finally {
      for (const mid of ['idle-pc-0003', 'back-pc-0004']) fs.rmSync(path.join(eg.paths.vault, 'machines', mid), { recursive: true, force: true });
    }
  });

  test('PUT /api/settings：recall 與 indexLayers 一起改，不受先後順序影響；GET /api/recall 回傳設定與觀察數字', async () => {
    const api = createApi({ eg, jobs: {}, paths: { local: eg.paths.local, home: eg.paths.home, vault: eg.paths.vault }, info: { statusSummary: () => ({}) } });
    const none = new URLSearchParams();
    await eg.settings.set({ indexLayers: 'on' });
    await api.handle('PUT', '/api/settings', none, { recall: 'off', indexLayers: 'off' });
    assert.deepEqual([(await eg.settings.get()).recall, (await eg.settings.get()).indexLayers], ['off', 'off']);
    await assert.rejects(api.handle('PUT', '/api/settings', none, { indexLayers: 'on' }), (e) => e.code === 'E_INVALID');
    assert.ok(api.routes.includes('GET /api/recall'));
    const r = await api.handle('GET', '/api/recall', none, {});
    assert.deepEqual([r.recall, r.recallForced, r.indexLayers], ['off', false, 'off']);
    assert.ok(r.observe.scopes.global);
  });
});

describe('並行觀察（observe）', () => {
  test('兩種模式下索引的位元組、參考類筆數；近 30 天帶出的次數與其中被打開的次數；不會自動切換', async () => {
    await syncLocal();
    const now = Date.parse('2026-11-21T12:00:00.000Z');
    const dir = path.join(eg.paths.local, 'usage', 'recall');
    fs.mkdirSync(dir, { recursive: true });
    const row = (at, session, ref) => `${JSON.stringify({ at, session, ref, score: 4.2 })}\n`;
    fs.writeFileSync(path.join(dir, '2026-11-21.jsonl'), row('2026-11-21T01:00:00.000Z', 's1', 'global/ref-a.md') + row('2026-11-21T02:00:00.000Z', 's2', 'global/ref-b.md') + 'oops\n');
    fs.writeFileSync(path.join(dir, '2026-11-01.jsonl'), row('2026-11-01T01:00:00.000Z', 's0', 'global/ref-c.md'));
    // mod 每個程序各寫自己的檔（<日期>.<程序代號>.jsonl）：同一天的都要算
    fs.writeFileSync(path.join(dir, '2026-11-21.ab12cd34.jsonl'), row('2026-11-21T03:00:00.000Z', 's4', 'global/ref-c.md'));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(dir, '2026-09-01.jsonl'), row('2026-09-01T01:00:00.000Z', 'old', 'global/ref-c.md'));
    // 讀取統計：s1 讀過 ref-a（帶出之後被打開）；s3 讀過 ref-b，但帶出 ref-b 的是 s2
    fs.mkdirSync(path.join(eg.paths.local, 'usage'), { recursive: true });
    fs.writeFileSync(path.join(eg.paths.local, 'usage', 'reads.json'), JSON.stringify({ v: 1, refs: {}, seen: { '2026-11-21': ['s1\u0000global/ref-a.md', 's3\u0000global/ref-b.md'] } }));

    const s = await eg.recall.status({ now });
    assert.equal(s.indexLayers, 'observe');
    assert.equal(s.effectiveLayers, 'off');
    assert.equal(s.observe.days, 30);
    assert.equal(s.observe.recalled, 4, '30 天以前的不算，壞掉的行略過；各程序的檔都算');
    assert.equal(s.observe.opened, 1);
    assert.equal(s.observe.scopes.global.reference, 5, 'ref-a、ref-b、ref-c、proj-note 與前面測試寫入的 ref-new');
    assert.equal(s.observe.scopes.machine.reference, 1);
    assert.ok(s.observe.scopes.global.bytes.on < s.observe.scopes.global.bytes.off);
    assert.equal(s.observe.scopes.global.bytes.off, Buffer.byteLength(globalIndex()), '照舊模式的位元組就是目前的索引');
    assert.doesNotMatch(globalIndex(), LAYER, '只是觀察，索引沒有被切換');
  });
});
