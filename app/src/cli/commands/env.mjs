// engram env：環境健檢與兩台差異（2.0.0 R1、R5）。只讀這台電腦的 Claude Code 環境（名稱、版本、雜湊、數量、耗時）；
// status 看環境指紋與發現（H25–H33），diff 比較各台電腦同步來的指紋，fix 修正一張可修的卡片（先備份）。
// 環境設定同步與瘦身（2.0.0 WP8：R3、R4、R6）：set、export、plan、apply、undo、disable-plugin、enable-plugin。
import { CliError } from '../errors.mjs';
import { SEVERITY_LABEL } from '../output.mjs';
// 在 Claude Code 裡執行：和 guardrails approve、not-secret、確認來源同一個判斷（第三輪審查 A）
import { inClaudeCode } from '../source.mjs';
import { redactText } from './safe.mjs';

const plural = (n, word) => `${n} 個${word}`;

const NEEDS_APPROVAL = '你是在 Claude Code 裡執行的，寫出的內容不會自動視為這台已核可：需要在終端機或管理介面核可——請在你自己的終端機（不是 Claude Code 的對話或 ! 指令）執行 engram env approve，或到管理介面（engram ui）核可，之後才會被套用。';

/** 環境指紋的重點（給人看的幾行） */
function fingerprintLines(fp) {
  if (!fp) return ['環境指紋：還沒有'];
  const slow = (fp.hookStats?.hooks ?? []).filter((h) => h.mode !== 'async').slice(0, 3);
  return [
    `環境指紋（${fp.updated ?? '?'}）：Claude Code ${fp.claudeCode?.version ?? '未知'} · Engram ${fp.engram?.version ?? '?'}${fp.engram?.commit ? `（${fp.engram.commit}）` : ''}`,
    `　外掛 ${fp.plugins?.length ?? 0}、技能 ${fp.skills?.length ?? 0}、代理 ${fp.agents?.length ?? 0}、指令 ${fp.commands?.length ?? 0}；settings.json 的 hook ${fp.settings?.hooks?.length ?? 0} 個；對話保留 ${fp.settings?.cleanupPeriodDays ?? '預設 30'} 天`,
    fp.claudeMd ? `　CLAUDE.md ${fp.claudeMd.bytes} 位元組，標記區塊：${fp.claudeMd.blocks?.length ? fp.claudeMd.blocks.map((b) => b.name).join('、') : '（沒有）'}` : '　CLAUDE.md：沒有',
    ...(slow.length ? [`　近 ${fp.hookStats.windowDays} 天最耗時的 hook（同步的，或來源不明、無法確認是否同步的）：${slow.map((h) => `${h.source ?? '來源不明'} ${h.event} 中位數 ${h.medianMs} 毫秒（${h.runs} 次${h.mode === 'unknown' ? '，無法確認是否同步' : ''}）`).join('；')}`] : []),
  ];
}

