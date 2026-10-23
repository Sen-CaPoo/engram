// 搜尋與寫入記憶。engram remember 是 Claude 寫入全域或單機記憶的正式管道（R-05，ADR §06）。
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseMemoryFile } from '../../core/frontmatter.mjs';
import { parsePositiveInt } from '../args.mjs';
import { CliError } from '../errors.mjs';
import { countLines } from '../fsutil.mjs';
import { scopeLabel } from '../output.mjs';
import { localPaths } from '../paths.mjs';
import { assertNoNewRedaction, assertUnchanged, checkMemoryText, heldNote, isMemoryRef, readSafe, redactText, revOf, undoHint } from './safe.mjs';

export const SCOPES = ['global', 'machine', 'project'];
export const TYPES = ['user', 'feedback', 'project', 'reference'];

export async function cmdSearch(ctx) {
  const q = ctx.args.join(' ').trim();
  if (!q) throw new CliError('E_USAGE', '請提供關鍵字', '例如：engram search powershell');
  const limit = ctx.opts.limit ? parsePositiveInt(ctx.opts.limit, '--limit', { max: 200 }) : 10;
  const eg = await ctx.engine();
  const hits = await eg.search(q, { limit });
  const file = (ref) => path.join(eg.paths.vault, ...String(ref).split('/'));
  const lines = hits.length
    ? [`找到 ${hits.length} 筆：`, ...hits.flatMap((h) => [
      `• ${h.name} — ${h.description}（${scopeLabel(h.scope)}）`,
      h.snippet ? `  ${h.snippet}` : null,
      `  ${file(h.ref)}`,
    ])]
    : `找不到符合「${q}」的記憶。`;
  ctx.out.result(hits, lines);
}

