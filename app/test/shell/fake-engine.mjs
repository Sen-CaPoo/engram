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
    paths: { [machine.id]: { path: 'C:\\Users\\Sen\\Desktop\\Acme_Gateway', exists: true, lastOpenedAt: AT, method: 'junction', encoded: 'C--Users-Sen-Desktop-Acme-Gateway' } },
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
        dir, root: dir, isGit: true, encoded: 'C--Users-Sen-Desktop-Acme-Gateway', pid: project.pid, confidence: 'certain', reason: 'binding',
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
      move: async (ref, scope) => rec('memories.move', [ref, scope], action()),
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
    secrets: {
      preview: async (ref) => rec('secrets.preview', [ref], { before: 'token=ghp_x', after: 'token=‹已遮蔽›', matches: [{ line: 1, kind: 'github-pat', preview: 'ghp_…' }] }),
      redact: async (ref) => rec('secrets.redact', [ref], action()),
      allow: async (ref, line) => rec('secrets.allow', [ref, line], { ok: true }),
    },
    _pending: [],
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
