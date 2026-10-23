// 展示資料產生器：把開發者的記憶盤點（記憶清單_*.md）換算成「導入 Engram 之後」的 vault 樣貌，
// 供展示版與介面開發使用。只用到盤點裡的檔名與說明，不讀取任何真實記憶的內文。
// 找不到盤點檔時回傳 null，展示版會改用 demo.js 內建的少量範例。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const NOW = new Date('2026-10-22T09:41:00+08:00');
// 版本庫裡只放通用規則；個人化的名稱對照（專案顯示名稱、搬家去向、示意內文）放在
// 同資料夾的 demo-local.json，該檔不進 git（審查 R-26：展示用的真實資料不得 commit）。
const here = dirname(fileURLToPath(import.meta.url));
const LOCAL = (() => { try { return JSON.parse(readFileSync(join(here, 'demo-local.json'), 'utf8')); } catch { return {}; } })();
const PROJECT_NAMES = LOCAL.projectNames ?? {};
const RELINK = LOCAL.relink ?? {};
const BODIES = LOCAL.bodies ?? {};
const host = os.hostname();
const SELF = { id: `${host.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 12)}-7k2q`, label: LOCAL.self?.label ?? '這台電腦', hostname: host };
const OTHER = { id: 'nb-3m9x', label: '第二台電腦（範例）', hostname: 'DEMO-NB' };
const TYPE = { 專案: 'project', 參考: 'reference', 回饋: 'feedback', 使用者: 'user' };
const B32 = '0123456789abcdefghjkmnpqrstvwxyz';

const hash = (s, n) => {
  const h = createHash('sha1').update(s).digest();
  let out = '';
  for (let i = 0; i < n; i++) out += B32[h[i] % 32];
  return out;
};
const iso = (s) => new Date(s.replace(' ', 'T') + ':00+08:00').toISOString();
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString();

function pidFor(name) {
  const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, ' ').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return ascii && ascii.length >= 2 ? `${ascii}-${hash(name, 5)}` : `p-${hash(name, 8)}`;
}

