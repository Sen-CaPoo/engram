// 狀態、同步、綁定、專案、匯入。
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { agentState } from '../../agent/heartbeat.mjs';
import { parseDuration } from '../args.mjs';
import { CliError, toErrorInfo } from '../errors.mjs';
import { localTime, readJson, sleep, writeJsonAtomic } from '../fsutil.mjs';
import { createLogger } from '../log.mjs';
import { SYNC_LABEL } from '../output.mjs';
import { localPaths } from '../paths.mjs';
import { isLocked, summarizeSync, syncFailure } from '../syncresult.mjs';
import { redactText } from './safe.mjs';

function describeHere(r) {
  if (!r) return '無法判斷';
  if (r.error) return `無法判斷（${r.error.message}）`;
  const where = r.root ?? r.dir;
  if (r.binding?.pid) {
    const state = r.binding.state === 'pending' ? '已綁定，等待切換（對話結束後由常駐程式完成）' : '已綁定';
    return `${where} → ${r.binding.pid}（${state}）`;
  }
  if (r.pid) return `${where} → ${r.pid}（已認出身分，下次在這裡開啟 Claude Code 時自動綁定）`;
  if (r.candidates?.length) return `${where}：可能是「${r.candidates[0].name}」，請在管理介面確認`;
  return `${where}：尚未納入 Engram（engram bind 可立即綁定）`;
}

export async function cmdStatus(ctx) {
  const eg = await ctx.engine();
  const report = await eg.status();
  const here = await eg.identity.resolve(ctx.cwd).catch((err) => ({ error: toErrorInfo(err) }));
  const agent = agentState(localPaths());
  const { machine: m, sync: s, counts: c, inbox } = report;
  // 遠端網址可能內嵌權杖（https://user:token@github.com/…）：status 的輸出也會交給 Claude
  const v = { ...report.vault, remote: report.vault?.remote ? redactText(report.vault.remote) : report.vault?.remote };
  const f = inbox?.findings ?? {};
  const lines = [
    `Engram 憶跡 · ${m.label || m.id}（${m.id}）`,
    `vault：${v.path}（${v.remote ?? '尚未設定遠端，只在本機運作'}）`,
    `同步：${SYNC_LABEL[s.state] ?? s.state} · 上次成功 ${localTime(s.lastSuccessAt)}${s.ahead || s.behind ? ` · 領先 ${s.ahead}／落後 ${s.behind}` : ''}`,
    s.error ? `　　　${s.error.message}${s.error.hint ? `（${s.error.hint}）` : ''}` : null,
    `記憶：全域 ${c.global} · 專案 ${c.projectMemories}（${c.projects} 個專案）· 單機 ${c.machine} · 共 ${c.total} 筆`,
    `收件匣：衝突 ${inbox?.conflicts ?? 0} · 健康檢查 高 ${f.high ?? 0}／中 ${f.medium ?? 0}／低 ${f.low ?? 0}`,
    `目前資料夾：${describeHere(here)}`,
    `常駐程式：${agent.running ? `執行中（pid ${agent.pid}，http://127.0.0.1:${agent.port}/）` : '沒有在執行（engram ui 會自動啟動）'}`,
  ];
  ctx.out.result({ ...report, vault: v, here, agentProcess: agent }, lines);
}

/** 多個呼叫端在短時間內要求同步時，只有最後一個在安靜 ms 之後真的執行。 */
async function debounceWins(file, ms) {
  const token = randomBytes(6).toString('hex');
  await writeJsonAtomic(file, { token, pid: process.pid, until: new Date(Date.now() + ms).toISOString() });
  await sleep(ms);
  return (await readJson(file))?.token === token;
}

export async function cmdSync(ctx) {
  const { opts } = ctx;
  const paths = localPaths();
  const network = !opts.local;
  const log = createLogger(paths.logs, 'cli');
  if (opts.debounce && !(await debounceWins(paths.debounceFile, parseDuration(opts.debounce)))) {
    if (!opts.quiet) ctx.out.result({ ok: true, skipped: 'debounced' }, '已有較新的同步要求，這次略過。');
    return 0;
  }
  const eg = await ctx.engine();
  const res = await eg.sync({ network });
  if (isLocked(res)) {
    if (!opts.quiet) ctx.out.result(res, '另一個同步正在進行，這次略過；常駐程式稍後會再同步。');
    return 0;
  }
  const failure = syncFailure(res);
  if (failure) {
    log.warn('sync', `${failure.code} ${failure.message}`);
    throw Object.assign(new CliError(failure.code, failure.message, failure.hint), { data: res });
  }
  if (!opts.quiet) ctx.out.result(res, summarizeSync(res, { network }));
  return 0;
}

