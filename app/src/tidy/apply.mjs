// 執行整理記錄（engram tidy apply）：使用者在介面核可的項目，照記錄裡的內容執行，不重新生成。
// 動手前把會動到的檔案備份到 ~/.engram/local/backups/<時間>-tidy-<id>/（附 SHA-256 清單）。
// 每一項開始前先確認整項的前提都還成立（版本相符、要新增或搬入的位置沒有同名檔），不成立就整項不動；
// 一項失敗不影響其他項；每做完一步就存進度，中斷後再執行一次會從下一步接著做。
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { revOf } from '../cli/commands/safe.mjs';
import { CliError } from '../cli/errors.mjs';
import { writeJsonAtomic } from '../cli/fsutil.mjs';
import { CORE_REF } from './plan.mjs';
import { applyingNow, busy, counts, readRecord, updateRecord } from './store.mjs';

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** 'global'、'machine:<mid>'、'project:<pid>' → 範圍物件 */
export function scopeFromKey(key) {
  const [kind, id] = String(key).split(':');
  if (kind === 'project') return { kind, pid: id };
  if (kind === 'machine') return { kind, mid: id };
  return { kind: 'global' };
}

const shaOf = (r) => r?.undo?.sha ?? r?.commit?.sha ?? null;
const errInfo = (err) => ({ code: err?.code ?? 'E_INTERNAL', message: err?.message ?? String(err), ...(err?.hint ? { hint: err.hint } : {}), ...(err?.en ? { en: err.en } : {}) });
const norm = (t) => String(t ?? '').replace(/\r\n/g, '\n').replace(/\n*$/, '\n');

/** 會動到的記憶（備份用）：主角、每個動作的對象 */
function refsOf(item) {
  const set = new Set();
  if (item.ref) set.add(item.ref);
  for (const o of item.ops) {
    if (o.op === 'merge') o.refs.forEach((r) => set.add(r));
    else if (o.op !== 'create' && o.ref) set.add(o.ref);
  }
  return [...set];
}

async function backup(eg, rec, items) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(eg.paths.local, 'backups', `${stamp}-tidy-${rec.id}`);
  const files = [];
  for (const ref of [...new Set(items.flatMap(refsOf))]) {
    const src = path.join(eg.paths.vault, ...ref.split('/'));
    const data = await fsp.readFile(src).catch(() => null);
    if (data === null) continue;
    const dest = path.join(dir, 'vault', ...ref.split('/'));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, data);
    const sha256 = createHash('sha256').update(data).digest('hex');
    // 逐檔讀回比對：備份不完整就不動手
    const back = await fsp.readFile(dest);
    if (createHash('sha256').update(back).digest('hex') !== sha256) throw new CliError('E_INTERNAL', `備份 ${ref} 時讀回的內容不一致，已停止`, `檢查磁碟空間與 ${dir}`);
    files.push({ ref, bytes: data.length, sha256 });
  }
  await writeJsonAtomic(path.join(dir, 'manifest.json'), { record: rec.id, at: new Date().toISOString(), files });
  return dir;
}

/** 目前的內容（不存在時 null） */
async function currentRaw(eg, ref) {
  if (ref === CORE_REF) return (await eg.core.read()).text ?? '';
  try { return (await eg.memories.read(ref)).raw; } catch (err) {
    if (err?.code === 'E_NOT_FOUND') return null;
    throw err;
  }
}

async function assertBase(eg, ref, base) {
  if (!base) return;
  const cur = await currentRaw(eg, ref);
  if (cur === null) throw new CliError('E_NOT_FOUND', `${ref} 已經不存在（建議之後被搬走或刪除了）`, '重新整理一次，讓 Claude 依最新的內容提出建議').withEn(`${ref} no longer exists (it was moved or deleted after the suggestion)`, 'Run a new tidy-up so Claude can suggest changes based on the latest content.');
  const rev = revOf(cur);
  if (rev !== base) throw new CliError('E_CONFLICT', `${ref} 在建議之後被修改過（版本 ${base} → ${rev}），沒有寫入`, '可能是另一台電腦同步過來或你在介面改過；重新整理一次，讓 Claude 依最新的內容提出建議').withEn(`${ref} changed after the suggestion (version ${base} → ${rev}), so nothing was written`, 'Another computer may have synced a change, or you edited it in the dashboard. Run a new tidy-up so Claude can suggest changes based on the latest content.');
}

