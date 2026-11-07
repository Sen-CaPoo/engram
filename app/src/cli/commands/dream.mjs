// engram dream：對話回顧（1.4.0，/engram:dream 技能用）。
// prepare 把這台電腦上還沒回顧的對話轉成精簡文字（只在本機），Claude 用子代理分析後寫成整理計畫，
// 由 engram tidy create 存成整理記錄（同時記為已回顧）；沒有任何建議時用 done 只記錄已回顧。
import path from 'node:path';
import { CliError } from '../errors.mjs';
import { localTime } from '../fsutil.mjs';
import { parsePositiveInt } from '../args.mjs';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 範圍參數：project:<pid> 或 pid；省略時用目前資料夾綁定的專案 */
async function pidOf(ctx, eg, arg) {
  if (arg) {
    const pid = String(arg).startsWith('project:') ? String(arg).slice(8) : String(arg);
    if (!ID_RE.test(pid)) throw new CliError('E_USAGE', `看不懂的專案：${arg}`, '用 project:<pid>，engram projects 可以列出 pid');
    return pid;
  }
  const here = await eg.identity.resolve(ctx.cwd).catch(() => null);
  if (!here?.pid) throw new CliError('E_USAGE', '目前資料夾沒有綁定專案，請指定 project:<pid>', 'engram projects 可以列出所有專案');
  return here.pid;
}

const kb = (n) => `${Math.round(n / 1000)}K`;

export async function cmdDream(ctx) {
  const [sub, ...rest] = ctx.args;
  const eg = await ctx.engine();
  const env = ctx.deps?.env ?? process.env;

  if (sub === 'status') {
    const pid = await pidOf(ctx, eg, rest[0]);
    const st = await eg.dream.status(pid, { exclude: env.CLAUDE_CODE_SESSION_ID });
    return ctx.out.result(st, [
      `專案 ${pid}：這台電腦有 ${st.sessions} 個對話紀錄，${st.pending} 個還沒回顧${st.expiresInDays !== null ? `；最早的一個 ${st.expiresInDays} 天後會被 Claude Code 清除（保留 ${st.retention} 天）` : ''}。`,
      `上次回顧：${st.lastRunAt ? localTime(st.lastRunAt) : '還沒有'}`,
    ]);
  }

  if (sub === 'prepare') {
    const pid = await pidOf(ctx, eg, rest[0]);
    const max = ctx.opts.sessions ? parsePositiveInt(ctx.opts.sessions, '--sessions', { max: 100 }) : undefined;
    const since = ctx.opts.since ? String(ctx.opts.since) : undefined;
    if (since && !DATE_RE.test(since)) throw new CliError('E_USAGE', `--since 要是 YYYY-MM-DD：${since}`);
    const m = await eg.dream.prepare({ pid, ...(max ? { max } : {}), ...(since ? { since } : {}), exclude: env.CLAUDE_CODE_SESSION_ID });
    const files = m.sessions.flatMap((s) => s.files);
    const lines = m.sessions.length
      ? [
          `已準備對話回顧 ${m.id}（專案「${m.projectName}」，${m.sessions.length} 個對話、${files.length} 份文字${m.remaining ? `；還有 ${m.remaining} 個較新的對話留到下次` : ''}）`,
          `資料夾：${m.dir}`,
          `要驗證的記憶：${path.join(m.dir, 'memories.md')}（${m.memories.length} 筆，其中 ${m.memories.filter((x) => x.volatile).length} 筆容易過時）`,
          '對話文字（每份交給一個 engram:dream-analyzer 子代理）：',
          ...m.sessions.flatMap((s) => s.files.map((f) => `• ${path.join(m.dir, ...f.split('/'))}（${s.title ?? '無標題'}，${s.startedAt ? localTime(s.startedAt) : '?'}，${kb(s.chars)} 字）`)),
          m.failed?.length ? `讀不到的對話（這次略過，下次再試）：${m.failed.map((f) => `${String(f.sid).slice(0, 8)}（${f.error}）`).join('、')}` : null,
          m.settingsChanged ? '已把回顧資料夾加入 Claude Code 的允許讀取清單（permissions.additionalDirectories），開新對話後生效；這次如果子代理讀不到，請使用者開新對話再執行一次。' : null,
          `完成後：整理計畫加上 "dream": "${m.id}"，用 engram tidy create 建立記錄；沒分析到的對話放進 "skipped"。沒有任何建議時執行 engram dream done ${m.id}（有沒分析到的加 --skip <session 前 8 碼,...>）`,
        ]
      : m.failed?.length
        ? [`專案「${m.projectName}」這次挑到的 ${m.failed.length} 個對話都讀不到：${m.failed.map((f) => `${String(f.sid).slice(0, 8)}（${f.error}）`).join('、')}。不要執行 engram dream done，請使用者稍後再試。`]
        : [`專案「${m.projectName}」在這台電腦沒有還沒回顧的對話（${m.id}）。執行 engram dream done ${m.id} 記錄這次回顧即可。`];
    return ctx.out.result(m, lines);
  }

  if (sub === 'done') {
    const [id] = rest;
    if (!id) throw new CliError('E_USAGE', '請提供回顧編號', 'engram dream prepare 的輸出第一行有編號（dr- 開頭）');
    // --skip：子代理沒分析到的對話（session 前 8 碼，逗號分隔），不記為已回顧
    const m = await eg.dream.read(id);
    const { resolveSkipped } = await import('../../tidy/plan.mjs');
    const sk = resolveSkipped(ctx.opts.skip ? String(ctx.opts.skip).split(',').map((x) => x.trim()).filter(Boolean) : undefined, m);
    if (sk.errs.length) throw new CliError('E_INVALID', sk.errs.join('；'));
    const r = await eg.dream.done(id, { skip: sk.sids });
    return ctx.out.result(r, `已記錄回顧 ${id}：專案 ${r.pid} 的 ${r.sessions} 個對話標為已回顧${r.skipped ? `；${r.skipped} 個沒分析到的留到下次` : ''}。`);
  }

  if (sub === 'reset') {
    const [id] = rest;
    if (!id) throw new CliError('E_USAGE', '請提供回顧編號', 'engram dream list 可以列出最近的回顧');
    const r = await eg.dream.reset(id);
    return ctx.out.result(r, r.sessions
      ? `已撤銷回顧 ${id}：專案 ${r.pid} 的 ${r.sessions} 個對話改回未回顧，下次會再分析。`
      : `回顧 ${id} 沒有需要撤銷的對話（還沒記為已回顧，或已經被之後的回顧取代）。`);
  }

  if (sub === 'list') {
    const list = await eg.dream.list();
    return ctx.out.result(list, list.length
      ? [`最近 14 天的對話回顧（共 ${list.length} 次）：`, ...list.map((r) => `• ${r.id}　${r.projectName}　${r.sessions} 個對話　${localTime(r.createdAt)}${r.done ? '' : '　（還沒建立整理記錄）'}`)]
      : '最近 14 天沒有對話回顧。');
  }

  throw new CliError('E_USAGE', sub ? `看不懂的子指令：${sub}` : '請指定子指令', '可用的子指令：status、prepare、done、reset、list');
}
