// 測試用的假引擎：回傳形狀照 40 號 §15 與實際引擎（app/src/core/index.mjs）。
// 每次呼叫都記在 eg.calls，測試可以逐項替換方法（例如 eg.sync = async () => ({ ok: false, state: 'locked' })）。
import path from 'node:path';

export class FakeEngramError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

const AT = '2026-10-22T01:00:00.000Z';
const action = (sha = 'a1b2c3d') => ({ ok: true, commit: { sha, message: 'engram(office-7k2q): test' }, undo: { sha } });

export function createFakeEngine({ home = path.join('C:', 'fake', '.engram'), claudeHome } = {}) {
  const calls = [];
  const rec = (name, args, result) => {
    calls.push({ name, args });
    return result;
  };
  const machine = { id: 'office-7k2q', label: '公司電腦', hostname: 'DEVPC', rename: async (label) => rec('machine.rename', [label], { ok: true }) };
  const paths = {
    home,
    vault: path.join(home, 'vault'),
    local: path.join(home, 'local'),
    claudeHome: claudeHome ?? path.join(path.dirname(home), '.claude'),
  };
  const summary = {
    ref: 'global/powershell-bom.md', scope: { kind: 'global' }, name: 'powershell-bom', description: '含中文的 .ps1 要加 BOM',
    type: 'feedback', size: 210, updatedAt: AT, pinned: false, tags: [], indexed: true, findings: [],
  };
  const memory = {
    ref: summary.ref, scope: summary.scope,
    frontmatter: { name: 'powershell-bom', description: summary.description, metadata: { type: 'feedback' } },
    body: '寫 .ps1 時加 BOM。\n', raw: '---\nname: powershell-bom\n---\n寫 .ps1 時加 BOM。\n', path: path.join(paths.vault, 'global', 'powershell-bom.md'), updatedAt: AT,
  };
  const project = {
    pid: 'acme-gateway-3fa9k', name: 'Acme_Gateway', aliases: [], remotes: ['github.com/acme/acme-gateway'],
    paths: { [machine.id]: { path: 'C:\\Users\\you\\Desktop\\Acme_Gateway', exists: true, lastOpenedAt: AT, method: 'junction', encoded: 'C--Users-you-Desktop-Acme-Gateway' } },
    counts: { memories: 3, findings: 0 }, index: { lines: 3, bytes: 240 }, lastActivityAt: AT, archived: false,
  };
  const finding = {
    id: 'H01:acme-gateway-3fa9k', code: 'H01', severity: 'high', title: '專案索引超過載入上限', detail: 'MEMORY.md 超過 200 行',
    refs: ['projects/acme-gateway-3fa9k/memory/MEMORY.md'], pid: project.pid, fix: { action: 'merge', args: {}, label: '合併或封存' },
  };

  const eg = {
    calls,
    version: '0.1.0',
    machine,
    paths,
    contextText: '[Engram] 公司電腦（office-7k2q）· 專案：Acme_Gateway（acme-gateway-3fa9k）· 已綁定\n同步：最後同步 3 分鐘前',

    status: async () => rec('status', [], {
      machine,
      vault: { path: paths.vault, remote: 'https://github.com/Sen-CaPoo/engram-vault.git', branch: 'main', head: 'a1b2c3d' },
      sync: { state: 'ok', lastSuccessAt: AT, lastAttemptAt: AT, ahead: 0, behind: 0 },
      counts: { global: 1, projects: 1, projectMemories: 3, machine: 0, total: 4 },
      inbox: { conflicts: 0, findings: { high: 1, medium: 0, low: 0 }, checkedAt: AT },
      devices: [{ id: machine.id, label: machine.label, lastSeenAt: AT, engramVersion: '0.1.0', isSelf: true }],
    }),
    sessionContext: async (input) => rec('sessionContext', [input], { text: eg.contextText, binding: null, warnings: [] }),
    activity: async (o) => rec('activity', [o], [{ date: '2026-10-22', added: 1, changed: 2, removed: 0 }]),

    projects: {
      list: async () => rec('projects.list', [], [project]),
      get: async (pid) => rec('projects.get', [pid], project),
      rename: async (pid, name) => rec('projects.rename', [pid, name], action()),
      link: async (from, to) => rec('projects.link', [from, to], action()),
    },
    identity: {
      pending: async () => rec('identity.pending', [], []),
      reconcile: async (opts) => rec('identity.reconcile', [opts], { ok: true, junction: true, changed: [], deferred: [] }),
      resolve: async (dir) => rec('identity.resolve', [dir], {
        dir, root: dir, isGit: true, encoded: 'C--Users-you-Desktop-Acme-Gateway', pid: project.pid, confidence: 'certain', reason: 'binding',
        candidates: [], binding: { pid: project.pid, path: dir, method: 'junction', state: 'active' }, collision: null, remotes: [], rootCommits: [],
      }),
      bind: async (dir, target, opts) => rec('identity.bind', [dir, target, opts], { ok: true, pid: target?.pid ?? project.pid, created: !!target?.create, method: 'junction', state: 'active', ...action() }),
      unbind: async (dir) => rec('identity.unbind', [dir], { ok: true, pid: project.pid }),
    },
    memories: {
      list: async (f) => rec('memories.list', [f], [summary]),
      read: async (ref) => {
        rec('memories.read', [ref]);
        if (ref !== memory.ref) throw new FakeEngramError('E_NOT_FOUND', `找不到記憶：${ref}`);
        return memory;
      },
      create: async (input) => rec('memories.create', [input], { ...action(), ref: `global/${input.name}.md` }),
      write: async (ref, input) => rec('memories.write', [ref, input], action()),
      move: async (ref, scope, o) => rec('memories.move', o === undefined ? [ref, scope] : [ref, scope, o], action()),
      merge: async (refs, o) => rec('memories.merge', [refs, o], action()),
      remove: async (ref) => rec('memories.remove', [ref], action()),
      restore: async (ref, o) => rec('memories.restore', [ref, o], action()),
    },
    search: async (q, o) => rec('search', [q, o], [{ ref: summary.ref, scope: summary.scope, name: summary.name, description: summary.description, snippet: '寫 .ps1 時加 BOM。', score: 1.5 }]),
    normalize: async () => rec('normalize', [], { ok: true }),
    sweepLegacy: async (o) => rec('sweepLegacy', [o], {
      sources: [], totals: { sources: 0, memories: 0, copy: 0, skip: 0, global: 0, machine: 0, archived: 0, unknown: 0 },
    }),
    sync: async (o) => rec('sync', [o], { ok: true, state: 'ok', committed: 1, pulled: 0, pushed: !!o?.network, conflicts: [], held: [], skipped: { recent: [], secrets: [] } }),
    health: async () => rec('health', [], [finding]),
    apply: async (fix) => rec('apply', [fix], fix?.action === 'merge' ? { ok: false, needsUi: true, action: 'merge', args: fix.args ?? {} } : action()),
    history: async (o) => rec('history', [o], [{ sha: 'a1b2c3d', at: AT, machine: machine.id, action: 'edit', refs: [summary.ref], message: 'edit global/powershell-bom.md', undoable: true }]),
    undo: async (sha) => rec('undo', [sha], action('b2c3d4e')),
    conflicts: {
      list: async () => rec('conflicts.list', [], [{ id: 'cf_20261022T0930_k3m1', ref: summary.ref, kind: 'content', createdAt: AT, ours: 'A', theirs: 'B', base: null, summary: '內文不同' }]),
      resolve: async (id, o) => rec('conflicts.resolve', [id, o], action()),
    },
    core: {
      read: async () => rec('core.read', [], { path: path.join(paths.vault, 'core', 'CORE.md'), text: '# 核心準則\n\n@../global/INDEX.md\n', stats: { lines: 3, bytes: 40 } }),
      write: async (text) => rec('core.write', [text], action()),
      guidelines: {
        preview: async () => rec('core.guidelines.preview', [], { current: '# 我的準則\n', proposed: '# 我的準則\n', coreLine: '@rules/user-guidelines.md', lines: 1, adopted: false }),
        adopt: async () => rec('core.guidelines.adopt', [], action()),
        revert: async () => rec('core.guidelines.revert', [], action()),
      },
    },
    findings: { dismiss: async (id, o) => rec('findings.dismiss', [id, o], { ok: true }) },
    env: {
      fingerprint: async (o) => rec('env.fingerprint', [o], {
        v: 1, updated: '2026-11-20', claudeCode: { version: '2.1.329' }, engram: { version: '2.0.0', commit: 'a1b2c3d' },
        settings: { present: true, keys: ['env'], envKeys: ['A_MODE'], enabledPlugins: {}, hooks: [], cleanupPeriodDays: null },
        plugins: [{ name: 'alpha', marketplace: 'mkt', version: '1.0.0', hooks: [] }], skills: [], agents: [], commands: [],
        claudeMd: { bytes: 120, hash: 'h1', modified: '2026-11-01', blocks: [{ name: 'engram', bytes: 50, hash: 'e1' }] },
        hookStats: { windowDays: 7, hooks: [{ event: 'PostToolUse', source: 'tele@mkt', mode: 'sync', command: 'node ~/send.js', runs: 12, medianMs: 1200, totalMs: 14400 }, { event: 'SessionStart', source: null, mode: 'unknown', command: 'python x.py', runs: 8, medianMs: 700, totalMs: 5600 }, { event: 'Stop', source: 'quiet@mkt', mode: 'async', command: 'node bg.js', runs: 9, medianMs: 900, totalMs: 8100 }] },
      }),
      findings: async (o) => rec('env.findings', [o], [{
        id: 'H32:abc1234567', code: 'H32', severity: 'low', title: '沒有設定對話紀錄的保留天數', detail: 'Claude Code 預設在 30 天後清除對話紀錄。', refs: ['env:cleanup-period'],
        fix: { action: 'env-fix', args: { id: 'H32:abc1234567' }, label: '設成 60 天', en: { label: 'Set it to 60 days' } }, en: { title: 'The conversation retention period is not set', detail: 'x' },
      }]),
      diff: async () => rec('env.diff', [], {
        machines: [{ mid: machine.id, label: machine.label, self: true, updated: '2026-11-20', hasEnv: true }, { mid: 'home-pc-1a2b', label: '家裡電腦', self: false, updated: '2026-11-19', hasEnv: true }], compared: 2,
        items: [{ area: 'claude-code', key: 'Claude Code', kind: 'version', values: { [machine.id]: '2.1.329', 'home-pc-1a2b': '2.1.322' }, newer: machine.id, summary: '「Claude Code」版本不同：公司電腦：2.1.329，家裡電腦：2.1.322；公司電腦 比較新', en: { summary: 'x' } }],
      }),
      fix: async (id, o) => rec('env.fix', o === undefined ? [id] : [id, o], { ok: true, code: 'H32', changed: true, days: 60, backup: 'C:\\fake\\env-backup' }),
      run: async (o) => rec('env.run', [o], { ok: true, written: false, findings: 1, fixed: [] }),
      // 2.0.0 WP8：環境設定同步與瘦身
      profile: async () => rec('env.profile', [], { present: true, problem: null, profile: { v: 1, env: { A_MODE: '1' }, settings: { theme: 'dark' }, skills: ['alpha-skill'], plugins: [{ name: 'alpha', marketplace: 'mkt' }], updatedAt: AT, by: 'home-pc-1a2b' }, overrides: { present: false, problem: null, skip: [], env: {}, settings: {} }, blocked: [], whitelist: ['theme'] }),
      set: async (key, value, o) => rec('env.set', o === undefined ? [key, value] : [key, value, o], { ok: true, key, changed: true, approved: o?.approve !== false }),
      approve: async (items) => rec('env.approve', items === undefined ? [] : [items], { ok: true, count: 1, approved: [{ area: 'env', key: 'GONE_MODE', hash: 'a'.repeat(40), summary: '環境變數「GONE_MODE」：新增 1（等待這台核可）', en: { summary: 'x' } }] }),
      unset: async (name) => rec('env.unset', [name], { ok: true, key: String(name).replace(/^setting:/, ''), area: String(name).startsWith('setting:') ? 'setting' : 'env', changed: true }),
      removeSkill: async (name) => rec('env.removeSkill', [name], { ok: true, name, removedFiles: true, changed: true }),
      removePlugin: async (name) => rec('env.removePlugin', [name], { ok: true, key: `${name}@mkt`, changed: true }),
      skip: async (item) => rec('env.skip', [item], { ok: true, changed: true, item, skip: true }),
      unskip: async (item) => rec('env.unskip', [item], { ok: true, changed: true, item, skip: false }),
      export: async (o) => rec('env.export', [o], {
        ok: true, changed: true, settings: ['theme'], plugins: 1,
        blocked: [{ area: 'setting', key: 'statusLine', reason: 'home-path', message: '「statusLine」的值含這台電腦的家目錄路徑，換到別台電腦就不對了', en: { message: 'x' } }],
        skills: {
          synced: [{ name: 'alpha-skill', files: 2, skippedLarge: ['big.bin'], skippedLinks: [] }],
          blocked: [{ name: 'leaky', reason: 'secret', files: [{ rel: 'notes.txt', kinds: ['anthropic-api-key'] }] }],
          conflicts: [{ name: 'twin', reason: 'changed-elsewhere' }],
        },
      }),
      plan: async (o) => rec('env.plan', o === undefined ? [] : [o], {
        v: 1, at: AT, envSync: 'report', profile: { present: true, updatedAt: AT, by: 'home-pc-1a2b' }, overrides: { present: false }, settingsFormat: 'ok',
        items: [
          { area: 'setting', key: 'theme', action: 'update', from: 'light', to: 'dark', approved: true, hash: 'a'.repeat(40), summary: '設定「theme」：light → dark', en: { summary: 'Setting "theme": light -> dark' } },
          { area: 'env', key: 'NEW_MODE', action: 'add', from: null, to: 'a-very-long-value-that-is-shown-in-full', approved: false, hash: 'b'.repeat(40), summary: '環境變數「NEW_MODE」：新增 a-very-long-value-that-is-shown-in-full（等待這台核可）', en: { summary: 'x' } },
          { area: 'plugin', key: 'beta@mkt', action: 'missing', summary: '外掛「beta@mkt」：這台沒有安裝（Engram 不會自動安裝，請自行安裝）', en: { summary: 'x' } },
        ],
        blocked: [{ area: 'env', key: 'MY_API_KEY', reason: 'secret-name', message: '名稱含 KEY、TOKEN、SECRET 或 PASSWORD 的環境變數不會同步', en: { message: 'x' } }],
        unused: { known: true, windowDays: 30, plugins: [{ key: 'idle-one@mkt', name: 'idle-one', installedAt: AT }] }, changes: 1, pending: 1,
      }),
      apply: async () => rec('env.apply', [], { ok: true, id: '2026-11-21T01-00-00-000Z', applied: 1, backup: 'C:\\fake\\env-backup\\apply', items: [{ area: 'setting', key: 'theme', action: 'update', summary: '設定「theme」：light → dark', en: { summary: 'x' } }] }),
      undo: async () => rec('env.undo', [], { ok: true, id: '2026-11-21T01-00-00-000Z', kind: 'apply', restored: 1, kept: [{ key: 'setting:model', reason: 'changed' }] }),
      setPlugin: async (name, enabled) => rec('env.setPlugin', [name, enabled], { ok: true, changed: true, key: `${name}@mkt`, enabled, backup: 'C:\\fake\\env-backup\\plugin' }),
      cachedPlan: async () => rec('env.cachedPlan', [], null),
      syncRun: async (o) => rec('env.syncRun', [o], { ok: true, mode: 'report', changes: 0, applied: false }),
    },
    secrets: {
      preview: async (ref) => rec('secrets.preview', [ref], { before: 'token=ghp_x', after: 'token=‹已遮蔽›', matches: [{ line: 1, kind: 'github-pat', preview: 'ghp_…' }] }),
      redact: async (ref) => rec('secrets.redact', [ref], action()),
      allow: async (ref, line) => rec('secrets.allow', [ref, line], { ok: true }),
    },
    _pending: [],
    holding: {
      list: async (o) => rec('holding.list', [o], [{ id: 'hd-20261120-101500-ab2c', status: 'held', kind: 'rejected', title: '合併兩筆重複的記憶', local: false }]),
      get: async (id) => rec('holding.get', [id], { id, status: 'held', kind: 'rejected', title: '合併兩筆重複的記憶', ops: [], evidence: [], local: false }),
      adopt: async (id) => rec('holding.adopt', [id], { ok: true, id, record: '20261120-101600-cd3e', item: 'i1', undo: ['a1b2c3d'] }),
      dismiss: async (id) => rec('holding.dismiss', [id], { ok: true, item: { id, status: 'dismissed' } }),
    },
    settings: { get: async () => rec('settings.get', [], { bindAuto: 'confident' }), set: async (o) => rec('settings.set', [o], { ok: true }) },
    claudeMdBlock: async () => rec('claudeMdBlock', [], `<!-- engram:begin · 由 Engram 管理 -->\n@~/.engram/vault/core/CORE.md\n@~/.engram/vault/machines/${machine.id}/INDEX.md\n<!-- engram:end -->\n`),
    doctor: async () => rec('doctor', [], { ok: true, checks: [{ id: 'git', ok: true, label: 'git 執行檔', detail: 'git version 2.53.0' }], findings: [finding] }),
    releaseMachine: async () => rec('releaseMachine', [], { ok: true, released: [], revokedPaths: [] }),
  };
  return eg;
}

/** 讓暫存的 app 複本可以把假引擎當成 core/index.mjs 載入（冷啟動量測用） */
export async function open(opts = {}) {
  return createFakeEngine({ home: opts.home, claudeHome: opts.claudeHome });
}