export async function cmdBind(ctx) {
  const { opts } = ctx;
  if (opts.pid && opts.create) throw new CliError('E_USAGE', '--pid 與 --create 只能擇一');
  const dir = path.resolve(ctx.cwd, ctx.args[0] ?? '.');
  const eg = await ctx.engine();
  const target = opts.pid ? { pid: opts.pid } : opts.create ? { create: { name: opts.create } } : {};
  const res = await eg.identity.bind(dir, target);
  const lines = [`已綁定：${dir} → ${res.pid}${res.created ? '（新專案）' : ''}`];
  if (res.method === 'settings') lines.push('這個資料夾與其他資料夾在 Claude Code 內部撞名，改用 .claude/settings.local.json 綁定（只在從這個資料夾啟動時有效）。');
  if (res.state === 'pending') lines.push('原本的記憶資料夾還有內容或有進行中的對話，常駐程式會在對話結束後安全切換。');
  else lines.push('下一次在這裡開啟 Claude Code 時生效。');
  ctx.out.result(res, lines);
}

export async function cmdUnbind(ctx) {
  const dir = path.resolve(ctx.cwd, ctx.args[0] ?? '.');
  const eg = await ctx.engine();
  const res = await eg.identity.unbind(dir);
  ctx.out.result(res, `已解除綁定（${res?.pid ?? dir}）。記憶已複製回 Claude Code 原本的資料夾。`);
}

export async function cmdProjects(ctx) {
  const eg = await ctx.engine();
  const list = await eg.projects.list();
  const mid = eg.machine?.id;
  const lines = list.length
    ? [`共 ${list.length} 個專案：`, ...list.flatMap((p) => [
      `• ${p.name}（${p.pid}）· ${p.counts?.memories ?? 0} 筆記憶${p.index ? ` · 索引 ${p.index.lines}／200 行` : ''}${p.archived ? ' · 已封存' : ''}`,
      `  ${p.paths?.[mid]?.path ?? '這台電腦沒有綁定'}`,
    ])]
    : '還沒有任何專案。在專案資料夾執行 engram bind，或用管理介面匯入舊記憶。';
  ctx.out.result(list, lines);
}

/** 撞名資料夾依命名規則改名（SW-4）：不加子指令時只列出計畫；apply 改名；undo <id> 整批還原 */
export async function cmdCollisions(ctx) {
  const [sub, id] = ctx.args;
  if (sub && !['apply', 'undo'].includes(sub)) throw new CliError('E_USAGE', '請指定 apply 或 undo，或不加子指令只看計畫', '例如：engram collisions apply');
  const eg = await ctx.engine();
  if (!eg.collisions) throw new CliError('E_NOT_IMPLEMENTED', '這個版本的引擎不支援撞名資料夾改名', '執行 engram update 後再試');
  const { BLOCKED_LABEL } = await import('../../core/rename.mjs');
  if (!sub) {
    const plan = await eg.collisions.plan();
    const history = await eg.collisions.list();
    ctx.out.result({ plan, history }, plan.length
      ? [`${plan.length} 個用過 Claude Code 的資料夾與其他資料夾撞名：`, ...plan.map((it) => (it.to ? `• ${it.path} → ${path.basename(it.to)}` : `• ${it.path}（暫不改名：${BLOCKED_LABEL[it.blocked] ?? it.blocked}）`)), '改名：engram collisions apply']
      : ['沒有撞名的資料夾。', ...(history.length ? [`最近一次改名：${history[0].id}（${history[0].items.length} 個資料夾${history[0].undoneAt ? '，已還原' : ''}）`] : [])]);
    return 0;
  }
  if (sub === 'apply') {
    const r = await eg.collisions.apply({});
    ctx.out.result(r, [
      r.renamed.length ? `已改名 ${r.renamed.length} 個資料夾（${r.id}）：` : '這次沒有改名任何資料夾。',
      ...r.renamed.map((x) => `  ${x.from} → ${path.basename(x.to)}`),
      ...r.skipped.map((x) => `  暫不改名：${x.path}（${BLOCKED_LABEL[x.reason] ?? (x.reason === 'busy' ? '資料夾被其他程式開著' : x.reason)}）`),
      ...r.retired.map((x) => `  共用的舊記憶資料夾已移到備份：${x.encoded}`),
      r.id ? `需要還原時執行：engram collisions undo ${r.id}` : null,
    ]);
    return 0;
  }
  if (!id) throw new CliError('E_USAGE', '請提供改名紀錄的 id', '執行 engram collisions 可以看到最近一次的 id');
  const r = await eg.collisions.undo(id);
  ctx.out.result(r, r.already ? '這次改名已經還原過。' : [`已還原 ${r.restored?.length ?? 0} 個資料夾的名稱。`, ...(r.notes ?? []).map((n) => `  注意：${n}`), r.done ? null : `還有資料夾沒改回；處理上面的問題後再執行一次：engram collisions undo ${id}`].filter(Boolean));
  return r.already || r.done ? 0 : 1;
}

