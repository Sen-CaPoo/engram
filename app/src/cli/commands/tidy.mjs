// engram tidy：記憶整理（/engram:tidy 與 /engram:tidy-apply 技能用）。
// create 把 Claude 的整理計畫存成整理記錄並給出管理介面的網址；使用者在介面決定後，apply 照核可的內容執行。
import os from 'node:os';
import path from 'node:path';
import { isFresh, pingAgent, readHeartbeat } from '../../agent/heartbeat.mjs';
import { waitForAgent } from '../../agent/wait.mjs';
import { applyRecord, recordResult } from '../../tidy/apply.mjs';
import { createFromPlan } from '../../tidy/plan.mjs';
import { counts, listRecords, readRecord } from '../../tidy/store.mjs';
import { CliError } from '../errors.mjs';
import { localTime } from '../fsutil.mjs';
import { BIN_PATH, DEFAULT_PORT, localPaths } from '../paths.mjs';
import { spawnDetachedNode } from '../proc.mjs';
import { redactText } from './safe.mjs';

const STATUS_LABEL = { pending: '待使用者決定', ready: '已產生執行指令', applying: '執行中', finishing: '等 Claude 處理備註項目', done: '已完成' };
const DECISION_LABEL = { accept: '採用建議', keep: '維持原狀', archive: '封存', custom: '依備註調整' };
const RESULT_LABEL = { done: '完成', kept: '維持原狀', failed: '失敗', skipped: '略過', 'needs-claude': '等 Claude 處理', undone: '已復原' };
const ACTION_LABEL = { keep: '保留', update: '改寫', move: '搬移', archive: '封存', merge: '合併', create: '新增', split: '拆分', promote: '升為全域' };

/** 管理介面的網址；常駐程式沒在跑時先在背景啟動（啟動不了也不讓指令失敗） */
async function dashboardUrl(ctx) {
  const paths = localPaths();
  let hb = readHeartbeat(paths);
  let note = null;
  if (!(isFresh(hb) && (await pingAgent(hb)))) {
    (ctx.deps.spawnNode ?? spawnDetachedNode)([BIN_PATH, 'agent']);
    hb = await waitForAgent(paths, ctx.deps.agentWaitMs ?? 10_000);
    if (!hb) note = '常駐程式沒有啟動成功：請使用者先執行 engram ui，再開啟上面的網址。';
  }
  return { base: `http://127.0.0.1:${hb?.port ?? DEFAULT_PORT}/`, note };
}

const scopeText = (s) => (s === 'global' ? '全域' : s === 'all' ? '全部記憶' : s === 'core' ? '核心準則' : String(s).startsWith('project:') ? `專案 ${s.slice(8)}` : String(s).startsWith('machine:') ? `單機 ${s.slice(8)}` : s);

/** 一個動作的一行說明（給 Claude 看的輸出） */
function opLine(o) {
  if (o.op === 'write') return `改寫 ${o.ref}`;
  if (o.op === 'move') return `搬移 ${o.ref} → ${scopeText(o.to)}`;
  if (o.op === 'remove') return `封存 ${o.ref}`;
  if (o.op === 'merge') return `合併 ${o.refs.join('、')} → ${o.into}`;
  if (o.op === 'create') return `新增 ${o.ref}`;
  if (o.op === 'core') return '改寫核心準則 CORE.md';
  return o.op;
}

// 復原要依相反順序：先復原最後做的那一步
const undoCmds = (r) => (r?.undo?.length ? [...r.undo].reverse().map((s) => `engram undo ${String(s).slice(0, 10)}`).join(' → ') : '');

/** 交給 Claude 處理的項目：備註、原本的建議與建議的完整內容 */
function claudeBlock(it) {
  const lines = [`── [${it.id}] ${it.ref ?? it.name}（${ACTION_LABEL[it.action] ?? it.action}：${it.title}）`];
  if (it.result?.status === 'failed') lines.push(`失敗原因：${it.result.message}`);
  if (it.note) lines.push(`使用者備註：${redactText(it.note)}`);
  lines.push(`原本的建議：${it.reason.replace(/\n/g, ' ')}`);
  for (const o of it.ops) {
    lines.push(`  · ${opLine(o)}`);
    if (o.content) lines.push('    建議的內容：', ...o.content.replace(/\n$/, '').split('\n').map((l) => `    │ ${l}`));
  }
  return lines;
}

function itemLine(it) {
  const parts = [`[${it.id}] ${it.ref ?? it.name}`, `${ACTION_LABEL[it.action] ?? it.action}：${it.title}`];
  if (it.decision) parts.push(`決定：${DECISION_LABEL[it.decision]}`);
  if (it.result) parts.push(`結果：${RESULT_LABEL[it.result.status] ?? it.result.status}${it.result.message && it.result.status !== 'done' ? `（${it.result.message}）` : ''}${undoCmds(it.result) ? `（${undoCmds(it.result)}）` : ''}`);
  return `• ${parts.join(' ｜ ')}`;
}

function countText(c) {
  return `${c.items} 項：建議變更 ${c.suggested}、建議保留 ${c.items - c.suggested}`;
}