export async function cmdEnv(ctx) {
  const [sub = 'status'] = ctx.args;
  const eg = await ctx.engine();

  if (sub === 'status') {
    const refresh = !!ctx.opts.refresh;
    const settings = (await eg.settings?.get?.().catch(() => null)) ?? {};
    const fingerprint = await eg.env.fingerprint({ refresh });
    const findings = await eg.env.findings();
    return ctx.out.result({ envHealth: settings.envHealth ?? 'on', fingerprint, findings }, [
      `環境健檢：${settings.envHealth === 'off' ? '關閉（設定 envHealth；常駐程式不會每天檢查，這個指令仍可使用）' : '開啟（常駐程式每天檢查一次）'}`,
      ...fingerprintLines(fingerprint),
      findings.length ? `發現 ${findings.length} 項：` : '沒有發現需要處理的事',
      ...findings.flatMap((f) => [`• [${SEVERITY_LABEL[f.severity] ?? f.severity}] ${f.code} ${redactText(f.title)}（${f.id}）`, `    ${redactText(f.detail)}`, f.fix ? `    可以修正：engram env fix ${f.id}（${f.fix.label}）` : null].filter(Boolean)),
    ]);
  }

  if (sub === 'diff') {
    const d = await eg.env.diff();
    const have = d.machines.filter((m) => m.hasEnv);
    return ctx.out.result(d, [
      `有環境指紋的電腦：${have.length ? have.map((m) => `${m.label}${m.self ? '（這台）' : ''}${m.updated ? ` ${m.updated}` : ''}`).join('、') : '（沒有）'}`,
      ...(d.compared < 2
        ? ['只有不到 2 台電腦有環境指紋，還不能比較（每台電腦的常駐程式每天 10:00 檢查並同步一次）']
        : d.items.length ? d.items.map((i) => `• ${i.summary}`) : [`${plural(d.compared, '電腦')}的環境完全一致`]),
    ]);
  }

  if (sub === 'fix') {
    const id = ctx.args[1];
    if (!id) throw new CliError('E_USAGE', '要指定卡片 id', 'engram env 可以列出可修正的卡片與它們的 id');
    const r = await eg.env.fix(id);
    if (r.delegated) return ctx.out.result(r, [r.note]);
    const what = { H26: `已移除 ${r.removed} 個失效的路徑`, H32: r.changed ? `已把 cleanupPeriodDays 設成 ${r.days} 天` : 'cleanupPeriodDays 已經有設定，沒有改動' }[r.code] ?? '已修正';
    return ctx.out.result(r, [`${what}。修改前的備份：${r.backup}`]);
  }

  // 2.0.0 WP8：環境設定同步與瘦身
  if (sub === 'set') {
    const arg = ctx.args[1] ?? '';
    const at = arg.indexOf('=');
    if (at <= 0) throw new CliError('E_USAGE', '要寫成 <鍵>=<值>', '例如 engram env set MY_FLAG=on');
    const key = arg.slice(0, at);
    // 在 Claude Code 裡執行時，寫出的內容不自動視為這台已核可（否則 Claude 可以自己寫、自己套用）；要使用者在自己的終端機或管理介面核可
    const approve = !inClaudeCode(ctx);
    const r = await eg.env.set(key, arg.slice(at + 1), { approve });
    return ctx.out.result(r, [
      `已把環境變數 ${key} 寫進環境設定檔（vault/env/profile.json）${r.changed === false ? '（內容沒變）' : '，並提交到記憶庫'}。`,
      approve
        ? '這台電腦自己寫的視為已核可；其他電腦同步後，要先用 engram env plan 看過、engram env approve 核可，才會被套用。'
        : NEEDS_APPROVAL,
    ]);
  }

  // 核可：沒有在這台核可過的環境變數、設定與技能不會被套用。這是使用者本人的確認（比照 guardrails approve、not-secret）：
  // 不能由 Claude 代為執行，否則同步來的設定可以由 Claude 自己核可、自己套用。只要變數存在（即使是空字串）就拒絕
  if (sub === 'approve') {
    if (inClaudeCode(ctx)) {
      throw new CliError('E_CONFIRM', '核可同步來的環境設定要由你本人確認，不能在 Claude Code 裡執行', `請在你自己的終端機（不是 Claude Code 的對話或 ! 指令）執行 engram env approve${ctx.args[1] ? ` ${ctx.args[1]}` : ''}，或到管理介面（engram ui）核可。`);
    }
    const r = await eg.env.approve(ctx.args[1]);
    if (!r.count) return ctx.out.result(r, ['沒有等待核可的項目。']);
    return ctx.out.result(r, [
      `已核可 ${r.count} 項（只記在這台電腦，不會同步）：`,
      ...r.approved.map((i) => `• ${redactText(i.summary)}`),
      '用 engram env apply 套用（會先備份，engram env undo 可以還原）。',
    ]);
  }

  // 從環境設定檔移除項目、這台電腦的略過
  if (sub === 'unset' || sub === 'remove-skill' || sub === 'remove-plugin' || sub === 'skip' || sub === 'unskip') {
    const name = ctx.args[1];
    if (!name) throw new CliError('E_USAGE', sub === 'unset' ? '要指定環境變數的名稱' : sub === 'remove-skill' ? '要指定技能名稱' : sub === 'remove-plugin' ? '要指定外掛名稱' : '要指定項目', 'engram env plan 可以看環境設定檔的內容與目前的狀態');
    const fn = { unset: eg.env.unset, 'remove-skill': eg.env.removeSkill, 'remove-plugin': eg.env.removePlugin, skip: eg.env.skip, unskip: eg.env.unskip }[sub];
    const r = await fn(name);
    const after = '已經套用到電腦上的值不會馬上動；下一次 engram env plan 會列為「這台多出來」，apply 時還原成套用之前的樣子。';
    return ctx.out.result(r, {
      unset: [`已從環境設定檔移除${name.startsWith('setting:') ? '設定' : '環境變數'} ${r.key}，並提交到記憶庫。`, after],
      'remove-skill': [`已從環境設定檔移除技能 ${r.name}${r.removedFiles ? '，並刪掉記憶庫裡的 env/skills 副本' : ''}。`, '每台電腦上已經安裝的技能不會被動。'],
      'remove-plugin': [`已從環境設定檔的外掛清單移除 ${r.key}。`, '各台電腦上已經安裝的外掛不會被動。'],
      skip: [r.changed ? `這台電腦之後會略過 ${r.item}（engram env unskip ${r.item} 可以取消）。` : `${r.item} 本來就設定為略過。`],
      unskip: [r.changed ? `這台電腦不再略過 ${r.item}。` : `${r.item} 本來就沒有設定為略過。`],
    }[sub]);
  }

  if (sub === 'export') {
    const approve = !inClaudeCode(ctx);
    const r = await eg.env.export({ skills: ctx.opts.skill ?? [], force: !!ctx.opts.force, approve });
    return ctx.out.result(r, [...exportLines(r), ...(approve ? [] : [NEEDS_APPROVAL])]);
  }

  if (sub === 'plan') {
    const plan = await eg.env.plan();
    return ctx.out.result(plan, planLines(plan));
  }

  if (sub === 'apply') {
    const r = await eg.env.apply();
    const waiting = r.pending ? `有 ${r.pending} 項還在等這台核可，沒有套用：先用 engram env plan 看過內容，再用 engram env approve 核可。` : null;
    if (!r.applied) return ctx.out.result(r, ['沒有需要套用的變更，什麼都沒有改。', waiting]);
    return ctx.out.result(r, [
      `已套用 ${r.applied} 項：`,
      ...r.items.map((i) => `• ${redactText(i.summary)}`),
      `修改前的備份：${r.backup}`,
      '想還原可以執行 engram env undo。',
      waiting,
    ]);
  }

  if (sub === 'undo') {
    const r = await eg.env.undo();
    return ctx.out.result(r, [
      `已還原最近一次${r.kind === 'plugin' ? '外掛開關' : '套用'}（${r.restored} 項）。`,
      ...r.kept.map((k) => `• 保留 ${k.key}：${KEPT_REASON[k.reason] ?? k.reason}`),
    ]);
  }

  if (sub === 'disable-plugin' || sub === 'enable-plugin') {
    const name = ctx.args[1];
    if (!name) throw new CliError('E_USAGE', '要指定外掛名稱', 'engram env plan 可以列出近 30 天沒用過的外掛');
    const enabled = sub === 'enable-plugin';
    const r = await eg.env.setPlugin(name, enabled);
    if (!r.changed) return ctx.out.result(r, [`${r.key} 本來就是${enabled ? '啟用' : '停用'}的，沒有改動。`]);
    return ctx.out.result(r, [`已${enabled ? '啟用' : '停用'}外掛 ${r.key}（修改前的備份：${r.backup}）。`, '新開的對話才會生效；想還原可以執行 engram env undo。']);
  }

  throw new CliError('E_USAGE', `看不懂的子指令：${sub}`, 'engram help env');
}