/** 讀標準輸入的全部文字（heredoc）；是終端機時不等待。 */
export async function readStdinText(stdin, timeoutMs = 10_000) {
  if (!stdin || stdin.isTTY) return '';
  return new Promise((resolve) => {
    const chunks = [];
    const finish = () => {
      clearTimeout(timer);
      stdin.removeAllListeners('data');
      stdin.pause();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(finish, timeoutMs);
    stdin.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stdin.once('end', finish);
    stdin.once('error', finish);
  });
}

/**
 * 草稿資料夾：Claude Code 只有 PowerShell 工具時（例如 Git 不在標準位置、偵測不到 Git Bash），不能用 heredoc，
 * Windows PowerShell 5.1 經管線傳中文也可能變成問號。改用 Write 工具把內容寫成這裡的 UTF-8 檔案，再用 --file 交給 engram。
 */
export const draftsDir = () => path.join(localPaths().local, 'drafts');

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 寫入內容的來源：--file <檔案>（UTF-8；開頭的 ~ 是家目錄，PowerShell 不會替外部程式展開）或標準輸入（heredoc）。
 * 回傳的 done() 在寫入成功後呼叫：草稿資料夾裡的檔案用完即刪，其他位置的檔案不動。
 */
export async function readContent(ctx, what) {
  const f = ctx.opts.file;
  if (f) {
    const abs = path.resolve(ctx.cwd, String(f).replace(/^~(?=$|[\\/])/, os.homedir()));
    let text;
    try { text = await fsp.readFile(abs, 'utf8'); } catch { throw new CliError('E_NOT_FOUND', `讀不到 --file 指定的檔案：${abs}`, '確認路徑正確；草稿請寫在 ~/.engram/local/drafts/ 底下。'); }
    text = text.replace(/^\uFEFF/, '');
    if (!text.trim()) throw new CliError('E_USAGE', `${what}是空的（${abs}）`);
    const draft = isInside(abs, draftsDir());
    return { text, done: async () => { if (draft) await fsp.rm(abs, { force: true }).catch(() => {}); } };
  }
  const text = await readStdinText(ctx.io.stdin);
  if (!text.trim()) throw new CliError('E_USAGE', `${what}是空的`, '用標準輸入（heredoc）傳入整份內容，或先寫成 ~/.engram/local/drafts/ 底下的檔案，再加上 --file <檔案>。');
  return { text, done: async () => {} };
}

export async function cmdRemember(ctx) {
  const { opts } = ctx;
  if (!SCOPES.includes(opts.scope)) throw new CliError('E_USAGE', '請用 --scope 指定範圍：global、machine 或 project');
  if (!TYPES.includes(opts.type)) throw new CliError('E_USAGE', '請用 --type 指定類型：user、feedback、project 或 reference');
  if (!opts.name?.trim()) throw new CliError('E_USAGE', '請用 --name 提供名稱（kebab-case 英數，例如 powershell-needs-bom）');
  if (!opts.description?.trim()) throw new CliError('E_USAGE', '請用 --description 提供一句話說明');
  if (opts.body !== undefined && opts.file) throw new CliError('E_USAGE', '--body 與 --file 只能擇一');
  const content = opts.body === undefined && opts.file ? await readContent(ctx, '內文') : null;
  const body = (opts.body ?? content?.text ?? (await readStdinText(ctx.io.stdin))).trim();
  if (!body) throw new CliError('E_USAGE', '內文是空的', '用 --body、--file 或標準輸入（heredoc）提供內文。');
  assertNoNewRedaction(body, []);

  const eg = await ctx.engine();
  let scope;
  if (opts.scope === 'global') scope = { kind: 'global' };
  else if (opts.scope === 'machine') scope = { kind: 'machine', mid: eg.machine.id };
  else {
    const pid = opts.project ?? (await eg.identity.resolve(ctx.cwd))?.pid;
    if (!pid) throw new CliError('E_NOT_BOUND', '目前資料夾沒有綁定專案，無法寫入專案記憶', '加上 --project <pid>，或先執行 engram bind。');
    scope = { kind: 'project', pid };
  }
  const res = await eg.memories.create({
    scope,
    name: opts.name.trim(),
    type: opts.type,
    description: opts.description.trim(),
    body,
    project: scope.kind === 'project' ? undefined : opts.project,
  });
  await content?.done();
  ctx.out.result(res, [`已記住：${res.ref}（${scopeLabel(scope)}）`, await heldNote(eg, res.ref, body)]);
}

// ───────── 讓 Claude 整理記憶（/engram:tidy、/engram:inbox 技能用）：讀取一律遮蔽金鑰，寫入可帶 --base 防止覆蓋 ─────────

/** --to 的值：global、machine、machine:<mid>、project:<pid> */
function parseTarget(value) {
  const [kind, id] = String(value ?? '').split(':');
  if (kind === 'global' && !id) return { kind };
  if (kind === 'machine') return id ? { kind, mid: id } : { kind };
  if (kind === 'project' && id) return { kind, pid: id };
  throw new CliError('E_USAGE', `看不懂的範圍：${value ?? ''}`, '用 --to global、--to machine（這台電腦）、--to machine:<mid> 或 --to project:<pid>');
}

export async function cmdMemory(ctx) {
  const [sub, ...refs] = ctx.args;
  const { opts } = ctx;
  const eg = await ctx.engine();
  const needRef = (n = 1) => {
    if (refs.length < n) throw new CliError('E_USAGE', n > 1 ? `請提供至少 ${n} 筆記憶的 ref` : '請提供記憶的 ref', '例如：global/powershell-bom.md；engram memory list 可以列出所有 ref');
  };

  if (sub === 'list') {
    if (opts.scope && !SCOPES.includes(opts.scope)) throw new CliError('E_USAGE', '--scope 只能是 global、machine 或 project');
    if (opts.type && !TYPES.includes(opts.type)) throw new CliError('E_USAGE', '--type 只能是 user、feedback、project 或 reference');
    const scope = opts.project ? { kind: 'project', pid: opts.project } : opts.scope === 'machine' ? { kind: 'machine', mid: eg.machine.id } : opts.scope;
    // 說明也可能含有金鑰（M5）：輸出前在本機遮蔽
    const list = (await eg.memories.list({ ...(scope ? { scope } : {}), ...(opts.type ? { type: opts.type } : {}) })).map((m) => ({ ...m, name: redactText(m.name ?? ''), description: redactText(m.description ?? '') }));
    const lines = list.length
      ? [`共 ${list.length} 筆：`, ...list.flatMap((m) => [
        `• ${m.ref} · ${m.type ?? '未分類'} · ${(m.size / 1024).toFixed(1)}KB · 更新於 ${String(m.updatedAt ?? '').slice(0, 10) || '—'}${m.pinned ? ' · 已釘選' : ''}${m.findings?.length ? ` · 收件匣 ${m.findings.join(' ')}` : ''}`,
        `  ${m.name} — ${m.description}`,
      ]), '讀取內容：engram memory show <ref>（可以一次多筆）']
      : '這個範圍沒有記憶。';
    return ctx.out.result(list, lines);
  }

  if (sub === 'show') {
    needRef();
    const items = [];
    for (const ref of refs) {
      if (!isMemoryRef(ref)) throw new CliError('E_INVALID', `不是記憶檔：${ref}`, '格式為 global/<檔名>.md、projects/<pid>/memory/<檔名>.md 或 machines/<mid>/<檔名>.md');
      items.push(await readSafe(eg, ref));
    }
    const lines = items.flatMap((m) => (m.exists
      ? [`── ${m.ref}（版本 ${m.rev}${m.redacted ? `；已遮蔽 ${m.redacted} 處疑似金鑰` : ''}）`, m.text.replace(/\n$/, ''), '']
      : [`── ${m.ref}（不存在）`, '']));
    return ctx.out.result(items.length === 1 ? items[0] : items, lines);
  }

  if (sub === 'write') {
    needRef();
    const [ref] = refs;
    const { text, done } = await readContent(ctx, '內容');
    checkMemoryText(text);
    await assertUnchanged(eg, [ref], opts.base);
    const cur = await eg.memories.read(ref);
    assertNoNewRedaction(text, [cur.raw]);
    const r = await eg.memories.write(ref, { text });
    await done();
    // 內容仍疑似含有金鑰時檔案沒有 commit（可能只 commit 了索引），不給 engram undo
    const held = await heldNote(eg, ref, text);
    return ctx.out.result(r, [text !== cur.raw ? `已寫入：${ref}` : `內容沒有變化：${ref}`, held, held ? null : undoHint(r)]);
  }

  if (sub === 'move') {
    needRef();
    const [ref] = refs;
    const to = parseTarget(opts.to);
    await assertUnchanged(eg, [ref], opts.base);
    const r = await eg.memories.move(ref, to);
    return ctx.out.result(r, [`已移到${scopeLabel(to.kind === 'machine' ? { kind: 'machine', mid: to.mid ?? eg.machine.id } : to)}：${r.ref}`, undoHint(r)]);
  }

  if (sub === 'remove') {
    needRef();
    const [ref] = refs;
    await assertUnchanged(eg, [ref], opts.base);
    const r = await eg.memories.remove(ref);
    return ctx.out.result(r, [`已封存：${ref}（移到歷史，可以還原）`, undoHint(r)]);
  }

  if (sub === 'merge') {
    needRef(2);
    const into = opts.into ?? refs[0];
    // 保留的那一筆必須是要合併的其中一筆：不然它沒有版本比對，內容會被直接覆寫
    if (!refs.includes(into)) throw new CliError('E_USAGE', `--into 要是要合併的其中一筆：${into}`, `例如 --into ${refs[0]}`);
    const { text, done } = await readContent(ctx, '合併後的內容');
    // 有 frontmatter 就照用；只有內文時引擎沿用目標檔的 frontmatter。開頭是 --- 卻解析不出 frontmatter（例如少了結尾那行）就拒絕
    if (parseMemoryFile(text).hasFrontmatter || /^\uFEFF?---\s*$/m.test(text.split('\n')[0])) checkMemoryText(text);
    await assertUnchanged(eg, refs, opts.base);
    const originals = [];
    for (const ref of refs) originals.push((await eg.memories.read(ref)).raw);
    assertNoNewRedaction(text, originals);
    const r = await eg.memories.merge(refs, { into, text });
    await done();
    const held = await heldNote(eg, r.ref ?? into, text);
    return ctx.out.result(r, [`已合併 ${refs.length} 筆到 ${r.ref ?? into}；其他 ${refs.filter((x) => x !== into).length} 筆移到歷史。`, held, held ? null : undoHint(r)]);
  }

  throw new CliError('E_USAGE', sub ? `看不懂的子指令：${sub}` : '請指定子指令', '可用的子指令：list、show、write、move、remove、merge');
}

/** 核心準則：engram core 讀取；engram core write 從標準輸入寫入 */
export async function cmdCore(ctx) {
  const [sub] = ctx.args;
  const eg = await ctx.engine();
  if (!sub) {
    const core = await eg.core.read();
    const text = core.text ?? '';
    // 載入預算與健康檢查 H16 相同：核心準則＋全域索引＋這台電腦的單機索引，合計建議 200 行以內
    const indexLines = async (...p) => countLines(await fsp.readFile(path.join(eg.paths.vault, ...p), 'utf8').catch(() => ''));
    const budget = { core: countLines(text), global: await indexLines('global', 'INDEX.md'), machine: await indexLines('machines', eg.machine.id, 'INDEX.md') };
    budget.total = budget.core + budget.global + budget.machine;
    // 版本以原文計算（寫回時比對）；輸出的內容遮蔽疑似金鑰
    const { allowEntries, loadAllow } = await import('../../core/secretallow.mjs');
    const shown = redactText(text, allowEntries(await loadAllow(eg.paths.local), 'core/CORE.md'));
    const data = { path: core.path, rev: revOf(text), lines: budget.core, budget, text: shown };
    return ctx.out.result(data, [
      `── core/CORE.md（版本 ${data.rev}；每次對話開始都會載入）`,
      `載入預算：核心準則 ${budget.core} 行＋全域索引 ${budget.global} 行＋單機索引 ${budget.machine} 行＝${budget.total}／200 行`,
      shown.replace(/\n$/, ''),
    ]);
  }
  if (sub !== 'write') throw new CliError('E_USAGE', `看不懂的子指令：${sub}`, '用 engram core 讀取，engram core write 寫入');
  const { text, done } = await readContent(ctx, '核心準則');
  const before = (await eg.core.read()).text ?? '';
  assertNoNewRedaction(text, [before]);
  if (ctx.opts.base && revOf(before) !== ctx.opts.base) {
    throw new CliError('E_CONFLICT', `核心準則在你讀取之後被修改過（版本 ${ctx.opts.base} → ${revOf(before)}）`, '重新用 engram core 讀取最新內容，再寫一次');
  }
  const r = await eg.core.write(text);
  await done();
  const changed = text.replace(/\r\n/g, '\n') !== before;
  const held = await heldNote(eg, 'core/CORE.md', text);
  ctx.out.result(r, [changed ? '已寫入核心準則，下一次對話生效。' : '核心準則沒有變化。', held, held ? null : undoHint(r)]);
}

/**
 * 「不是金鑰」：由使用者確認（技能不預先允許這個指令，Claude Code 會先徵求同意），一次一個值。
 * --value：還沒寫進記憶的值（例如 remember 被 E_SECRET 擋下）；<ref> --line：既有檔案裡那一行被判定的值。
 */
export async function cmdNotSecret(ctx) {
  const { opts } = ctx;
  const [ref] = ctx.args;
  if (opts.list || opts.remove) {
    const eg = await ctx.engine();
    if (opts.remove) {
      const r = await eg.secrets.removeAllowed(opts.remove);
      return ctx.out.result(r, `已從「不是金鑰」清單移除 ${opts.remove}；含有這個值的檔案會重新被當成疑似金鑰。`);
    }
    const list = await eg.secrets.listAllowed();
    return ctx.out.result(list, list.length ? [`「不是金鑰」清單共 ${list.length} 個值：`, ...list.map((x) => `• ${x.hash}　${x.preview}`), '撤銷：engram not-secret --remove <雜湊>'] : '「不是金鑰」清單是空的。');
  }
  if (!!opts.value === !!ref) throw new CliError('E_USAGE', '請用 --value <值>，或 <ref> --line <行號> 指定（擇一）', '例如：engram not-secret global/ci-notes.md --line 8');
  // 這是使用者本人的確認：不能由 Claude 代為執行（auto、bypass 權限模式下 Claude Code 不一定會先詢問）。
  // 只要變數存在（即使是空字串）就拒絕。這道防線擋的是照著技能做事的 Claude「好心代勞」；刻意繞過的程式本來就能直接寫清單檔，
  // 不另外檢查終端機：Git Bash 預設的 mintty 視窗裡 Node 也偵測不到終端機，會把使用者本人一起擋掉。
  const env = ctx.deps.env ?? process.env;
  if (Object.hasOwn(env, 'CLAUDECODE') || Object.hasOwn(env, 'CLAUDE_CODE_ENTRYPOINT')) {
    throw new CliError('E_CONFIRM', '「不是金鑰」要由你本人確認，不能在 Claude Code 裡執行', '請在你自己的終端機（不是 Claude Code 的對話或 ! 指令）執行同一個指令，或到管理介面（engram ui）按「這不是金鑰」。');
  }
  const eg = await ctx.engine();
  if (opts.value) {
    const r = await eg.secrets.allowValue(opts.value);
    return ctx.out.result(r, `已記入「不是金鑰」清單（${opts.value.slice(0, 4)}…，${opts.value.length} 個字元），會同步到所有電腦。`);
  }
  const line = parsePositiveInt(opts.line, '--line', { max: 1_000_000 });
  const r = await eg.secrets.allow(ref, line);
  ctx.out.result(r, `已把 ${ref} 第 ${line} 行記入「不是金鑰」清單（${r.allowed} 個值），會同步到所有電腦。`);
}

export async function cmdUndo(ctx) {
  const [sha] = ctx.args;
  if (!sha) throw new CliError('E_USAGE', '請提供要復原的版本', '寫入、移動、封存、合併的輸出都會附上「engram undo <版本>」');
  const eg = await ctx.engine();
  const r = await eg.undo(sha);
  ctx.out.result(r, r?.commit ? [`已復原 ${sha}。`, undoHint(r)?.replace('需要復原時執行', '要取消這次復原')] : `已復原 ${sha}（沒有需要變更的檔案）。`);
}