function parseInventory(md) {
  const sections = [];
  let cur = null;
  for (const line of md.split(/\r?\n/)) {
    const h = /^### \d+\. (.+)$/.exec(line);
    if (h) { cur = { path: h[1].trim(), items: [], exists: true, whereabouts: '' }; sections.push(cur); continue; }
    if (!cur) continue;
    const st = /^- 狀態：(.+)$/.exec(line);
    if (st) {
      cur.exists = !st[1].includes('不存在');
      const w = /可能去向：(.+)$/.exec(st[1]);
      cur.whereabouts = w ? w[1].trim() : '';
      continue;
    }
    const enc = /^- 記憶資料夾：`~\/\.claude\/projects\/([^/]+)\/memory\/`/.exec(line);
    if (enc) { cur.encoded = enc[1]; continue; }
    const row = /^\| (\d{4}-\d\d-\d\d \d\d:\d\d) \| (\S+) \| `([^`]+)` \| (.*) \| (.*) \|$/.exec(line);
    if (row) cur.items.push({ updated: row[1], type: TYPE[row[2]] || 'project', file: row[3], desc: row[4].trim(), note: row[5].trim() });
  }
  return sections;
}




function bodyFor(it) {
  return BODIES[it.file] || `${it.desc}\n\n> 展示版只帶入盤點裡的說明；實際導入後，這裡會顯示記憶檔的完整內文。`;
}

export function buildDemoData(rootDir) {
  const invName = existsSync(rootDir) && readdirSync(rootDir).filter((f) => /^記憶清單_\d+\.md$/.test(f)).sort().pop();
  if (!invName) return null;
  const sections = parseInventory(readFileSync(join(rootDir, invName), 'utf8'));

  const projects = new Map();
  const memories = [];
  const plan = { sources: [], totals: { sources: 0, memories: 0, copy: 0, skip: 0, global: 0, machine: 0, archived: 0, unknown: 0 } };
  const seen = new Map(); // file → ref（偵測重複）

  for (const sec of sections) {
    const base = sec.path.split('\\').pop().replace(/＊.*$/, '').trim();
    const relinked = RELINK[sec.path];
    const isDupFolder = /UTK_LLM$/.test(sec.path);
    const archived = !sec.exists && !relinked && !isDupFolder;
    const realPath = sec.exists ? sec.path : relinked || '';
    const displayBase = (realPath || sec.path).split('\\').pop();
    const name = PROJECT_NAMES[displayBase] || PROJECT_NAMES[base] || displayBase.replace(/＊.*$/, '') || base;
    const pid = isDupFolder ? pidFor('UTK_LiteLLM') : pidFor(displayBase.replace(/＊.*$/, '') || name);

    if (!isDupFolder && !projects.has(pid)) {
      const lastActivity = sec.items.reduce((a, it) => (it.updated > a ? it.updated : a), '0');
      const paths = {};
      if (realPath) paths[SELF.id] = { path: realPath, exists: true, lastOpenedAt: iso(lastActivity), method: 'junction', encoded: sec.encoded };
      if ((LOCAL.otherMachinePaths ?? []).includes(displayBase)) {
        paths[OTHER.id] = { path: `D:\\Work\\${displayBase}`, exists: true, lastOpenedAt: minutesAgo(60 * 26), method: 'junction', encoded: `D--Work-${displayBase.replace(/[^A-Za-z0-9]/g, '-')}` };
      }
      projects.set(pid, {
        pid, name, aliases: name !== displayBase ? [displayBase] : [], remotes: [],
        paths, counts: { memories: 0, findings: 0 }, lastActivityAt: iso(lastActivity), archived,
        index: { lines: 0, bytes: 0 },
      });
    }

    const src = {
      encoded: sec.encoded, resolvedPath: realPath || sec.path.replace(/^Desktop/, 'C:\\Users\\Sen\\Desktop'),
      how: sec.exists ? 'transcript-cwd' : relinked ? 'origin-session' : 'decoded',
      exists: sec.exists || !!relinked,
      target: { pid, name: isDupFolder ? 'UTK_LiteLLM 閘道' : name, isNew: !isDupFolder, archived },
      items: [],
    };

    for (const it of sec.items) {
      const slug = it.file.replace(/\.md$/, '');
      let scope, action = 'copy', reason = '';
      if (/重複/.test(it.note)) { action = 'skip-same'; reason = 'UTK_LiteLLM 已有同名而且較新的版本'; }
      if (/通用/.test(it.note)) { scope = { kind: 'global' }; reason ||= '適用所有專案'; }
      else if (/本機專屬/.test(it.note)) { scope = { kind: 'machine', mid: SELF.id }; reason ||= '描述的是這台電腦本身'; }
      else scope = { kind: 'project', pid };
      if (seen.has(it.file) && action === 'copy') { action = 'skip-same'; reason = '已有相同檔案'; }
      if (/主題重疊/.test(it.note) && action === 'copy') { action = 'merge-candidate'; reason = '與其他專案的 officecli 記憶主題重疊，建議導入後合併'; }

      const scopeName = scope.kind === 'global' ? 'global' : scope.kind === 'machine' ? 'machine' : 'project';
      src.items.push({ file: it.file, name: slug, type: it.type, action, scope: scopeName, reason, dupOf: action === 'skip-same' ? seen.get(it.file) : undefined });
      plan.totals.memories++;
      if (action === 'skip-same') { plan.totals.skip++; continue; }
      plan.totals.copy++;
      if (scopeName === 'global') plan.totals.global++;
      if (scopeName === 'machine') plan.totals.machine++;

      const dir = scope.kind === 'global' ? 'global' : scope.kind === 'machine' ? `machines/${SELF.id}` : `projects/${pid}/memory`;
      let fileName = it.file;
      if (seen.has(it.file)) fileName = it.file.replace(/\.md$/, '-2.md');
      const ref = `${dir}/${fileName}`;
      seen.set(it.file, ref);
      const big = /46KB/.test(it.note);
      const size = big ? 46 * 1024 + 310 : 600 + (parseInt(hash(it.file, 2), 32) % 2600);
      memories.push({
        ref, scope, name: slug, description: it.desc, type: it.type, size, updatedAt: iso(it.updated),
        pinned: slug === 'user-sen-context', tags: [], indexed: true, findings: [],
        body: bodyFor(it), sourceProject: name,
      });
      if (scope.kind === 'project') {
        const p = projects.get(pid);
        p.counts.memories++;
        p.index.lines += 1;
        p.index.bytes += 90 + it.desc.length * 2;
      }
    }
    if (archived) plan.totals.archived++;
    if (!src.exists) plan.totals.unknown += archived ? 1 : 0;
    plan.sources.push(src);
  }
  plan.totals.sources = plan.sources.length;
  for (const p of projects.values()) { p.index.lines += 2; p.index.bytes += 60; }
  // 已封存而且沒有留下任何專案記憶的資料夾，不需要建立專案
  const kept = [...projects.values()].filter((p) => !(p.archived && p.counts.memories === 0));
  for (const s of plan.sources) if (!kept.some((p) => p.pid === s.target.pid)) s.target.pid = null;

  return { generatedFrom: invName, now: NOW.toISOString(), self: SELF, other: OTHER, projects: kept, memories, plan };
}