function taken(ref) {
  return new CliError('E_CONFLICT', `${ref} 在建議之後已經有同名的記憶，沒有覆寫`, '重新整理一次，讓 Claude 依最新的內容提出建議').withEn(`A memory named ${ref} appeared after the suggestion, so it was not overwritten`, 'Run a new tidy-up so Claude can suggest changes based on the latest content.');
}

/** 一項開始前確認整項的前提：版本相符、要新增或搬入的位置還沒有同名檔。任何一個不符就整項不動。 */
async function precheck(eg, item, start) {
  if (item.decision === 'archive') return assertBase(eg, item.ref, item.base);
  for (const op of item.ops.slice(start)) {
    if (op.op === 'merge') {
      for (const [k, r] of op.refs.entries()) await assertBase(eg, r, op.bases?.[k]);
      continue;
    }
    if (op.base) await assertBase(eg, op.ref, op.base);
    if (op.op === 'create' && (await currentRaw(eg, op.ref)) !== null) throw taken(op.ref);
    if (op.op === 'move' && op.dest && (await currentRaw(eg, op.dest)) !== null) throw taken(op.dest);
  }
}

/** 執行一個動作，回傳 { sha, ref? }（ref：動作之後這筆記憶的位置） */
async function runOp(eg, op) {
  switch (op.op) {
    case 'write':
      return { sha: shaOf(await eg.memories.write(op.ref, { text: op.content })) };
    case 'move': {
      const r = await eg.memories.move(op.ref, scopeFromKey(op.to));
      return { sha: shaOf(r), ref: r.ref };
    }
    case 'remove':
      return { sha: shaOf(await eg.memories.remove(op.ref)) };
    case 'merge': {
      const r = await eg.memories.merge(op.refs, { into: op.into, text: op.content });
      return { sha: shaOf(r), ref: r.ref };
    }
    case 'create': {
      // 整份內容原樣寫入（使用者在介面看到的就是這一份），frontmatter 的其他欄位一併保留
      const r = await eg.memories.create({ scope: scopeFromKey(op.scope), name: op.name, type: op.type, description: op.description, body: op.body, text: op.content });
      return { sha: shaOf(r), ref: r.ref };
    }
    case 'core':
      return { sha: shaOf(await eg.core.write(op.content)) };
    default:
      throw new CliError('E_INVALID', `不認得的動作：${op.op}`);
  }
}

/** 這台電腦在 since 之後、對這個位置做的某種動作的 commit（續做時用來確認「那一步確實是我們做的」並找回版本） */
async function findCommit(eg, ref, action, since) {
  if (!since) return null;
  const from = Date.parse(since) - 2000; // commit 時間只到秒
  try {
    return (await eg.history({ ref, limit: 10 })).find((c) => c.action === action && c.machine === eg.machine.id && Date.parse(c.at) >= from) ?? null;
  } catch { return null; }
}

/**
 * 續做時：上次中斷前這一步可能已經 commit 了、只是還來不及記下。
 * 檔案的狀態要符合、而且變更紀錄裡要有這台電腦在這一項開始之後做的同一種動作，才算做過（避免把別人刪掉或搬走的當成自己做的）。
 * 回傳 { at: 這一步之後的位置, sha }；沒做過時 null。
 */
async function alreadyDone(eg, op, since) {
  const has = async (r) => (await currentRaw(eg, r)) !== null;
  const found = async (at, action, required) => {
    const c = await findCommit(eg, at, action, since);
    return c || !required ? { at, sha: c?.sha ?? null } : null;
  };
  switch (op.op) {
    case 'write':
    case 'core':
    case 'create': {
      const cur = await currentRaw(eg, op.ref);
      // 內容和核可的完全相同是很強的證據；commit 找不到時仍算完成，只是沒有復原版本
      return cur !== null && norm(cur) === norm(op.content) ? found(op.ref, op.op === 'create' ? 'create' : 'edit', false) : null;
    }
    case 'move':
      return op.dest && !(await has(op.ref)) && (await has(op.dest)) ? found(op.dest, 'move', true) : null;
    case 'remove':
      return (await has(op.ref)) ? null : found(op.ref, 'remove', true);
    case 'merge': {
      for (const r of op.refs) if (r !== op.into && (await has(r))) return null;
      return (await has(op.into)) ? found(op.into, 'merge', true) : null;
    }
    default:
      return null;
  }
}

