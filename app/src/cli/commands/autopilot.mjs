// engram autopilot：自動駕駛（1.5.0）。開關、立即執行一輪、執行紀錄與復原。
// engram secret：本機保管區（自動駕駛把記憶裡的金鑰移到這裡）。
import { isFresh, pingAgent, readHeartbeat, requestAgent } from '../../agent/heartbeat.mjs';
import { CliError } from '../errors.mjs';
import { localPaths } from '../paths.mjs';
import { localTime } from '../fsutil.mjs';
import { autopilotStatus, categoryLabel, runAutopilot, summarize, undoRun } from '../../autopilot/run.mjs';
import { readRun, setEnabledState } from '../../autopilot/state.mjs';
import { getSecret, listSecrets } from '../../core/secretvault.mjs';

const STATUS = { running: '執行中', done: '完成', failed: '失敗', interrupted: '中斷' };
const TASK = { curate: '整理', dream: '對話回顧', cards: '收件匣', conflicts: '衝突', secrets: '金鑰', review: '待你確認', run: '整體' };

/** 常駐程式在跑時回傳心跳（用來把工作交給它在背景執行） */
async function liveAgent(ctx) {
  if (ctx.deps?.noAgent) return null;
  const hb = readHeartbeat(localPaths());
  return isFresh(hb) && (await pingAgent(hb)) ? hb : null;
}

function summaryLine(s) {
  if (!s) return '';
  return `處理 ${s.changes} 項、不執行 ${s.rejected} 項${s.failed ? `、失敗 ${s.failed} 項` : ''}；呼叫 ${s.calls} 次，約當 US$${s.costUsd}`;
}

