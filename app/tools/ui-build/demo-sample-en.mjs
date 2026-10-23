// 英文展示資料：全部是合成內容（不讀任何真實記憶），用來產生英文版 README 截圖。
//   node build.mjs --demo-en   → 23_介面原型_展示版.en.html（介面預設英文）
// 形狀與 demo-data.mjs 的 buildDemoData 相同：{ self, other, projects, memories, plan }
import { createHash } from 'node:crypto';

const B32 = '0123456789abcdefghjkmnpqrstvwxyz';
const hash = (s, n) => {
  const h = createHash('sha1').update(s).digest();
  let out = '';
  for (let i = 0; i < n; i++) out += B32[h[i] % 32];
  return out;
};

export function buildSampleDataEn(now = Date.now()) {
  const ago = (m) => new Date(now - m * 60000).toISOString();
  const H = 60, D = 24 * 60;
  const SELF = { id: 'office-pc-7k2q', label: 'Work PC', hostname: 'OFFICE-PC' };
  const OTHER = { id: 'home-pc-3m9x', label: 'Home PC', hostname: 'HOME-PC' };

  const P = [
    { key: 'order-service', name: 'Order service', remote: 'github.com/acme/order-service', home: true, last: 3 * H },
    { key: 'analytics-dashboard', name: 'Analytics dashboard', remote: 'github.com/acme/analytics-dashboard', home: true, last: 26 * H },
    { key: 'mobile-app', name: 'Mobile app', remote: 'github.com/acme/mobile-app', home: false, last: 2 * D },
    { key: 'data-pipeline', name: 'Data pipeline', remote: 'github.com/acme/data-pipeline', home: true, last: 4 * D },
    { key: 'marketing-site', name: 'Marketing site', remote: '', home: false, last: 9 * D },
    { key: 'release-notes', name: 'Release notes', remote: '', home: false, last: 17 * D },
  ];
  const pidOf = (key) => `${key}-${hash(key, 5)}`;
  const projects = P.map((p) => ({
    pid: pidOf(p.key), name: p.name, aliases: [], remotes: p.remote ? [p.remote] : [],
    paths: {
      [SELF.id]: { path: `C:\\Users\\Demo\\Projects\\${p.key}`, exists: true, lastOpenedAt: ago(p.last), method: 'junction', encoded: `C--Users-Demo-Projects-${p.key}` },
      ...(p.home ? { [OTHER.id]: { path: `D:\\Work\\${p.key}`, exists: true, lastOpenedAt: ago(p.last + 20 * H), method: 'junction', encoded: `D--Work-${p.key}` } } : {}),
    },
    counts: { memories: 0, findings: 0 }, lastActivityAt: ago(p.last), archived: false, index: { lines: 2, bytes: 60 },
  }));
  projects.push({
    pid: pidOf('legacy-crm'), name: 'Legacy CRM', aliases: ['legacy-crm'], remotes: [], paths: {},
    counts: { memories: 0, findings: 0 }, lastActivityAt: ago(140 * D), archived: true, index: { lines: 2, bytes: 60 },
  });

  // [範圍, 專案 key, 名稱, 類型, 說明, 幾分鐘前, 內文]
  const M = [
    ['global', '', 'user-role', 'user', 'Full-stack engineer; mainly TypeScript and Python; looks after three product lines', 3 * D,
      'Full-stack engineer. Works mainly in TypeScript (Node, React) and Python.\n\nLooks after three product lines: orders, analytics, and the mobile app.\n\n**How to apply:** Explain backend trade-offs briefly; skip basics of React and SQL.'],
    ['global', '', 'response-style', 'feedback', 'Answer with the conclusion first, then the details; keep replies short', 6 * D,
      'Lead with the answer or the decision, then the supporting details.\n\n**Why:** Reads replies between meetings.\n\n**How to apply:** One short paragraph, then a list if needed. No long preambles.'],
    ['global', '', 'git-conventions', 'feedback', 'Conventional commits; never push directly to main', 12 * D,
      'Use conventional commit messages (feat:, fix:, docs:).\n\n**Why:** Release notes are generated from the history.\n\n**How to apply:** Create a branch and open a PR; never push to main.'],
    ['global', '', 'review-checklist', 'reference', 'What to check before asking for a code review', 20 * D,
      '- Tests added or updated\n- No secrets or local paths in the diff\n- Migration has a rollback\n- Screenshots for UI changes'],
    ['global', '', 'date-format', 'feedback', 'Always write absolute dates (2026-10-22), never "yesterday"', 25 * D,
      'Write absolute dates such as 2026-10-22.\n\n**Why:** Memories are read weeks later on other computers.'],
    ['global', '', 'secrets-policy', 'feedback', 'Never store secret values; record where they are kept instead', 31 * D,
      'Do not write tokens, passwords, or connection strings into memories. Record where they are stored and how to get them (for example, the Windows Credential Manager entry name).'],
    ['project', 'order-service', 'order-status-rules', 'project', 'Order status transitions and which ones can be reverted', 50,
      'Statuses: created → paid → packed → shipped → delivered.\n\n- paid → created only within 30 minutes (payment reversal)\n- shipped can never go back\n\n**How to apply:** Check this table before changing `OrderStatus`.'],
    ['project', 'order-service', 'deploy-flow', 'project', 'Deploy flow: main deploys to staging automatically; production needs manual approval', 3 * H,
      'Merging to main deploys to staging automatically.\n\nProduction deploys need a manual approval in the pipeline (two reviewers).\n\n**How to apply:** Never suggest deploying to production from a laptop.'],
    ['project', 'order-service', 'order-api-errors', 'reference', 'Error codes returned by the order API and what they mean', 2 * D,
      '- ORD-001: payment not found\n- ORD-002: status change not allowed\n- ORD-003: stock reserved by another order'],
    ['project', 'order-service', 'order-api-pagination', 'project', 'Order API pagination uses cursors, not page numbers', 5 * D,
      'List endpoints return `next_cursor`. Page numbers were removed in v3.'],
    ['project', 'order-service', 'staging-db-access', 'reference', 'How to reach the staging DB (token for the read-only user)', 8 * D,
      'Staging database: `db-staging.internal`, port 5432, read-only user `reporter`.'],
    ['project', 'order-service', 'test-data-reset', 'project', 'How to reset test data before running integration tests', 11 * D,
      'Run `npm run db:reset -- --seed small` before integration tests. It takes about 40 seconds.'],
    ['project', 'analytics-dashboard', 'kpi-definitions', 'reference', 'KPI definitions used on the dashboard (GMV, AOV, repeat rate, churn)', 26 * H,
      KPI_BODY()],
    ['project', 'analytics-dashboard', 'chart-color-rules', 'feedback', 'Charts use the brand blue for the main series; red only for alerts', 4 * D,
      'Main series: #0072CE. Red (#E4002B) is reserved for alerts and must not be used as a regular series color.'],
    ['project', 'analytics-dashboard', 'export-settings', 'project', 'Report export path is C:\\Reports\\exports on this computer', 9 * D,
      'Scheduled exports are written to `C:\\Reports\\exports` and uploaded every night at 02:00.'],
    ['project', 'analytics-dashboard', 'timezone-handling', 'project', 'Store UTC, display in the viewer\'s time zone', 15 * D,
      'All timestamps are stored in UTC. Convert only in the UI layer.'],
    ['project', 'mobile-app', 'release-checklist', 'project', 'Mobile release checklist (store screenshots, version bump, changelog)', 2 * D,
      '1. Bump the version in both platforms\n2. Update store screenshots\n3. Write the changelog\n4. Tag the release'],
    ['project', 'mobile-app', 'push-notifications', 'project', 'Push notification limits: at most 2 marketing pushes per week', 6 * D,
      'Marketing pushes are capped at 2 per week per user. Transactional pushes are not limited.'],
    ['project', 'mobile-app', 'review-feedback', 'feedback', 'Keep PRs under 400 changed lines so reviews stay fast', 13 * D,
      'Split large changes into several PRs of under 400 lines.\n\n**Why:** Reviews of big PRs take days.'],
    ['project', 'data-pipeline', 'pipeline-schedule', 'project', 'Nightly pipeline runs at 01:30 and must finish before 06:00', 4 * D,
      'The nightly job starts at 01:30. Downstream reports read the results at 06:00.'],
    ['project', 'data-pipeline', 'pipeline-retries', 'project', 'Failed steps retry three times with exponential backoff', 18 * D,
      'Each step retries three times (1, 4, 16 minutes).'],
    ['project', 'data-pipeline', 'naming-feedback', 'feedback', 'Name tables with the source system as prefix', 22 * D,
      'Table names start with the source system, for example `crm_customers`.'],
    ['project', 'marketing-site', 'seo-rules', 'project', 'SEO rules: one H1 per page, descriptive alt text, canonical URLs', 9 * D,
      'One H1 per page. Every image needs descriptive alt text. Set canonical URLs on campaign pages.'],
    ['project', 'marketing-site', 'cms-workflow', 'project', 'Content goes through the CMS draft → review → publish workflow', 30 * D,
      'Editors publish only after a review in the CMS.'],
    ['project', 'release-notes', 'release-notes-style', 'feedback', 'Release notes: user-facing language, newest first', 17 * D,
      'Write release notes for users, not developers. Newest version first.'],
    ['project', 'release-notes', 'old-template', 'reference', 'Old release note template (replaced in 2025)', 120 * D,
      'The 2024 template with a "Known issues" section at the top.'],
    ['project', 'legacy-crm', 'crm-export-format', 'reference', 'Export format of the old CRM (CSV, semicolon separated)', 140 * D,
      'CSV with `;` separators and Windows-1252 encoding.'],
    ['machine', '', 'node-install-path', 'reference', 'Node.js 22 is installed with fnm; global packages live in the fnm folder', 7 * D,
      'Node.js 22 via fnm. Global npm packages are under `%LOCALAPPDATA%\\fnm_multishells`.'],
    ['machine', '', 'proxy-settings', 'reference', 'Office network proxy for git and npm', 16 * D,
      'git and npm use the office proxy `http://proxy.acme.local:8080`.'],
    ['machine', '', 'disk-layout', 'reference', 'C: is the system SSD; large repos and Docker data live on D:', 40 * D,
      'Keep large repositories and Docker data on D: to save space on C:.'],
  ];

  const memories = [];
  for (const [kind, key, name, type, description, minutes, body] of M) {
    const scope = kind === 'global' ? { kind } : kind === 'machine' ? { kind, mid: SELF.id } : { kind, pid: pidOf(key) };
    const dir = kind === 'global' ? 'global' : kind === 'machine' ? `machines/${SELF.id}` : `projects/${scope.pid}/memory`;
    const size = name === 'kpi-definitions' ? 46 * 1024 + 310 : 500 + (parseInt(hash(name, 2), 32) % 2200);
    memories.push({
      ref: `${dir}/${name}.md`, scope, name, description, type, size, updatedAt: ago(minutes),
      pinned: name === 'user-role', tags: [], indexed: true, findings: [], body,
    });
    if (kind === 'project') {
      const p = projects.find((x) => x.pid === scope.pid);
      p.counts.memories++;
      p.index.lines++;
      p.index.bytes += 90 + description.length;
    }
  }

  // 匯入計畫（合成）：三個來源，其中一個原資料夾已不存在
  const item = (file, type, action, scope, reason, dupOf) => ({ file, name: file.replace(/\.md$/, ''), type, action, scope, reason, ...(dupOf ? { dupOf } : {}) });
  const plan = {
    sources: [
      {
        encoded: 'C--Users-Demo-Projects-order-service', resolvedPath: 'C:\\Users\\Demo\\Projects\\order-service', how: 'transcript-cwd', exists: true,
        target: { pid: pidOf('order-service'), name: 'Order service', isNew: true, archived: false },
        items: [
          item('order-status-rules.md', 'project', 'copy', 'project', ''),
          item('deploy-flow.md', 'project', 'copy', 'project', ''),
          item('response-style.md', 'feedback', 'copy', 'global', 'Applies to all projects'),
          item('order-api-errors.md', 'reference', 'copy', 'project', ''),
          item('staging-db-access.md', 'reference', 'copy', 'project', ''),
        ],
      },
      {
        encoded: 'C--Users-Demo-Projects-analytics-dashboard', resolvedPath: 'C:\\Users\\Demo\\Projects\\analytics-dashboard', how: 'origin-session', exists: true,
        target: { pid: pidOf('analytics-dashboard'), name: 'Analytics dashboard', isNew: true, archived: false },
        items: [
          item('kpi-definitions.md', 'reference', 'copy', 'project', ''),
          item('chart-color-rules.md', 'feedback', 'copy', 'project', ''),
          item('response-style.md', 'feedback', 'skip-same', 'global', 'The same content is already in another source of this import', 'global/response-style.md'),
          item('node-install-path.md', 'reference', 'copy', 'machine', 'Describes this computer itself'),
        ],
      },
      {
        encoded: 'C--Users-Demo-Projects-legacy-crm', resolvedPath: 'C:\\Users\\Demo\\Projects\\legacy-crm', how: 'decoded', exists: false,
        target: { pid: pidOf('legacy-crm'), name: 'Legacy CRM', isNew: true, archived: true },
        items: [
          item('crm-export-format.md', 'reference', 'copy', 'project', ''),
          item('old-template.md', 'reference', 'superseded', 'project', 'Older version; the content stays where it is', 'projects/release-notes/memory/old-template.md'),
        ],
      },
    ],
    totals: { sources: 3, memories: 11, copy: 9, skip: 2, global: 1, machine: 1, archived: 1, unknown: 1 },
  };
  for (const s of plan.sources) for (const it of s.items) if (it.reason) it.en = { reason: it.reason };

  return { generatedFrom: 'demo-sample-en.mjs', lang: 'en', now: new Date(now).toISOString(), self: SELF, other: OTHER, projects, memories, plan };
}

function KPI_BODY() {
  const rows = [
    ['GMV', 'Gross merchandise value: sum of paid order totals, before refunds'],
    ['AOV', 'Average order value: GMV divided by the number of paid orders'],
    ['Repeat rate', 'Share of customers with two or more orders in the period'],
    ['Churn', 'Customers with no order in the last 180 days'],
  ];
  const table = ['| KPI | Definition |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
  const notes = Array.from({ length: 40 }, (_, i) => `- Note ${i + 1}: edge cases for refunds, partial shipments, and currency conversion are handled in the nightly job.`).join('\n');
  return `${table}\n\n## Edge cases\n\n${notes}`;
}