const KEPT_REASON = { changed: '套用之後被改過', format: 'settings.json 的排版不是標準格式', invalid: 'settings.json 不是有效的 JSON', link: '路徑是連結', 'backup-missing': '找不到備份' };

/** engram env export 的結果（給人看） */
function exportLines(r) {
  const s = r.skills;
  const lines = [
    r.changed === false && !s.synced.length ? '環境設定檔沒有變化。' : '已更新環境設定檔（vault/env/profile.json），並提交到記憶庫。',
    `　設定：${r.settings.length ? r.settings.join('、') : '（沒有）'}；啟用中的外掛 ${r.plugins} 個`,
    ...(r.settingsProblem ? ['　settings.json 不是有效的 JSON，沒有匯出設定'] : []),
    ...r.blocked.map((b) => `• 設定 ${b.key} 沒有匯出：${b.message}`),
    ...(s.synced.length ? [`　技能：${s.synced.map((x) => `${x.name}（${x.files} 個檔案）`).join('、')}`] : []),
    ...s.synced.filter((x) => x.skippedLarge.length || x.skippedLinks.length).map((x) => `• 技能 ${x.name} 略過：${[...x.skippedLarge.map((n) => `${n}（超過 1 MB）`), ...x.skippedLinks.map((n) => `${n}（連結）`)].join('、')}`),
    ...s.blocked.map((b) => `• 技能 ${b.name} 沒有同步：${SKILL_REASON[b.reason] ?? b.reason}${b.files ? `（${b.files.map((f) => `${f.rel}：${f.kinds.join('、')}`).join('；')}）` : ''}`),
    ...s.conflicts.map((c) => `• 技能 ${c.name} 沒有覆蓋：記憶庫裡的版本不是這台上次匯出或核可的那一版（別台改過）。先 engram env plan／approve 看過別台的版本，或加 --force 用這台的版本覆蓋`),
  ];
  return lines;
}