export async function cmdAutopilot(ctx) {
  const [sub = 'status', ...rest] = ctx.args;
  const eg = await ctx.engine();

  if (sub === 'status') {
    const st = await autopilotStatus(eg);
    return ctx.out.result(st, [
      `自動駕駛：${st.enabled ? '開啟' : '關閉'}${st.enabled ? `；共用範圍由「${st.host.label ?? st.host.mid ?? '?'}」處理${st.host.self ? '（這台）' : ''}` : ''}`,
      `本月用量：約當 US$${st.budget.used}／上限 US$${st.budget.monthly}（用 Claude 訂閱時不另外計費，代表額度的消耗）`,
      st.paused.length ? `暫停中的類別（被你復原過多次）：${st.paused.map(categoryLabel).join('、')}` : null,
      st.running ? `正在執行：${st.running.id}` : null,
      ...(st.runs.length ? ['最近的執行：', ...st.runs.slice(0, 8).map((r) => `• ${r.id}｜${localTime(r.startedAt)}｜${STATUS[r.status] ?? r.status}｜${summaryLine(r.summary)}`)] : ['還沒有執行過']),
    ].filter(Boolean));
  }

  if (sub === 'on' || sub === 'off') {
    await eg.settings.set({ autopilot: sub });
    await setEnabledState(eg, sub === 'on');
    // 常駐程式在跑：同步它的排程開關（開啟時它會立即執行第一輪）
    const hb = await liveAgent(ctx);
    if (hb) await requestAgent(hb, 'POST', '/api/jobs/toggle', { id: 'curate', enabled: sub === 'on' }, 3000);
    return ctx.out.result({ ok: true, autopilot: sub, agent: !!hb }, [sub === 'on'
      ? `自動駕駛已開啟：${hb ? '常駐程式已在背景開始第一輪' : '常駐程式啟動後接手'}，之後每天在電腦閒置時執行一輪。結果在管理介面的「自動駕駛」頁，或 engram autopilot status`
      : '自動駕駛已關閉（已經做的變更不受影響，可以在管理介面的「自動駕駛」頁復原）']);
  }

  if (sub === 'budget') {
    const usd = Number(rest[0]);
    if (!Number.isFinite(usd) || usd < 1 || usd > 1000) throw new CliError('E_USAGE', '每月上限要是 1 到 1000 的數字（美元）', '例如 engram autopilot budget 60');
    await eg.settings.set({ autopilotBudget: usd });
    return ctx.out.result({ ok: true, autopilotBudget: usd }, [`每月上限改為約當 US$${usd}`]);
  }

  if (sub === 'run') {
    const settings = await eg.settings.get();
    if (settings.autopilot !== 'on' && !ctx.opts.force) throw new CliError('E_USAGE', '自動駕駛沒有開啟', '先執行 engram autopilot on；只想試跑一次可以加 --force');
    // 預設交給常駐程式在背景執行（一輪可能超過十分鐘）；--wait 或常駐程式沒在跑時在這裡執行到完成
    if (!ctx.opts.wait && !ctx.opts.force) {
      const hb = await liveAgent(ctx);
      const res = hb ? await requestAgent(hb, 'POST', '/api/autopilot/run', {}, 3000) : null;
      if (res?.status === 200) return ctx.out.result({ ok: true, started: true, background: true }, ['已在背景開始一輪自動駕駛。完成後用 engram autopilot status 查看，或到管理介面的「自動駕駛」頁看每一項的理由與復原。']);
    }
    const r = await runAutopilot(eg, { reason: 'cli', force: !!ctx.opts.force });
    if (r.skipped === 'busy') throw new CliError('E_LOCKED', '另一輪自動駕駛正在執行', '等它完成後再試，或用 engram autopilot status 查看');
    const run = r.run;
    const done = run.actions.filter((a) => a.status === 'done');
    return ctx.out.result({ ok: r.ok, id: run.id, status: run.status, summary: run.summary ?? summarize(run) }, [
      `自動駕駛 ${run.id}：${STATUS[run.status] ?? run.status}。${summaryLine(run.summary)}`,
      ...done.slice(0, 30).map((a) => `• [${TASK[a.task] ?? a.task}] ${a.title}`),
      done.length > 30 ? `…另外 ${done.length - 30} 項` : null,
      ...run.notes.map((n) => `（${n.note}）`),
      run.error ? `錯誤：${run.error.message}` : null,
      done.length ? `每一項的理由與復原：engram autopilot show ${run.id}，或管理介面的「自動駕駛」頁` : null,
    ].filter(Boolean));
  }

  if (sub === 'runs') {
    const st = await autopilotStatus(eg);
    return ctx.out.result({ runs: st.runs }, st.runs.length ? st.runs.map((r) => `${r.id}｜${localTime(r.startedAt)}｜${STATUS[r.status] ?? r.status}｜${summaryLine(r.summary)}`) : ['還沒有執行過']);
  }

  if (sub === 'show') {
    const run = await readRun(eg.paths.local, rest[0]);
    if (!run) throw new CliError('E_NOT_FOUND', `找不到自動駕駛的執行紀錄：${rest[0] ?? ''}`, 'engram autopilot runs 可以列出最近的執行');
    return ctx.out.result(run, [
      `${run.id}｜${localTime(run.startedAt)}｜${STATUS[run.status] ?? run.status}｜${summaryLine(run.summary)}`,
      ...run.actions.map((a, i) => `${String(i).padStart(3)} [${TASK[a.task] ?? a.task}] ${a.status === 'done' ? (a.undone ? '已復原' : '完成') : a.status} ${a.title}${a.reason ? `\n      理由：${a.reason}` : ''}`),
      ...(run.rejected.length ? ['沒有執行的建議：', ...run.rejected.map((x) => `  - ${x.title}：${x.why}`)] : []),
      ...(run.skipped.length ? ['略過：', ...run.skipped.map((x) => `  - ${TASK[x.task] ?? x.task}：${x.why}`)] : []),
      run.actions.some((a) => a.status === 'done' && !a.undone) ? `復原一項：engram autopilot undo ${run.id} <編號>；整輪：engram autopilot undo ${run.id}` : null,
    ].filter(Boolean));
  }

  if (sub === 'undo') {
    if (!rest[0]) throw new CliError('E_USAGE', '要指定執行紀錄', 'engram autopilot undo <執行編號> [<項目編號>]');
    const r = await undoRun(eg, rest[0], rest[1] === undefined ? undefined : Number(rest[1]));
    return ctx.out.result(r, r.results.map((x) => `${String(x.index).padStart(3)} ${x.ok ? '已復原' : `沒有復原：${x.message}`}`).concat(r.results.length ? [] : ['沒有可以復原的項目']));
  }

  throw new CliError('E_USAGE', `看不懂的子指令：${sub}`, 'engram help autopilot');
}

export async function cmdSecret(ctx) {
  const [sub, name] = ctx.args;
  const eg = await ctx.engine();
  if (sub === 'list' || !sub) {
    const list = await listSecrets(eg.paths.local);
    return ctx.out.result({ secrets: list }, list.length ? list.map((s) => `${s.name}｜${s.label || '（沒有說明）'}｜來自 ${s.from ?? '?'}｜${s.createdAt ? localTime(s.createdAt) : ''}`) : ['這台電腦的保管區是空的']);
  }
  if (sub === 'get') {
    const value = await getSecret(eg.paths.local, name);
    return ctx.out.result({ name, value }, [value]);
  }
  throw new CliError('E_USAGE', `看不懂的子指令：${sub}`, 'engram secret list | get <名稱>');
}
