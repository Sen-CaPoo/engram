// 健康檢查 H01–H18（40 號文件 §13）。只用規則判斷，不呼叫 AI；結果是「建議」，附可執行的 fix。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { machineSpecific } from './classify.mjs';
import { diagEn, semanticKey } from './frontmatter.mjs';
import { exists, readJson, readText, sha1 } from './fsx.mjs';
import { readSweepLog } from './sweep.mjs';
import { JUNCTION_MODES, junctionState } from './identity.mjs';
import { defaultPermissionMode, isJunctionReadAllowed } from './claudesettings.mjs';
import { indexStats, PROJECT_INDEX, SCOPE_INDEX } from './normalize.mjs';
import { brokenLinks } from './links.mjs';
import { coverageDays, loadUsage } from './usage.mjs';
import { needsBaseline, pendingReviews } from './review.mjs';
import { dreamStatus } from './dream.mjs';
import { suggestionsFor } from './coresuggest.mjs';
import { uncheckedDays, volatility } from './volatile.mjs';
import { loadAllow, scanWithAllow } from './secretallow.mjs';
import { encodeProjectPath, memoryRootFor, samePath } from './paths.mjs';
import { scanAll, sessionIndex } from './transcripts.mjs';
import { allBindingViews, listMachineIds, listProjectIds, machineDir, memoryOwners, projectMemoryDir, readBindings, readProject, readState } from './vault.mjs';

const DAY = 86_400_000;
const LIMITS = { indexLines: 200, indexBytes: 25 * 1024, indexWarn: 150, fileWarn: 8 * 1024, fileHigh: 20 * 1024, coreLines: 200, coreBytes: 25 * 1024, coreBytesWarn: 20 * 1024 };

function fid(code, refs) {
  return `${code}:${createHash('sha1').update(refs.join('|')).digest('hex').slice(0, 10)}`;
}

/**
 * key：refs 相同但對象不同時（例如每個綁定都指向 bindings.json），用來區分 id，避免「忽略」一張卡片連帶蓋掉別張。
 * en：英文版 { title, detail }（管理介面切到英文時顯示）；fix 的英文放在 fix.en.label。id 一律以中文標題計算。
 */
function finding(code, severity, title, detail, { refs = [], pid, fix, key, en } = {}) {
  return { id: fid(code, key ? [key] : refs.length ? refs : [title]), code, severity, title, detail, refs, ...(pid ? { pid } : {}), ...(fix ? { fix } : {}), ...(en ? { en } : {}) };
}

