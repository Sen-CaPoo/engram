// 專案生命週期（2.0.0 S4）。專案會越積越多，舊專案不該再佔用健康檢查、對話回顧與整理的力氣。
// - 休眠（dormant）：在任何一台電腦都沒有綁定，而且最近 90 天沒有任何對話的跡象。這是「算出來的狀態」，不改專案檔；
//   記憶完整保留、照常搜尋。重新綁定（有人在那個專案的資料夾開 Claude Code）或有新的對話，下次計算就自動恢復。
// - 合併建議：疑似同一個專案的多個代號（相同的 git 遠端或相同的根 commit），交給收件匣的 H34 卡片與 eg.projects.link。
//
// 「有沒有對話」的跡象（取最晚的一個）：
//   舊綁定退役的時間（這台電腦記的；退役之後在舊資料夾寫的對話不屬於任何專案，所以不必再翻對話紀錄）、
//   各台電腦同步來的讀取統計裡，這個專案的記憶最後被讀取的日期（對話讀了記憶才會有），以及專案本身的建立與修改時間（同步的底線，剛建立的專案不會馬上休眠）。
// 對話紀錄只在各台電腦本機，所以兩台電腦算出來的結果可能不同：另一台電腦自己退役的綁定、沒有留下讀取統計的對話，這台看不到。
import fsp from 'node:fs/promises';
import { readRetired } from './retired.mjs';
import { loadUsage } from './usage.mjs';
import { allBindingViews, listMachineIds, listProjectIds, projectMemoryDir, readBindings, readProject } from './vault.mjs';

export const DORMANT_DAYS = 90;
const DAY = 86_400_000;

const times = (list) => list.map((s) => Date.parse(s)).filter(Number.isFinite);

async function readAllBindings(ctx) {
  const out = {};
  for (const mid of await listMachineIds(ctx.vault)) out[mid] = await readBindings(ctx.vault, mid);
  return out;
}

/** pid → 有綁定它的電腦（mid 集合）。任何狀態的綁定都算（包含資料夾暫時不在、等待切換）。 */
function boundMachines(bindingsByMid) {
  const out = new Map();
  for (const [mid, bindings] of Object.entries(bindingsByMid)) {
    for (const v of allBindingViews(bindings ?? {})) {
      if (!v.pid) continue;
      if (!out.has(v.pid)) out.set(v.pid, new Set());
      out.get(v.pid).add(mid);
    }
  }
  return out;
}

/**
 * 每個專案的生命週期狀態（已合併進別的專案的不算）。
 * @param {object} ctx  引擎內部 context
 * @param {{ now?: number, projects?: Map<string, object>, bindingsByMid?: object, usage?: object, pids?: string[] }} [opts]
 *   projects、bindingsByMid、usage：呼叫端已經讀過的資料（健康檢查、專案清單）直接傳入，避免重複讀；pids：只算這幾個專案
 * @returns {Promise<Map<string, { dormant: boolean, boundOn: string[], lastActiveAt?: string|null }>>}
 *   有綁定的專案只有 dormant: false 與 boundOn；沒有綁定的專案另有 lastActiveAt（最晚的對話跡象；完全沒有跡象時是 null，而且不算休眠）
 */
export async function projectLifecycles(ctx, { now = Date.now(), projects, bindingsByMid, usage, pids } = {}) {
  const ids = pids ?? await listProjectIds(ctx.vault);
  const bound = boundMachines(bindingsByMid ?? await readAllBindings(ctx));
  const out = new Map();
  let retired = null;
  let lastRead = null; // pid → 這個專案的記憶最後被讀取的時間（各台電腦合計）
  for (const pid of ids) {
    const p = projects?.get(pid) ?? await readProject(ctx.vault, pid);
    if (!p || p.mergedInto) continue;
    if (bound.has(pid)) { out.set(pid, { dormant: false, boundOn: [...bound.get(pid)].sort() }); continue; }

    retired ??= await readRetired(ctx.local);
    const mine = retired.filter((b) => b.pid === pid);
    if (!lastRead) {
      lastRead = new Map();
      for (const [ref, u] of (usage ?? await loadUsage(ctx.vault)).refs) {
        const m = /^projects\/([^/]+)\//.exec(ref);
        const t = Date.parse(u.last ?? '');
        if (m && Number.isFinite(t) && t > (lastRead.get(m[1]) ?? 0)) lastRead.set(m[1], t);
      }
    }
    const evidence = [...times([p.createdAt, p.updatedAt, ...mine.map((b) => b.retiredAt)]), ...(lastRead.has(pid) ? [lastRead.get(pid)] : [])];
    const last = evidence.length ? Math.max(...evidence) : null;
    // 一點跡象都沒有（專案檔連建立時間都沒有）時無從證明「90 天沒有對話」，寧可不休眠
    out.set(pid, { dormant: last !== null && now - last >= DORMANT_DAYS * DAY, boundOn: [], lastActiveAt: last === null ? null : new Date(last).toISOString() });
  }
  return out;
}