const SKILL_REASON = { secret: '內容疑似含有金鑰', 'conflict-marker': '含有衝突標記', missing: '這台電腦沒有這個技能', link: '資料夾是連結', 'not-dir': '不是資料夾', 'too-large': '檔案太多或太大', 'skills-link': '~/.claude/skills 本身是連結，不穿越', 'vault-link': '記憶庫裡的這個資料夾是連結' };

/** engram env plan 的結果（給人看） */
function planLines(plan) {
  const waiting = plan.items.filter((i) => i.approved === false);
  const isApply = (i) => (i.action === 'add' || i.action === 'update' || i.action === 'restore') && i.approved !== false;
  const apply = plan.items.filter(isApply);
  const other = plan.items.filter((i) => !isApply(i) && i.approved !== false);
  const mode = { report: '只報告（每天算出 plan，不自動套用）', auto: '自動套用（沒有對話進行中時）', off: '關閉' }[plan.envSync];
  return [
    `環境設定同步（設定 envSync）：${mode}`,
    plan.profile.problem ? '環境設定檔（vault/env/profile.json）損毀，無法讀取' : plan.profile.present ? `環境設定檔：更新於 ${plan.profile.updatedAt ?? '?'}${plan.profile.by ? `，來自 ${plan.profile.by}` : ''}` : '還沒有環境設定檔（用 engram env set 或 engram env export 建立）',
    ...(plan.problem ? [`⚠ ${plan.problem.message}`] : []),
    apply.length ? `套用後這台電腦會改 ${apply.length} 項：` : '套用後這台電腦沒有要改的設定、環境變數或技能',
    ...apply.map((i) => `• ${redactText(i.summary)}`),
    ...(waiting.length ? [`等待這台核可的 ${waiting.length} 項（從記憶庫同步來的，還沒在這台核可過，不會被套用；完整的值如下，確認沒問題再 engram env approve）：`, ...waiting.map((i) => `• ${redactText(i.summary)}`)] : []),
    ...other.map((i) => `• ${redactText(i.summary)}`),
    ...plan.blocked.map((b) => `• 不套用 ${b.area} ${b.key}：${b.message}`),
    plan.unused.known
      ? (plan.unused.plugins.length ? `近 ${plan.unused.windowDays} 天沒用過的外掛（只建議，不會自動停用；engram env disable-plugin <名稱> 可以停用，engram env undo 可以還原）：` : `近 ${plan.unused.windowDays} 天每個外掛都有用過`)
      : `近 ${plan.unused.windowDays} 天沒用過的外掛：還不知道（環境健檢還沒統計過，執行 engram env status --refresh 或等每天的檢查）`,
    ...plan.unused.plugins.map((p) => `• ${p.key}`),
    apply.length ? '確認後執行 engram env apply 套用（會先備份，engram env undo 可以還原）。' : null,
  ];
}