/** 中英文都適用的雙字組集合（用於描述相似度）。 */
function bigrams(s) {
  const t = String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function jaccardSet(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// 英文版：H12 的說明用 frontmatter.mjs 的 diagEn 翻譯解析錯誤；H06、H08 用 rename.mjs 的 BLOCKED_LABEL_EN、classify.mjs 的 reasonsEn。
const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1);



/**
 * @param {object} ctx  引擎內部 context
 * @param {{ memories: object[], now?: number }} input  memories 為 scanAllMemories 的結果（含 _parsed）
 */
export async function runHealth(ctx, { memories, now = Date.now() }) {
  const out = [];
  const projects = new Map();
  for (const pid of await listProjectIds(ctx.vault)) projects.set(pid, await readProject(ctx.vault, pid));
  const mids = await listMachineIds(ctx.vault);
  const hostnames = [os.hostname()];
  const machines = new Map(); // mid → { hostname, label }
  for (const mid of mids) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(machineDir(ctx.vault, mid), 'machine.json'), 'utf8'));
      if (m.hostname) hostnames.push(m.hostname);
      machines.set(mid, { hostname: m.hostname ?? null, label: m.label ?? mid });
    } catch { /* ignore */ }
  }
  // H08 的「改為單機記憶」要放到這筆記憶所屬的那台電腦，不是執行檢查的這台：
  // 內文提到某台電腦的主機名稱就是那一台，否則是把它寫進 vault 的那一台。都不知道時不提供一鍵修正。
  let addedBy = null;
  const ownerOf = async (ref, text) => {
    for (const [mid, m] of machines) {
      if (m.hostname && m.hostname.length >= 4 && new RegExp(`\\b${escapeRe(m.hostname)}\\b`, 'i').test(text)) return mid;
    }
    addedBy ??= await memoryOwners(ctx.vault, ctx.mid);
    const mid = addedBy.get(ref);
    return mid && machines.has(mid) ? mid : null;
  };
  const bindings = await readBindings(ctx.vault, ctx.mid);
  const scans = await scanAll(ctx.homes.claudeHome);
  const scanByEnc = new Map(scans.map((s) => [s.encoded.toLowerCase(), s]));

  // H01：專案索引超過載入上限
  for (const [pid, p] of projects) {
    const st = await indexStats(path.join(projectMemoryDir(ctx.vault, pid), PROJECT_INDEX));
    const ref = `projects/${pid}/memory/${PROJECT_INDEX}`;
    if (st.lines > LIMITS.indexLines || st.bytes > LIMITS.indexBytes) {
      out.push(finding('H01', 'high', `「${p?.name ?? pid}」的記憶索引超過載入上限`,
        `MEMORY.md 有 ${st.lines} 行、${(st.bytes / 1024).toFixed(1)}KB；Claude Code 只載入前 200 行或 25KB，之後的記憶不會被看到。建議合併或封存。`,
        {
          refs: [ref], pid, fix: { action: 'open-project', args: { pid }, label: '開啟專案整理', en: { label: 'Open project cleanup' } },
          en: {
            title: `The memory index for "${p?.name ?? pid}" is over the load limit`,
            detail: `MEMORY.md has ${st.lines} lines and ${(st.bytes / 1024).toFixed(1)}KB. Claude Code loads only the first 200 lines or 25KB, so memories after that are not seen. Consider merging or archiving some.`,
          },
        }));
    } else if (st.lines >= LIMITS.indexWarn) {
      out.push(finding('H01', 'low', `「${p?.name ?? pid}」的記憶索引接近上限`, `MEMORY.md 已有 ${st.lines} 行（上限 200 行）。`, {
        refs: [ref], pid,
        en: { title: `The memory index for "${p?.name ?? pid}" is close to the limit`, detail: `MEMORY.md already has ${st.lines} lines (limit: 200).` },
      }));
    }
  }

  // H02／H03：索引與檔案不一致（正規化會自動修好）
  const unindexed = memories.filter((m) => !m.indexed);
  if (unindexed.length) {
    out.push(finding('H03', 'auto', `${unindexed.length} 筆記憶不在索引裡`, '下次同步時會自動補上。', {
      refs: unindexed.map((m) => m.ref), fix: { action: 'normalize', args: {}, label: '立即整理索引', en: { label: 'Tidy index now' } },
      en: { title: `${unindexed.length === 1 ? '1 memory is' : `${unindexed.length} memories are`} not in the index`, detail: 'They will be added automatically on the next sync.' },
    }));
  }

  // H04：綁定的資料夾不見了；H17：junction 失效
  for (const b of allBindingViews(bindings)) {
    const name = projects.get(b.pid)?.name ?? b.pid;
    if (!exists(b.path)) {
      out.push(finding('H04', 'medium', `「${name}」在這台電腦的資料夾不見了`, `原路徑 ${b.path} 已不存在（可能搬家或改名）。在新位置開啟 Claude Code 時會自動重新連結。`,
        {
          refs: [`machines/${ctx.mid}/bindings.json`], pid: b.pid, key: `${b.key}:missing`, fix: { action: 'forget-binding', args: { encoded: b.key }, label: '移除這個舊綁定', en: { label: 'Remove this old binding' } },
          en: {
            title: `The folder for "${name}" is gone on this computer`,
            detail: `The original path ${b.path} no longer exists (it may have been moved or renamed). Engram will reconnect it automatically when you open Claude Code in the new location.`,
          },
        }));
      continue;
    }
    // R-54：舊版從 git 子資料夾第一次開啟時，綁定放在子資料夾的編碼（Claude Code 用的是根目錄的編碼）
    const want = encodeProjectPath(b.path);
    if (want && want.toLowerCase() !== b.encoded.toLowerCase()) {
      out.push(finding('H17', 'high', `「${name}」的記憶連結建在錯誤的位置`, '之前第一次從子資料夾開啟這個專案時，記憶連結建在子資料夾的位置，Claude Code 不會從那裡讀寫記憶；從子資料夾開啟時寫的記憶沒有進入 Engram（會出現在「尚未納管的記憶」）。',
        {
          refs: [`machines/${ctx.mid}/bindings.json`], pid: b.pid, key: `${b.key}:encoding`, fix: { action: 'reconcile-bindings', args: {}, label: '修正連結位置', en: { label: 'Fix link location' } },
          en: {
            title: `The memory link for "${name}" is in the wrong place`,
            detail: 'When this project was first opened from a subfolder, the memory link was created at the subfolder\'s location. Claude Code does not read or write memory from there, so memories written while the project was open from a subfolder never reached Engram (they will show up under "unmanaged memories").',
          },
        }));
      continue;
    }
    if (b.method === 'junction' && b.state !== 'pending') {
      const j = junctionState(ctx.homes, b.encoded, b.pid);
      if (j.state !== 'ok') {
        out.push(finding('H17', 'high', `「${name}」的記憶連結失效`, `Claude Code 的記憶資料夾狀態為 ${j.state}，新寫入的記憶可能沒有進入 Engram。`,
          {
            refs: [`machines/${ctx.mid}/bindings.json`], pid: b.pid, key: `${b.key}:broken`, fix: { action: 'rebind', args: { dir: b.path }, label: '重新建立連結', en: { label: 'Recreate link' } },
            en: {
              title: `The memory link for "${name}" is broken`,
              detail: `The status of Claude Code's memory folder is ${j.state}. Newly written memories may not have reached Engram.`,
            },
          }));
      } else if (!(await isJunctionReadAllowed(ctx.homes, j.path))) {
        out.push(finding('H17', 'medium', `「${name}」讀取記憶時會跳出權限詢問`, '這個記憶連結還沒列入 Claude Code 的 additionalDirectories，互動模式下每次讀取都會詢問。',
          {
            refs: [`machines/${ctx.mid}/bindings.json`], pid: b.pid, key: `${b.key}:read`, fix: { action: 'allow-read', args: { encoded: b.encoded }, label: '允許讀取', en: { label: 'Allow reading' } },
            en: {
              title: `Reading memory for "${name}" will trigger a permission prompt`,
              detail: 'This memory link is not in Claude Code\'s additionalDirectories yet, so in interactive mode it asks for permission every time it is read.',
            },
          }));
      }
    }
    if (b.state === 'pending') {
      out.push(finding('H17', 'low', `「${name}」等待切換到 Engram`, '原本的記憶資料夾還有內容或有進行中的對話，對話結束後會自動切換。',
        {
          refs: [`machines/${ctx.mid}/bindings.json`], pid: b.pid, key: `${b.key}:pending`, fix: { action: 'rebind', args: { dir: b.path }, label: '現在切換', en: { label: 'Switch now' } },
          en: {
            title: `"${name}" is waiting to switch to Engram`,
            detail: 'The original memory folder still has content or an active conversation. It will switch automatically when the conversation ends.',
          },
        }));
    }
  }

  // H17：預設權限模式不允許 junction，卻還有 junction 綁定（常駐程式的 reconcile 還沒處理到）。
  // 2.1.306 實測（E21）：junction 在 default／acceptEdits 下讀寫都會詢問；settings.local 在所有模式都不會。
  // 不替使用者改權限模式，只把綁定收斂成設定檔。
  // 每個專案各自判斷：團隊 repo 可能在專案層的 .claude/settings.json 設了 defaultMode
  const blocked = [];
  for (const b of allBindingViews(bindings)) {
    if (b.method !== 'junction' || !exists(b.path)) continue;
    const mode = await defaultPermissionMode(ctx.homes, b.path);
    if (!JUNCTION_MODES.has(mode)) blocked.push(mode ?? 'default');
  }
  if (blocked.length) {
    out.push(finding('H17', 'medium', '讀寫記憶時會跳出權限詢問',
      `Claude Code 的預設權限模式是 ${[...new Set(blocked)].join('、')}。在這個模式下，透過記憶連結（junction）讀寫記憶都會詢問；用專案設定檔指向記憶庫則不會。按「改用設定檔連結」後，從專案根目錄啟動就不會再詢問；從子資料夾啟動時則不會用到 Engram 的記憶。影響 ${blocked.length} 個專案。`,
      {
        refs: [`machines/${ctx.mid}/bindings.json`], key: 'write-permission', fix: { action: 'reconcile-bindings', args: {}, label: '改用設定檔連結', en: { label: 'Use settings-file links' } },
        en: {
          title: 'Reading and writing memory will trigger permission prompts',
          detail: `Claude Code's default permission mode is ${[...new Set(blocked)].join(', ')}. In this mode, reading or writing memory through the memory link (junction) always asks for permission; pointing to the vault from the project settings file does not. After you press "Use settings-file links", launching from the project root no longer asks; launching from a subfolder will not use Engram's memory. Affects ${count(blocked.length, 'project', 'projects')}.`,
        },
      }));
  }

  // H05：尚未納管的記憶（已收編且內容沒變的檔案不再回報）；H06：中文路徑碰撞
  const swept = await readSweepLog(ctx.local);
  const views = allBindingViews(bindings);
  for (const s of scans) {
    // 只有 junction 綁定（含等待切換）代表這個資料夾由 Engram 接管；設定檔備援的撞名資料夾仍可能有未納管的記憶
    const bound = views.some((v) => v.method === 'junction' && v.encoded.toLowerCase() === s.encoded.toLowerCase());
    if (!s.memory.isJunction && !bound) {
      const known = new Map((swept[s.encoded]?.files ?? []).map((f) => [f.file.toLowerCase(), f.sha1]));
      const pending = [];
      for (const f of s.memory.files.filter((n) => !/^MEMORY\.md$/i.test(n))) {
        const prevHash = known.get(f.toLowerCase());
        if (prevHash) {
          const t = await readText(path.join(s.memory.path, f));
          if (t !== null && sha1(t) === prevHash) continue;
        }
        pending.push(f);
      }
      if (pending.length) {
        out.push(finding('H05', 'medium', `發現尚未納管的記憶：${s.roots[0] ?? s.encoded}`,
          `${pending.length} 筆記憶還在 Claude Code 的本機資料夾，不會同步。`,
          {
            refs: [s.encoded], fix: { action: 'sweep', args: { encoded: s.encoded }, label: '收編到 Engram', en: { label: 'Adopt into Engram' } },
            en: {
              title: `Unmanaged memories found: ${s.roots[0] ?? s.encoded}`,
              detail: `${pending.length === 1 ? '1 memory is' : `${pending.length} memories are`} still in Claude Code's local folder and will not sync.`,
            },
          }));
      }
    }
  }
  // H06：撞名（SW-4）。用過 Claude Code 的資料夾和現存的其他資料夾編碼相同；依命名規則「原名-4 碼代號」改名即可分開。
  // 兩個以上用過的資料夾共用同一份紀錄（記憶與對話已經在混）為高，其餘為中。refs 沿用編碼名稱，忽略的紀錄不受影響
  const { planCollisionRenames, BLOCKED_LABEL, BLOCKED_LABEL_EN } = await import('./rename.mjs');
  const groups = new Map();
  for (const it of await planCollisionRenames(ctx, { indexMaxAgeMs: 3_600_000 })) {
    if (!groups.has(it.encoded.toLowerCase())) groups.set(it.encoded.toLowerCase(), []);
    groups.get(it.encoded.toLowerCase()).push(it);
  }
  for (const items of groups.values()) {
    const ready = items.filter((it) => it.to && !it.blocked);
    const lines = items.map((it) => (it.to ? `${it.path} → ${path.basename(it.to)}` : `${it.path}（暫不改名：${BLOCKED_LABEL[it.blocked] ?? it.blocked}）`));
    const linesEn = items.map((it) => (it.to ? `${it.path} → ${path.basename(it.to)}` : `${it.path} (not renamed for now: ${BLOCKED_LABEL_EN[it.blocked] ?? it.blocked})`));
    out.push(finding('H06', items.length > 1 ? 'high' : 'medium', items.length > 1 ? '資料夾名稱碰撞：多個資料夾共用同一份 Claude Code 紀錄' : `資料夾名稱碰撞：${path.basename(items[0].path)} 與其他資料夾在 Claude Code 裡同名`,
      `${lines.join('；')}。Claude Code 把中文與符號都換成「-」，這些資料夾與 ${items[0].others.map((o) => path.basename(o)).join('、')} 編碼相同（${items[0].encoded}）。依命名規則在原名後加 4 碼代號即可分開；改名後重新綁定、記憶裡的舊路徑一併更新，可以整批還原。改名前的對話不會出現在 /resume 清單。`,
      {
        refs: [items[0].encoded],
        ...(ready.length ? { fix: { action: 'rename-collisions', args: { paths: ready.map((it) => it.path) }, label: '依命名規則改名', en: { label: 'Rename by naming rule' } } } : {}),
        en: {
          title: items.length > 1 ? 'Colliding folders: several folders share one Claude Code history' : `Colliding folders: ${path.basename(items[0].path)} has the same name as other folders in Claude Code`,
          detail: `${linesEn.join('; ')}. Claude Code replaces Chinese characters and symbols with "-", so these folders get the same encoded name as ${items[0].others.map((o) => path.basename(o)).join(', ')} (${items[0].encoded}). Adding a 4-character code after the original name (the naming rule) tells them apart. After renaming, Engram rebinds the folders and updates old paths inside memories, and the whole batch can be restored. Conversations from before the rename will not appear in the /resume list.`,
        },
      }));
  }
  void scanByEnc;

  // H19：撞名期間被寫進別的專案的記憶（R-25）。依 originSessionId 找出寫入當時的資料夾，與綁定路徑不同就提示。
  const sessIdx = sessionIndex(scans);
  const { renamedPathMapper } = await import('./rename.mjs');
  const mapRenamed = await renamedPathMapper(ctx); // 改名前的對話紀錄寫的是舊路徑（SW-4）
  for (const m of memories) {
    if (m.scope?.kind !== 'project') continue;
    const origin = m._parsed?.data?.metadata?.originSessionId;
    const cwd = origin ? sessIdx.get(String(origin)) : null;
    if (!cwd) continue;
    const root = mapRenamed(memoryRootFor(cwd).root);
    const mine = views.filter((v) => v.pid === m.scope.pid);
    if (!mine.length || mine.some((v) => samePath(v.path, root))) continue;
    // 只在「同一個編碼」時才是撞名造成的；其他情況可能只是同專案的另一份 clone
    const enc = encodeProjectPath(root);
    if (!mine.some((v) => v.encoded.toLowerCase() === String(enc).toLowerCase())) continue;
    out.push(finding('H19', 'medium', `「${m.name}」可能屬於另一個資料夾`, `這筆記憶是在 ${root} 寫下的，但目前放在「${projects.get(m.scope.pid)?.name ?? m.scope.pid}」。兩個資料夾在 Claude Code 內部撞名，寫入時被混在一起。`,
      {
        refs: [m.ref], pid: m.scope.pid, fix: { action: 'reassign', args: { ref: m.ref, root }, label: `移到 ${path.basename(root)}`, en: { label: `Move to ${path.basename(root)}` } },
        en: {
          title: `"${m.name}" may belong to another folder`,
          detail: `This memory was written in ${root}, but it is currently under "${projects.get(m.scope.pid)?.name ?? m.scope.pid}". The two folders collide inside Claude Code, so their writes got mixed together.`,
        },
      }));
  }

  // H07：可能重複。不同電腦各自的單機記憶同名或相同不算重複：每台電腦本來就各記一份自己的環境（合併會讓其中一台失去它）
  const perMachine = (ms) => ms.every((m) => m.scope?.kind === 'machine') && new Set(ms.map((m) => m.scope.mid)).size === ms.length;
  const byKey = new Map();
  for (const m of memories) {
    const k = semanticKey(m._parsed);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(m);
  }
  const reported = new Set();
  for (const g of byKey.values()) {
    // 只列出彼此可以比的：例如同一台的兩筆＋另一台的一筆，另一台那筆不算進來（合併不可以併掉別台的那份）
    const group = g.filter((m) => g.some((n) => n !== m && !perMachine([m, n])));
    if (group.length < 2) continue;
    const refs = group.map((m) => m.ref).sort();
    refs.forEach((r) => reported.add(r));
    out.push(finding('H07', 'medium', `${group.length} 筆內容相同的記憶`, group.map((m) => m.ref).join('、'), {
      refs, fix: { action: 'merge', args: { refs }, label: '合併', en: { label: 'Merge' } },
      en: { title: `${group.length} memories with identical content`, detail: group.map((m) => m.ref).join(', ') },
    }));
  }
  const bg = memories.map((m) => ({ m, b: bigrams(`${m.name} ${m.description}`) }));
  for (let i = 0; i < bg.length; i++) {
    for (let j = i + 1; j < bg.length; j++) {
      const a = bg[i]; const b = bg[j];
      if ((reported.has(a.m.ref) && reported.has(b.m.ref)) || perMachine([a.m, b.m])) continue;
      const sameName = a.m.name && a.m.name === b.m.name;
      const sim = jaccardSet(a.b, b.b);
      if (sameName || sim >= 0.6) {
        const refs = [a.m.ref, b.m.ref].sort();
        out.push(finding('H07', 'medium', `可能重複：${a.m.name}`, `${sameName ? '名稱相同' : `描述相似度 ${(sim * 100).toFixed(0)}%`}：${refs.join('、')}`, {
          refs, fix: { action: 'merge', args: { refs }, label: '並排比對與合併', en: { label: 'Compare side by side and merge' } },
          en: { title: `Possible duplicate: ${a.m.name}`, detail: `${sameName ? 'Same name' : `Description similarity ${(sim * 100).toFixed(0)}%`}: ${refs.join(', ')}` },
        }));
      }
    }
  }

  // H08、H09、H10、H11、H12、H13：逐筆檢查
  const allow = await loadAllow(ctx.local);
  for (const m of memories) {
    const text = await readText(path.join(ctx.vault, ...m.ref.split('/'))) ?? '';
    const pid = m.scope?.kind === 'project' ? m.scope.pid : undefined;
    if (m.scope?.kind !== 'machine') {
      const sig = machineSpecific({ type: m.type, text, hostnames });
      if (sig.yes) {
        const owner = await ownerOf(m.ref, text);
        const label = owner ? machines.get(owner).label : null;
        out.push(finding('H08', 'medium', `「${m.name}」看起來只適用${label ? `「${label}」` : '某台電腦'}`,
          `偵測到：${sig.reasons.join('、')}。放在共用範圍時，另一台電腦也會讀到。${owner ? '' : '無法判斷是哪一台電腦的事實，請在記憶庫手動搬移到對應電腦的單機範圍。'}`,
          {
            refs: [m.ref], pid, ...(owner ? { fix: { action: 'move', args: { ref: m.ref, scope: { kind: 'machine', mid: owner } }, label: `改為「${label}」的單機記憶`, en: { label: `Change to a machine memory for "${label}"` } } } : {}),
            en: {
              title: `"${m.name}" seems to apply only to ${label ? `"${label}"` : 'one computer'}`,
              detail: `Detected: ${sig.reasonsEn.join(', ')}. In a shared scope, the other computer will read it too.${owner ? '' : ' Engram cannot tell which computer this fact belongs to, so move it by hand in the Library to that computer\'s machine scope.'}`,
            },
          }));
      }
    }
    if (m.scope?.kind === 'project' && ['user', 'feedback'].includes(m.type)) {
      out.push(finding('H09', 'low', `「${m.name}」可能適用所有專案`, `類型為 ${m.type}，通常是跨專案成立的偏好或做法。`, {
        refs: [m.ref], pid, fix: { action: 'move', args: { ref: m.ref, scope: { kind: 'global' } }, label: '升級為全域', en: { label: 'Promote to Global' } },
        en: { title: `"${m.name}" may apply to all projects`, detail: `Its type is ${m.type}, which usually means a preference or practice that holds across projects.` },
      }));
    }
    if (m.size > LIMITS.fileHigh) {
      out.push(finding('H10', 'medium', `「${m.name}」檔案過大`, `${(m.size / 1024).toFixed(1)}KB；被讀取時會佔用大量上下文。建議請 Claude 拆分或精簡。`, {
        refs: [m.ref], pid,
        en: { title: `"${m.name}" is too large`, detail: `${(m.size / 1024).toFixed(1)}KB. Reading it uses a lot of context. Ask Claude to split or trim it.` },
      }));
    } else if (m.size > LIMITS.fileWarn) {
      out.push(finding('H10', 'low', `「${m.name}」檔案偏大`, `${(m.size / 1024).toFixed(1)}KB（建議 8KB 以內）。`, {
        refs: [m.ref], pid,
        en: { title: `"${m.name}" is fairly large`, detail: `${(m.size / 1024).toFixed(1)}KB (8KB or less is recommended).` },
      }));
    }
    const updated = Date.parse(m.updatedAt ?? '') || 0;
    if (pid && updated && now - updated > 90 * DAY) {
      const last = Math.max(0, ...scans.filter((s) => Object.values(bindings).some((b) => b.pid === pid && b.path && s.roots.some((r) => r.toLowerCase() === b.path.toLowerCase()))).map((s) => s.lastActivityMs));
      if (!last || now - last > 60 * DAY) {
        out.push(finding('H11', 'low', `「${m.name}」可能已過時`, `超過 90 天沒有更新，所屬專案也超過 60 天沒開。`, {
          refs: [m.ref], pid, fix: { action: 'remove', args: { ref: m.ref }, label: '封存（可從歷史還原）', en: { label: 'Archive (can be restored from history)' } },
          en: { title: `"${m.name}" may be outdated`, detail: 'Not updated in over 90 days, and its project has not been opened in over 60 days.' },
        }));
      }
    }
    if (m._parsed?.errors?.length) {
      out.push(finding('H12', 'medium', `「${m.name}」的 frontmatter 格式有誤`, `${m._parsed.errors.slice(0, 2).join('；')}。Engram 不會自動改寫這筆記憶，請用原始碼模式修正。`, {
        refs: [m.ref], pid, fix: { action: 'edit', args: { ref: m.ref, raw: true }, label: '修正格式', en: { label: 'Fix format' } },
        en: {
          title: `The frontmatter of "${m.name}" is malformed`,
          detail: `${m._parsed.errors.slice(0, 2).map((e) => sentence(diagEn(e))).join('; ')}. Engram will not rewrite this memory automatically; fix it in raw mode.`,
        },
      }));
    } else if (!m._parsed?.data?.name || !m._parsed?.data?.description || !m.type) {
      out.push(finding('H12', 'medium', `「${m.name}」的 frontmatter 不完整`, '缺少 name、description 或 metadata.type，可能不會被正確索引。', {
        refs: [m.ref], pid, fix: { action: 'edit', args: { ref: m.ref }, label: '補上欄位', en: { label: 'Add missing fields' } },
        en: { title: `The frontmatter of "${m.name}" is incomplete`, detail: 'name, description, or metadata.type is missing, so it may not be indexed correctly.' },
      }));
    }
    const secrets = scanWithAllow(text, m.ref, allow);
    if (secrets.length) {
      out.push(finding('H13', 'high', `「${m.name}」疑似含有金鑰或密碼`, `${secrets.map((s) => `第 ${s.line} 行 ${s.kind}（${s.preview}）`).join('；')}。此檔案不會同步，也不會列在索引裡（之後的對話看不到它），直到改成記錄「存放位置」。`, {
        refs: [m.ref], pid, fix: { action: 'edit', args: { ref: m.ref, lines: secrets.map((s) => s.line) }, label: '移除金鑰', en: { label: 'Remove secret' } },
        en: {
          title: `"${m.name}" may contain a secret or password`,
          detail: `${secrets.map((s) => `line ${s.line} ${s.kind} (${s.preview})`).join('; ')}. This file will not sync and is left out of the index (later conversations cannot see it) until you record where the secret is stored instead.`,
        },
      }));
    }
  }

  // H20：建議回顧對話（1.4.0）。這台電腦綁定的專案有還沒回顧的對話，而且最早的那個 7 天內會被 Claude Code 清除，
  // 或有容易過時的記憶超過 30 天沒確認。對話紀錄是驗證記憶的依據，清除後就無法回頭對照。
  const dreamPids = [...new Set(views.map((v) => v.pid).filter(Boolean))];
  for (const pid of dreamPids) {
    const p = projects.get(pid);
    if (!p || p.archived || p.mergedInto) continue;
    const st = await dreamStatus(ctx, pid, { scans, now });
    if (!st.pending) continue;
    const stale = memories.filter((m) => m.scope?.kind === 'project' && m.scope.pid === pid && volatility(m, m._parsed?.body).yes && (uncheckedDays(m, now) ?? 0) > 30);
    const expiring = st.expiresInDays !== null && st.expiresInDays <= 7;
    if (!expiring && !stale.length) continue;
    const name = p.name ?? pid;
    const parts = [];
    const partsEn = [];
    if (expiring) {
      parts.push(`${st.pending} 個對話還沒回顧，最早的一個${st.expiresInDays ? ` ${st.expiresInDays} 天後` : '很快就'}會被 Claude Code 清除（保留 ${st.retention} 天）`);
      partsEn.push(`${st.pending === 1 ? '1 conversation has' : `${st.pending} conversations have`} not been reviewed, and the oldest ${st.expiresInDays ? `will be deleted by Claude Code in ${st.expiresInDays === 1 ? '1 day' : `${st.expiresInDays} days`}` : 'will be deleted by Claude Code soon'} (kept for ${st.retention} days)`);
    } else {
      parts.push(`${st.pending} 個對話還沒回顧`);
      partsEn.push(`${st.pending === 1 ? '1 conversation has' : `${st.pending} conversations have`} not been reviewed`);
    }
    if (stale.length) {
      parts.push(`${stale.length} 筆容易過時的記憶超過 30 天沒確認`);
      partsEn.push(`${stale.length === 1 ? '1 memory that goes out of date easily has' : `${stale.length} memories that go out of date easily have`} not been checked in over 30 days`);
    }
    out.push(finding('H20', 'low', `建議回顧「${name}」的對話`,
      `${parts.join('；')}。回顧時 Claude 會拿對話紀錄驗證這個專案的記憶、補上漏記的事，所有建議都由你在網頁逐項決定。`,
      {
        refs: [`projects/${pid}`], pid, key: `dream:${pid}`,
        fix: { action: 'open-dream', args: { pid }, label: '交給 Claude 回顧', en: { label: 'Ask Claude to review' } },
        en: {
          title: `Review the conversations for "${name}"`,
          detail: `${partsEn.join('; ')}. Claude checks this project's memories against the conversations and adds what was missed; you decide on every suggestion in the dashboard.`,
        },
      }));
  }

  // H21：連結斷了（1.4.0）。[[名稱]] 指向的記憶被合併或封存；從沒存在過的名稱不提示
  for (const b of await brokenLinks(ctx, memories)) {
    const pid = memories.find((m) => m.ref === b.ref)?.scope?.pid;
    const merged = b.via === 'merge' && b.to;
    out.push(finding('H21', 'low', `「${b.name}」的連結 [[${b.from}]] 斷了`,
      merged ? `「${b.from}」已經合併進「${b.to}」。` : `「${b.from}」已經封存。`,
      {
        refs: [b.ref], pid, key: `${b.ref}:${b.from.toLowerCase()}`,
        fix: { action: merged ? 'relink' : 'unlink', args: merged ? { ref: b.ref, from: b.from, to: b.to } : { ref: b.ref, from: b.from }, label: merged ? `改連到 ${b.to}` : '移除連結（保留文字）', en: { label: merged ? `Link to ${b.to} instead` : 'Remove the link (keep the text)' } },
        en: {
          title: `The link [[${b.from}]] in "${b.name}" is broken`,
          detail: merged ? `"${b.from}" was merged into "${b.to}".` : `"${b.from}" was archived.`,
        },
      }));
  }

  // H13：核心準則（CORE.md、core/rules）也會同步，而且每次對話都會載入
  let rules = [];
  try { rules = fs.readdirSync(path.join(ctx.vault, 'core', 'rules')).filter((n) => /\.md$/i.test(n)).map((n) => `core/rules/${n}`); } catch { /* 沒有 rules */ }
  for (const ref of ['core/CORE.md', ...rules]) {
    const text = await readText(path.join(ctx.vault, ...ref.split('/')));
    const secrets = text ? scanWithAllow(text, ref, allow) : [];
    if (secrets.length) {
      out.push(finding('H13', 'high', `核心準則「${path.basename(ref)}」疑似含有金鑰或密碼`, `${secrets.map((s) => `第 ${s.line} 行 ${s.kind}（${s.preview}）`).join('；')}。此檔案不會同步，而且每次對話都會載入。`,
        {
          refs: [ref], fix: { action: 'edit', args: { ref, lines: secrets.map((s) => s.line) }, label: '移除金鑰', en: { label: 'Remove secret' } },
          en: {
            title: `Core rules file "${path.basename(ref)}" may contain a secret or password`,
            detail: `${secrets.map((s) => `line ${s.line} ${s.kind} (${s.preview})`).join('; ')}. This file will not sync, and it is loaded in every conversation.`,
          },
        }));
    }
  }

  // H14：同步停滯；H18：被扣住的大量刪除
  const state = await readState(ctx.local);
  const remote = state.remote ?? null;
  const lastOk = Date.parse(state.sync?.lastSuccessAt ?? '') || 0;
  if (remote && (!lastOk || now - lastOk > DAY)) {
    out.push(finding('H14', 'medium', lastOk ? '超過 24 小時沒有成功同步' : '尚未成功同步過', state.sync?.error?.message ?? '另一台電腦的變更可能還沒到這裡。', {
      refs: [], fix: { action: 'sync', args: {}, label: '立即同步', en: { label: 'Sync now' } },
      en: {
        title: lastOk ? 'No successful sync in over 24 hours' : 'No successful sync yet',
        // 錯誤物件若有英文版（EngramError#withEn）就用英文版，否則照原訊息
        detail: state.sync?.error?.en?.message ?? state.sync?.error?.message ?? 'Changes from the other computer may not have arrived here yet.',
      },
    }));
  }
  for (const h of state.heldDeletions ?? []) {
    out.push(finding('H18', 'high', `偵測到大量刪除：${projects.get(h.pid)?.name ?? h.pid}`, `${h.refs.length} 筆記憶在同一輪被刪除，已暫停同步這些刪除。`, {
      refs: h.refs, pid: h.pid, fix: { action: 'restore-deletions', args: { pid: h.pid }, label: '還原', en: { label: 'Restore' } },
      en: {
        title: `Mass deletion detected: ${projects.get(h.pid)?.name ?? h.pid}`,
        detail: `${h.refs.length === 1 ? '1 memory was' : `${h.refs.length} memories were`} deleted in the same round. Syncing those deletions is on hold.`,
      },
    }));
  }

  // H15：未處理的衝突
  try {
    const ids = fs.readdirSync(path.join(ctx.vault, 'conflicts')).filter((n) => n.startsWith('cf_'));
    for (const id of ids) {
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(ctx.vault, 'conflicts', id, 'meta.json'), 'utf8')); } catch { /* ignore */ }
      out.push(finding('H15', 'high', `衝突待處理：${meta.ref ?? id}`, meta.summary ?? '兩台電腦同時修改了同一筆記憶。', {
        refs: [meta.ref ?? id], fix: { action: 'open-conflict', args: { id }, label: '處理衝突', en: { label: 'Resolve conflict' } },
        en: {
          title: `Conflict needs attention: ${meta.ref ?? id}`,
          // 衝突紀錄的 summary 由合併器寫入，有英文版（meta.en.summary）就用英文版；舊的紀錄沒有就照原文
          detail: meta.en?.summary ?? meta.summary ?? 'Two computers changed the same memory at the same time.',
        },
      }));
    }
  } catch { /* 沒有衝突資料夾 */ }

  // H16：核心準則過長。每次對話都會載入的內容（CORE.md＋匯入的 rules＋全域與單機索引）：行數超過 200，
  // 或位元組超過 25KB（比照 Claude Code 對 MEMORY.md 的載入上限）為中；1.4.0 起 20KB 以上為低（Anthropic 的記憶研究：這一層要小）
  const core = await indexStats(path.join(ctx.vault, 'core', 'CORE.md'));
  const gi = await indexStats(path.join(ctx.vault, 'global', SCOPE_INDEX));
  const mi = await indexStats(path.join(machineDir(ctx.vault, ctx.mid), SCOPE_INDEX));
  let rulesBytes = 0;
  for (const m of ((await readText(path.join(ctx.vault, 'core', 'CORE.md'))) ?? '').matchAll(/^@(\.\/)?(rules\/[^\s]+\.md)\s*$/gm)) rulesBytes += (await indexStats(path.join(ctx.vault, 'core', ...m[2].split('/')))).bytes;
  const total = core.lines + gi.lines + mi.lines;
  const bytes = core.bytes + rulesBytes + gi.bytes + mi.bytes;
  const kb = (n) => (n / 1024).toFixed(1);
  if (total > LIMITS.coreLines) {
    out.push(finding('H16', 'medium', '核心準則加索引超過 200 行', `CORE.md ${core.lines} 行、全域索引 ${gi.lines} 行、單機索引 ${mi.lines} 行，共 ${total} 行（${kb(bytes)}KB）。過長時 Claude 比較不會照做。`, {
      refs: ['core/CORE.md'], fix: { action: 'open-core', args: {}, label: '編輯核心準則', en: { label: 'Edit core rules' } },
      en: {
        title: 'Core rules plus indexes exceed 200 lines',
        detail: `CORE.md has ${core.lines} lines, the global index ${gi.lines}, and the machine index ${mi.lines}: ${total} lines in total (${kb(bytes)}KB). When it gets this long, Claude is less likely to follow it.`,
      },
    }));
  } else if (bytes >= LIMITS.coreBytesWarn) {
    const over = bytes > LIMITS.coreBytes;
    out.push(finding('H16', over ? 'medium' : 'low', over ? '每次對話都會載入的內容超過 25KB' : '每次對話都會載入的內容偏多', `核心準則與匯入的規則 ${kb(core.bytes + rulesBytes)}KB、全域索引 ${kb(gi.bytes)}KB、單機索引 ${kb(mi.bytes)}KB，共 ${kb(bytes)}KB（建議 20KB 以內）。這些內容在每個專案、每次對話都會佔用上下文；很少用到的全域記憶可以封存或搬到相關的專案，說明（description）也可以寫得更精簡。`, {
      refs: ['core/CORE.md'], key: 'bytes', fix: { action: 'open-tidy', args: { scope: 'core' }, label: '交給 Claude 精簡', en: { label: 'Ask Claude to trim' } },
      en: {
        title: over ? 'What loads in every conversation exceeds 25KB' : 'A lot loads in every conversation',
        detail: `Core rules and imported rules ${kb(core.bytes + rulesBytes)}KB, global index ${kb(gi.bytes)}KB, machine index ${kb(mi.bytes)}KB: ${kb(bytes)}KB in total (20KB or less is recommended). This content takes up context in every project and every conversation. Global memories you rarely use can be archived or moved to the project they belong to, and descriptions can be shorter.`,
      },
    }));
  }

  // H23：每次都會載入的內容被改了、使用者還沒確認（1.4.0）。起點還沒建立前不判斷；設定 reviewWrites: off 時不提示
  const engineSettings = (await readJson(path.join(ctx.local, 'settings.json'), null)) ?? {};
  if (engineSettings.reviewWrites !== 'off' && !(await needsBaseline(ctx))) {
    const pending = await pendingReviews(ctx);
    if (pending.length) {
      const label = (r) => (r.startsWith('core/') ? `核心準則 ${path.posix.basename(r)}` : path.posix.basename(r, '.md'));
      const labelEn = (r) => (r.startsWith('core/') ? `core rules ${path.posix.basename(r)}` : path.posix.basename(r, '.md'));
      const shown = pending.slice(0, 5);
      const more = pending.length - shown.length;
      out.push(finding('H23', 'low', `${pending.length} 筆每次對話都會載入的內容還沒經過你確認`,
        `${shown.map((p) => label(p.ref)).join('、')}${more > 0 ? ` 等 ${pending.length} 筆` : ''}。這些是 Claude 新增或修改的全域記憶、單機記憶或核心準則，會在每個專案的每次對話被讀到；看一下內容是否正確。`,
        {
          refs: pending.map((p) => p.ref), key: `review:${pending.map((p) => `${p.ref}@${p.sha}`).join('|')}`,
          fix: { action: 'open-review', args: {}, label: '檢視與確認', en: { label: 'Review and confirm' } },
          en: {
            title: `${pending.length === 1 ? '1 item that loads' : `${pending.length} items that load`} in every conversation ${pending.length === 1 ? 'has' : 'have'} not been reviewed`,
            detail: `${shown.map((p) => labelEn(p.ref)).join(', ')}${more > 0 ? ` and ${more} more` : ''}. Claude added or changed these global memories, machine memories, or core rules, and they are read in every conversation in every project. Check that they are correct.`,
          },
        }));
    }
  }

  // H24：核心準則有 1.4.0 的建議更新（找得到原本範本的位置、還沒加過）
  const sugg = suggestionsFor((await readText(path.join(ctx.vault, 'core', 'CORE.md'))) ?? '');
  if (sugg.length) {
    out.push(finding('H24', 'low', '核心準則有建議更新', `${sugg.map((s) => s.title).join('、')}。Engram 1.4.0 依 Anthropic 的記憶研究調整了「記憶寫入協定」，可以一鍵加入你的核心準則（可復原）。`, {
      refs: ['core/CORE.md'], key: `core-suggest:${sugg.map((s) => s.id).join(',')}`,
      fix: { action: 'open-core', args: { suggestions: true }, label: '查看建議', en: { label: 'View suggestions' } },
      en: { title: 'Suggested updates for your core rules', detail: `${sugg.map((s) => s.en.title).join(', ')}. Engram 1.4.0 adjusted the memory-writing protocol based on Anthropic's memory research; you can add these to your core rules in one click (and undo it).` },
    }));
  }

  // H22：很少用到、或只在一個專案用到的全域記憶（1.4.0）。讀取統計要涵蓋 60 天以上才判斷
  const usage = await loadUsage(ctx.vault);
  if ((await coverageDays(ctx.vault, usage, now)) >= 60) {
    for (const m of memories) {
      if (m.scope?.kind !== 'global' || m.pinned) continue;
      const u = usage.refs.get(m.ref);
      const updated = Date.parse(m.updatedAt ?? '') || 0;
      if (!u) {
        if (!updated || now - updated <= 60 * DAY) continue;
        const day = new Date(updated).toISOString().slice(0, 10);
        out.push(finding('H22', 'low', `「${m.name}」很少用到`, `近 90 天所有電腦都沒有打開過這筆全域記憶的全文（最後修改 ${day}）。只看索引那一行就夠用的記憶也會這樣，請看內容再決定；全域記憶每次對話都會列在索引裡，確定用不到的可以封存（可從歷史還原），或搬到相關的專案。`, {
          refs: [m.ref], key: `${m.ref}:unused`, fix: { action: 'remove', args: { ref: m.ref }, label: '封存（可從歷史還原）', en: { label: 'Archive (can be restored from history)' } },
          en: { title: `"${m.name}" is rarely used`, detail: `No computer has opened the full text of this global memory in the last 90 days (last changed ${day}). Memories whose one-line index entry is enough look like this too, so check the content before deciding. Global memories are listed in the index in every conversation; ones you really don't use can be archived (restorable from history) or moved to the project they belong to.` },
        }));
        continue;
      }
      const used = Object.entries(u.projects).filter(([, n]) => n > 0);
      if (u.reads >= 3 && u.days >= 2 && used.length === 1 && used[0][1] >= u.reads && projects.has(used[0][0])) {
        const [pid] = used[0];
        const pname = projects.get(pid)?.name ?? pid;
        out.push(finding('H22', 'low', `「${m.name}」只在「${pname}」用到`, `近 90 天讀了 ${u.reads} 次，全部在「${pname}」。只跟一個專案有關的話，搬到那個專案就不會佔用其他專案的上下文；如果是通用的做法，維持全域即可。`, {
          refs: [m.ref], key: `${m.ref}:single`, fix: { action: 'move', args: { ref: m.ref, scope: { kind: 'project', pid } }, label: `搬到「${pname}」`, en: { label: `Move to "${pname}"` } },
          en: { title: `"${m.name}" is only used in "${pname}"`, detail: `Read ${u.reads} times in the last 90 days, all in "${pname}". If it only concerns that project, moving it there keeps it out of other projects' context; if it is a general practice, keep it global.` },
        }));
      }
    }
  }

  const rank = { high: 0, medium: 1, low: 2, auto: 3 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code));
  return out;
}