const result = (status, extra = {}) => ({ status, ...extra, at: new Date().toISOString() });

/** 依決定處理一項；save(progress) 把做到哪裡存回記錄。回傳 result。 */
async function runItem(eg, item, save) {
  if (item.decision === 'keep' || (item.decision === 'accept' && item.action === 'keep')) return result('kept');
  if (item.decision === 'custom') return result('needs-claude');
  if (item.decision !== 'accept' && item.decision !== 'archive') return result('kept', { message: '沒有決定，維持原狀', en: { message: 'No decision, kept as is' } });
  const resumed = !!item.progress;
  const prog = { done: item.progress?.done ?? 0, undo: [...(item.progress?.undo ?? [])], refs: [...(item.progress?.refs ?? [])], startedAt: item.progress?.startedAt ?? new Date().toISOString() };
  try {
    if (item.decision === 'archive') {
      if (resumed && (await currentRaw(eg, item.ref)) === null) {
        const c = await findCommit(eg, item.ref, 'remove', item.progress.startedAt);
        if (c) return result('done', { undo: [c.sha] });
      }
      await precheck(eg, item, 0);
      await save(prog);
      return result('done', { undo: [shaOf(await eg.memories.remove(item.ref))].filter(Boolean) });
    }
    if (resumed && prog.done < item.ops.length) {
      const d = await alreadyDone(eg, item.ops[prog.done], item.progress.startedAt);
      if (d) {
        if (d.sha) prog.undo.push(d.sha);
        if (['create', 'move', 'merge'].includes(item.ops[prog.done].op)) prog.refs.push(d.at);
        prog.done++;
        await save(prog);
      }
    }
    await precheck(eg, item, prog.done);
    if (!resumed) await save(prog); // 記下「這一項開始了」，中斷後才知道要檢查哪一步是否已完成
    for (let k = prog.done; k < item.ops.length; k++) {
      const r = await runOp(eg, item.ops[k]);
      if (r.sha) prog.undo.push(r.sha);
      if (r.ref) prog.refs.push(r.ref);
      prog.done = k + 1;
      await save(prog);
    }
    return result('done', { undo: prog.undo.filter(Boolean), ...(prog.refs.length ? { refs: prog.refs } : {}) });
  } catch (err) {
    // 已完成的動作照樣留著復原的版本，讓使用者可以退回
    return result('failed', { error: errInfo(err), message: err?.message ?? String(err), undo: prog.undo.filter(Boolean) });
  }
}

/**
 * 執行一份整理記錄。只處理還沒有結果的項目，所以中斷後再執行一次會接著做。
 * @returns {Promise<{ record: object, done: object[], needsClaude: object[], backup: string|null }>}
 */
export async function applyRecord(eg, id) {
  const local = eg.paths.local;
  // 取得執行權：同一份記錄同時只能有一個程序在執行
  const rec = await updateRecord(local, id, (r) => {
    if (r.status === 'pending') throw new CliError('E_INVALID', '這份整理記錄還沒有產生執行指令', '請使用者先到「記憶整理」逐項決定，按「產生執行指令」').withEn('No run command has been generated for this tidy-up record yet', 'Decide each item under Tidy-up first, then click "Generate run command".');
    if (r.status === 'done') throw new CliError('E_INVALID', '這份整理記錄已經執行完畢', '要再整理一次時，回到「記憶整理」開始新的一次').withEn('This tidy-up record has already been carried out', 'To tidy up again, start a new one from Tidy-up.');
    if (applyingNow(r)) throw busy();
    const noNote = r.items.filter((it) => !it.result && it.decision === 'custom' && !String(it.note ?? '').trim());
    if (noNote.length) throw new CliError('E_INVALID', `「依備註調整」的項目沒有備註：${noNote.map((it) => it.name).join('、')}`, '請使用者到「記憶整理」補上備註，再按「產生執行指令」').withEn(`Items set to "Adjust per note" have no note: ${noNote.map((it) => it.name).join(', ')}`, 'Add the notes under Tidy-up, then click "Generate run command" again.');
    r.status = 'applying';
    r.applyingPid = process.pid;
    r.applyingSince = new Date().toISOString();
  });

  try {
    const todo = rec.items.filter((it) => !it.result);
    if (!rec.backup && todo.length) {
      const dir = await backup(eg, rec, todo.filter((it) => it.decision && it.decision !== 'keep'));
      await updateRecord(local, id, (r) => { r.backup = dir; });
      rec.backup = dir;
    }
    for (const item of todo) {
      const save = (progress) => updateRecord(local, id, (r) => { r.items.find((x) => x.id === item.id).progress = progress; });
      const res = await runItem(eg, item, save);
      await updateRecord(local, id, (r) => {
        const x = r.items.find((y) => y.id === item.id);
        x.result = res;
        delete x.progress;
      });
    }
  } finally {
    await updateRecord(local, id, (r) => {
      const waiting = r.items.some((it) => it.result?.status === 'needs-claude');
      const unfinished = r.items.some((it) => !it.result);
      r.status = unfinished ? 'ready' : waiting ? 'finishing' : 'done';
      if (!unfinished) r.appliedAt ??= new Date().toISOString();
      delete r.applyingPid;
      delete r.applyingSince;
    });
  }
  const after = await readRecord(local, id);
  return {
    record: after,
    backup: after.backup ?? null,
    done: after.items.filter((it) => it.result && it.result.status !== 'needs-claude'),
    needsClaude: after.items.filter((it) => it.result?.status === 'needs-claude'),
  };
}