export async function cmdTidy(ctx) {
  const [sub, ...rest] = ctx.args;
  const eg = await ctx.engine();
  const local = eg.paths.local;

  if (sub === 'create') {
    const f = ctx.opts.file;
    if (!f) throw new CliError('E_USAGE', '請用 --file 指定整理計畫（JSON）', '先用 Write 工具把計畫寫成 ~/.engram/local/drafts/<名稱>/plan.json，修改後的內容放在同一個資料夾');
    const abs = path.resolve(ctx.cwd, String(f).replace(/^~(?=$|[\\/])/, os.homedir()));
    const rec = await createFromPlan(eg, abs);
    const { base, note } = await dashboardUrl(ctx);
    const url = `${base}#/tidy?id=${rec.id}`;
    const c = counts(rec);
    return ctx.out.result({ id: rec.id, url, counts: c, status: rec.status }, [
      `已建立整理記錄 ${rec.id}（${scopeText(rec.scope)}，${countText(c)}${rec.kept.length ? `；另有 ${rec.kept.length} 筆看過、建議保留` : ''}）`,
      `請使用者到這裡逐項決定：${url}`,
      note,
      `使用者在介面按「產生執行指令」後，會得到：/engram:tidy-apply ${rec.id}`,
    ]);
  }

  if (sub === 'list') {
    const list = await listRecords(local);
    return ctx.out.result(list, list.length
      ? [`共 ${list.length} 份整理記錄：`, ...list.map((r) => `• ${r.id}　${scopeText(r.scope)}　${STATUS_LABEL[r.status] ?? r.status}　${countText(r.counts)}　建立於 ${localTime(r.createdAt)}`)]
      : '還沒有整理記錄。');
  }

  if (sub === 'show') {
    const [id] = rest;
    if (!id) throw new CliError('E_USAGE', '請提供整理記錄的 id', 'engram tidy list 可以列出所有記錄');
    const rec = await readRecord(local, id);
    const safe = { ...rec, request: redactText(rec.request ?? ''), items: rec.items.map((it) => ({ ...it, note: redactText(it.note ?? '') })) };
    const custom = rec.items.filter((it) => it.decision === 'custom' || it.result?.status === 'failed');
    return ctx.out.result(safe, [
      `整理記錄 ${rec.id}（${scopeText(rec.scope)}，${STATUS_LABEL[rec.status] ?? rec.status}，建立於 ${localTime(rec.createdAt)}）`,
      `摘要：${rec.summary}`,
      rec.request ? `使用者的補充說明：${redactText(rec.request)}` : null,
      ...rec.items.map(itemLine),
      ...(custom.length ? ['', '依備註調整或失敗的項目：', ...custom.flatMap(claudeBlock)] : []),
    ]);
  }

  if (sub === 'apply') {
    const [id] = rest;
    if (!id) throw new CliError('E_USAGE', '請提供整理記錄的 id', '例如：engram tidy apply 20261024-153012-k3p9');
    const r = await applyRecord(eg, id);
    const c = counts(r.record);
    const failed = r.done.filter((it) => it.result.status === 'failed');
    const changed = r.done.filter((it) => it.result.status === 'done');
    const { base } = await dashboardUrl(ctx);
    return ctx.out.result({ id, status: r.record.status, counts: c, backup: r.backup, items: r.record.items.map(({ id: iid, ref, name, decision, note, result }) => ({ id: iid, ref, name, decision, note: redactText(note ?? ''), result })) }, [
      `整理記錄 ${id}：完成 ${c.done} 項、維持原狀 ${c.kept} 項、失敗 ${c.failed} 項；${c.waiting ? `${c.waiting} 項依備註調整，交給你處理。` : '沒有要你處理的備註項目。'}`,
      r.backup ? `動手前的備份：${r.backup}` : null,
      ...changed.map(itemLine),
      ...(failed.length ? ['失敗的項目（其他項目照常執行）：', ...failed.map(itemLine)] : []),
      ...(r.needsClaude.length ? ['', '依備註調整的項目（處理完每一項執行 engram tidy done <id> <項目> --undo <版本> --message "<做了什麼>"；決定不處理時加 --skip）：', ...r.needsClaude.flatMap(claudeBlock)] : []),
      `結果頁：${base}#/tidy?id=${id}`,
    ]);
  }

  if (sub === 'done') {
    const [id, itemId] = rest;
    if (!id || !itemId) throw new CliError('E_USAGE', '請提供整理記錄的 id 與項目編號', '例如：engram tidy done 20261024-153012-k3p9 i5 --undo 1a2b3c4d5e --message "依備註改短說明"');
    const undo = ctx.opts.undo ? String(ctx.opts.undo).split(',').map((s) => s.trim()).filter(Boolean) : [];
    const r = await recordResult(local, id, itemId, { status: ctx.opts.skip ? 'skipped' : 'done', undo, message: ctx.opts.message ?? '' });
    return ctx.out.result(r, `已記錄 ${itemId}：${ctx.opts.skip ? '略過' : '完成'}${r.status === 'done' ? '；這份整理記錄全部完成。' : ''}`);
  }

  throw new CliError('E_USAGE', sub ? `看不懂的子指令：${sub}` : '請指定子指令', '可用的子指令：create、list、show、apply、done');
}