/** 匯入精靈的後端在 app/src/migrate（計畫、演練、套用、還原） */
async function migrateFn(name) {
  let mod = null;
  try {
    mod = await import('../../migrate/index.mjs');
  } catch {
    // 尚未安裝
  }
  if (typeof mod?.[name] !== 'function') throw new CliError('E_NOT_IMPLEMENTED', '匯入精靈尚未安裝', '等 app/src/migrate 完成後即可使用。');
  return mod[name];
}

const count = (x) => (Array.isArray(x) ? x.length : x ?? 0);

export async function cmdImport(ctx) {
  const [sub, tag] = ctx.args;
  if (!['plan', 'apply', 'undo'].includes(sub)) throw new CliError('E_USAGE', '請指定 plan、apply 或 undo', '例如：engram import plan');
  const eg = await ctx.engine();
  if (sub === 'plan') {
    const plan = await (await migrateFn('planImport'))(eg, {});
    const t = plan?.totals ?? {};
    ctx.out.result(plan, [
      `匯入計畫：${t.sources ?? count(plan?.sources)} 個來源資料夾、${t.memories ?? 0} 筆記憶。`,
      `複製 ${t.copy ?? 0} · 略過 ${t.skip ?? 0} · 建議全域 ${t.global ?? 0} · 建議單機 ${t.machine ?? 0} · 封存 ${t.archived ?? 0} · 無法判斷 ${t.unknown ?? 0}`,
      '在管理介面檢視、調整與演練後再套用；確認無誤也可以執行 engram import apply --yes。',
    ]);
    return 0;
  }
  if (sub === 'apply') {
    if (!ctx.opts.yes) throw new CliError('E_USAGE', '匯入會把既有記憶複製進 vault 並建立綁定，請先執行 engram import plan 確認計畫', '確認後加上 --yes 再執行。');
    const res = await (await migrateFn('applyImport'))(eg, {});
    const deferred = res?.deferred ?? [];
    const why = { 'changed-since-plan': '產生計畫後又有變更，請重新執行 engram import plan 再套用', 'active-session': '正有對話在使用，結束後常駐程式會自動接上', busy: '檔案被占用，常駐程式稍後會重試' };
    ctx.out.result(res, [
      res?.tag ? `匯入完成：${res.copied ?? 0} 筆記憶，綁定 ${res.bound ?? 0} 個資料夾。還原點：${res.tag}` : '這次沒有匯入任何記憶。',
      res?.backupOnly ? `略過的 ${res.backupOnly} 筆原始檔保存在 ~/.engram/local/backups。` : null,
      ...deferred.map((d) => `  延後：${d.path}（${why[d.reason] ?? d.reason}）`),
      res?.tag ? `需要還原時執行：engram import undo ${res.tag}` : null,
    ]);
    return 0;
  }
  if (!tag) throw new CliError('E_USAGE', '請提供還原點', '例如：engram import undo <tag>（tag 見 engram import apply 的輸出）');
  const res = await (await migrateFn('undoImport'))(eg, { tag });
  ctx.out.result(res, `已還原匯入（${tag}）。`);
  return 0;
}