/**
 * Claude 處理完「依備註調整」或失敗的項目後記回結果（engram tidy done）。
 * status：done（已處理）或 skipped（沒有處理，附說明）。
 */
export async function recordResult(localDir, id, itemId, { status = 'done', undo = [], message = '' } = {}) {
  if (!['done', 'skipped'].includes(status)) throw new CliError('E_INVALID', 'status 只能是 done 或 skipped');
  for (const s of undo) if (!SHA_RE.test(String(s))) throw new CliError('E_INVALID', `不合法的版本：${s}`, '填 engram 指令輸出的「engram undo <版本>」裡的版本');
  return updateRecord(localDir, id, (r) => {
    const it = r.items.find((x) => x.id === itemId);
    if (!it) throw new CliError('E_NOT_FOUND', `找不到項目：${itemId}`, 'engram tidy show <id> 可以看所有項目的編號');
    if (!['needs-claude', 'failed'].includes(it.result?.status)) throw new CliError('E_INVALID', `項目 ${itemId} 不是等 Claude 處理的狀態（目前：${it.result?.status ?? '尚未執行'}）`);
    it.result = { status, undo: [...(it.result.status === 'failed' ? it.result.undo ?? [] : []), ...undo.map(String)], message: String(message).slice(0, 2000), by: 'claude', at: new Date().toISOString() };
    if (r.status === 'finishing' && !r.items.some((x) => x.result?.status === 'needs-claude')) r.status = 'done';
    return { ok: true, item: it, status: r.status };
  });
}

/** 復原一項：把這一項產生的變更依相反順序 engram undo */
export async function undoItem(eg, id, itemId) {
  const rec = await readRecord(eg.paths.local, id);
  const it = rec.items.find((x) => x.id === itemId);
  if (!it) throw new CliError('E_NOT_FOUND', `找不到項目：${itemId}`).withEn(`Item not found: ${itemId}`);
  const shas = it.result?.undo ?? [];
  if (!shas.length || it.result.status === 'undone') throw new CliError('E_INVALID', '這一項沒有可以復原的變更').withEn('This item has no changes to undo');
  const reverted = [];
  try {
    for (const sha of [...shas].reverse()) {
      const r = await eg.undo(sha);
      reverted.push(r?.undo?.sha ?? null);
    }
  } finally {
    if (reverted.length) {
      await updateRecord(eg.paths.local, id, (r) => {
        const x = r.items.find((y) => y.id === itemId);
        const all = reverted.length === shas.length;
        // 依相反順序復原：已復原的是最後幾個；沒復原到的留在 undo，下次接著復原
        x.result = {
          ...x.result,
          status: all ? 'undone' : x.result.status,
          undo: shas.slice(0, shas.length - reverted.length),
          undoneAt: new Date().toISOString(),
          reverted: [...(x.result.reverted ?? []), ...reverted.filter(Boolean)],
          ...(all ? {} : { message: `只復原了 ${reverted.length}／${shas.length} 個變更`, en: { message: `Undid only ${reverted.length} of ${shas.length} changes` } }),
        };
      });
    }
  }
  return { ok: true, reverted: reverted.filter(Boolean) };
}

export { counts };