/** 休眠中的專案代號 */
export async function dormantProjects(ctx, opts) {
  return new Set([...(await projectLifecycles(ctx, opts))].filter(([, v]) => v.dormant).map(([pid]) => pid));
}

async function memoryCount(ctx, pid) {
  return (await fsp.readdir(projectMemoryDir(ctx.vault, pid)).catch(() => [])).filter((n) => /\.md$/i.test(n) && !/^MEMORY\.md$/i.test(n)).length;
}

/**
 * 疑似同一個專案的多個代號。判斷依據分三級（reason）：
 * - 'remote'：兩邊記錄的 git 遠端完全一樣（把握最高，但刻意分開的兩份 clone 也會這樣）；
 * - 'shared-remote'：共用某個遠端、但各自還有別的遠端（像 fork：origin 是自己的 fork、upstream 是原專案），很可能是不同的專案；
 * - 'root-commit'：只有根 commit 相同、遠端不同（同一個樣板或 fork 出來的專案都會這樣），很可能是不同的專案。
 * 要留下的專案（to）只看會同步的資料，兩台電腦算出來一樣：被最多台電腦綁定、沒有封存、記憶最多、建立最早、代號字母序。
 * 其餘直接相關的代號各產生一個「合併到 to」的建議（from）。
 * eg.projects.link 只會把這台電腦的綁定改到目標專案，所以 from 如果在別台電腦也有綁定就不建議：
 * 那台電腦自己會看到這張卡片（它的 from 只綁在它自己）。
 * 每筆建議帶兩個專案的名稱、這台電腦上綁定的路徑、其他電腦有綁定的台數與記憶筆數，卡片用它們讓使用者看得懂風險。
 * @param {object} ctx
 * @param {{ projects?: Map<string, object>, bindingsByMid?: object }} [opts]
 * @returns {Promise<{ from: string, to: string, reason: 'remote'|'shared-remote'|'root-commit', fromName: string, toName: string, memories: { from: number, to: number }, paths: { from: string[], to: string[] }, elsewhere: { from: number, to: number } }[]>}
 */
export async function mergeCandidates(ctx, { projects, bindingsByMid } = {}) {
  const all = projects ?? new Map();
  if (!projects) for (const pid of await listProjectIds(ctx.vault)) { const p = await readProject(ctx.vault, pid); if (p) all.set(pid, p); }
  const live = [...all.values()].filter((p) => !p.mergedInto);
  const byMid = bindingsByMid ?? await readAllBindings(ctx);
  const bound = boundMachines(byMid);
  const pathsOf = (pid) => allBindingViews(byMid[ctx.mid] ?? {}).filter((v) => v.pid === pid && v.path).map((v) => v.path);
  const elsewhereOf = (pid) => [...(bound.get(pid) ?? [])].filter((mid) => mid !== ctx.mid).length;

  // 把有共同遠端或根 commit 的專案併成一組
  const parent = new Map(live.map((p) => [p.id, p.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const key of ['remotes', 'rootCommits']) {
    const owner = new Map();
    for (const p of live) {
      for (const v of new Set((p[key] ?? []).filter((s) => typeof s === 'string' && s))) {
        if (owner.has(`${key}:${v}`)) parent.set(find(p.id), find(owner.get(`${key}:${v}`)));
        else owner.set(`${key}:${v}`, p.id);
      }
    }
  }
  const groups = new Map();
  for (const p of live) {
    const r = find(p.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p);
  }

  const out = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const counts = new Map();
    for (const p of group) counts.set(p.id, await memoryCount(ctx, p.id));
    const rank = (p) => [-(bound.get(p.id)?.size ?? 0), p.archived ? 1 : 0, -counts.get(p.id), String(p.createdAt ?? ''), p.id];
    const better = (a, b) => {
      const x = rank(a); const y = rank(b);
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
      return 0;
    };
    const to = [...group].sort(better)[0];
    for (const from of group.filter((p) => p !== to).sort((a, b) => a.id.localeCompare(b.id))) {
      const list = (p, key) => [...new Set((p[key] ?? []).filter((s) => typeof s === 'string' && s))].sort();
      const [fr, tr] = [list(from, 'remotes'), list(to, 'remotes')];
      const sharedRemote = fr.some((v) => tr.includes(v));
      const sharedRoot = list(from, 'rootCommits').some((v) => list(to, 'rootCommits').includes(v));
      const reason = sharedRemote ? (fr.length === tr.length && fr.every((v, i) => v === tr[i]) ? 'remote' : 'shared-remote') : sharedRoot ? 'root-commit' : null;
      if (!reason) continue; // 只在彼此直接相關時才建議（不靠第三個專案牽線）
      if (elsewhereOf(from.id) > 0) continue;
      out.push({
        from: from.id, to: to.id, reason, fromName: from.name ?? from.id, toName: to.name ?? to.id,
        memories: { from: counts.get(from.id), to: counts.get(to.id) },
        paths: { from: pathsOf(from.id), to: pathsOf(to.id) },
        elsewhere: { from: elsewhereOf(from.id), to: elsewhereOf(to.id) },
      });
    }
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}
