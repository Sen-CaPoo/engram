// 衝突隔離區 vault/conflicts/<id>/（R-07：會同步）。格式與 mergedriver.mjs 相同：
// ours.md、theirs.md、base.md（可能沒有）、meta.json { id, ref, kind, createdAt, summary, ... }
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { E, EngramError, invariant } from './errors.mjs';
import { parseMemoryFile, setFields } from './frontmatter.mjs';
import { exists, readJson, readText, safeWrite, stableJson } from './fsx.mjs';
import { git } from './git.mjs';
import { backupFile } from './healbackup.mjs';
import { makeConflictId, uniqueFileName } from './ids.mjs';
import { fromRef, toRef } from './paths.mjs';
import { assertNoNewSecrets } from './secretallow.mjs';
import { redactSecrets } from './secrets.mjs';
import { commitPaths, safeMachineLabel } from './vault.mjs';

export function conflictsDir(vaultDir) {
  return path.join(vaultDir, 'conflicts');
}

const MID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const validMid = (x) => (typeof x === 'string' && MID_RE.test(x) ? x : null);

/**
 * 建立一筆衝突紀錄（合併器以外的情況：修改與刪除衝突、非 Markdown 檔等）。
 * summaryEn：summary 的英文版，存在 meta.en.summary（管理介面切到英文時顯示）；沒有傳 summary 時兩者都用預設。
 * recordedOn、otherMachine（第四輪審查 F-01）：記下紀錄的那台（ours.md 是它的版本）與另一邊最後改這個檔的那台（theirs.md），
 * 環境設定檔與護欄規則檔的紀錄依它們換算觀點。不用 by：by 是紀錄的來源（例如自我修復的 heal）。
 */
export async function quarantine(vaultDir, { ref, kind = 'content', ours = null, theirs = null, base = null, summary, summaryEn, by, healBackup, recordedOn, otherMachine }) {
  await fsp.mkdir(conflictsDir(vaultDir), { recursive: true });
  // 獨占建立資料夾；id 碰撞（EEXIST）就換一個，絕不覆蓋既有紀錄（BUG-7）
  let id; let dir;
  for (let i = 0; ; i++) {
    id = makeConflictId();
    dir = path.join(conflictsDir(vaultDir), id);
    try { await fsp.mkdir(dir); break; } catch (err) { if (err.code !== 'EEXIST' || i > 20) throw err; }
  }
  if (ours !== null) await safeWrite(path.join(dir, 'ours.md'), ours);
  if (theirs !== null) await safeWrite(path.join(dir, 'theirs.md'), theirs);
  if (base !== null) await safeWrite(path.join(dir, 'base.md'), base);
  const en = summary === undefined || summary === null ? `${ref} was modified differently on two computers` : summaryEn;
  // meta.json 會跟著 vault 推送：摘要先遮蔽疑似金鑰
  const safe = (t) => redactSecrets(String(t)).text;
  await safeWrite(path.join(dir, 'meta.json'), stableJson({
    id, ref, kind, createdAt: new Date().toISOString(), summary: safe(summary ?? `${ref} 在兩台電腦有不同的修改`), ...(en ? { en: { summary: safe(en) } } : {}), ...(by ? { by } : {}), ...(healBackup ? { healBackup } : {}),
    ...(validMid(recordedOn) ? { recordedOn } : {}), ...(validMid(otherMachine) ? { otherMachine } : {}),
  }));
  return id;
}

/** 一台電腦的顯示名稱（同步來的 machine.json，只用來顯示；和核心準則的電腦清單同一套限制，不符合時用電腦代號） */
async function machineName(vaultDir, mid) {
  if (!mid) return null;
  const m = await readJson(path.join(vaultDir, 'machines', mid, 'machine.json'), null).catch(() => null);
  return safeMachineLabel(m?.label) ?? mid;
}

/**
 * 環境設定檔與護欄規則檔的紀錄在這台電腦的觀點（第四輪審查 F-01；listConflicts 與 resolveJsonConflict 共用）。
 * 紀錄的 ours.md 是記下紀錄的那台（recordedOn）的版本、theirs.md 是另一台（otherMachine）的版本。
 * view：recorder（這台記下的）、other（這台就是另一台：兩邊對調）、third（兩邊都不是這台，或不知道另一台是誰：不對調，用電腦名稱描述）、
 *   legacy（沒有記下是哪台的舊紀錄：不猜，只能維持目前的值、移除紀錄）。
 * fileOf(choice)：使用者選的 choice 對應到紀錄裡的哪個檔（recorder／other：ours＝這台的版本、theirs＝另一台的版本；
 *   third：ours＝左邊那台、theirs＝右邊那台）。sides、choiceLabels 是對調之後、給介面與 CLI 顯示的。
 */
async function jsonView(vaultDir, meta, mid) {
  const R = validMid(meta.recordedOn);
  const O = validMid(meta.otherMachine);
  const view = !R ? 'legacy' : R === mid ? 'recorder' : O === mid ? 'other' : 'third';
  const swap = view === 'other';
  const nameR = await machineName(vaultDir, R);
  const nameO = await machineName(vaultDir, O);
  const sides = swap ? { ours: { machine: O, label: nameO }, theirs: { machine: R, label: nameR } } : { ours: { machine: R, label: nameR }, theirs: { machine: O, label: nameO } };
  const fileOf = (choice) => ((choice === 'ours') !== swap ? 'ours' : 'theirs');
  // 選項的說法：這台／另一台；第三台用兩台的名稱（不知道另一台是誰時說「另一台電腦」）
  const otherZh = sides.theirs.label ?? '另一台電腦';
  const otherEn = sides.theirs.label ?? 'the other computer';
  const said = view === 'legacy' ? { zh: { ours: '目前的值' }, en: { ours: 'the current value' } }
    : view === 'third' ? { zh: { ours: `${sides.ours.label} 的版本`, theirs: `${otherZh} 的版本` }, en: { ours: `${sides.ours.label}'s version`, theirs: `${otherEn}'s version` } }
      : { zh: { ours: '這台的版本', theirs: '另一台的版本' }, en: { ours: "this computer's version", theirs: "the other computer's version" } };
  const choiceLabels = view === 'legacy' ? { ours: '維持目前的值，只移除紀錄' }
    : view === 'third' ? { ours: `用 ${sides.ours.label} 的版本`, theirs: `用 ${otherZh} 的版本` }
      : { ours: `保留這台（${sides.ours.label}）的版本`, theirs: `改用另一台（${otherZh}）的版本` };
  const choiceLabelsEn = view === 'legacy' ? { ours: 'Keep the current value and only remove the record' }
    : view === 'third' ? { ours: `Use ${sides.ours.label}'s version`, theirs: `Use ${otherEn}'s version` }
      : { ours: `Keep this computer's (${sides.ours.label}) version`, theirs: `Use the other computer's (${otherEn}) version` };
  return { view, swap, sides, fileOf, said, choiceLabels, choiceLabelsEn, choices: view === 'legacy' ? ['ours'] : ['theirs', 'ours'] };
}

/**
 * mid：這台電腦（第四輪審查 F-01：環境設定檔與護欄規則檔的紀錄依觀點對調兩邊、附上 view、sides、choiceLabels）。
 * @returns {Promise<{ id, ref, kind, createdAt, ours, theirs, base, summary, en?: { summary } }[]>} 舊的紀錄沒有 en
 */
export async function listConflicts(vaultDir, mid = null) {
  let ids = [];
  try { ids = (await fsp.readdir(conflictsDir(vaultDir), { withFileTypes: true })).filter((d) => d.isDirectory() && d.name.startsWith('cf_')).map((d) => d.name); } catch { return []; }
  const out = [];
  for (const id of ids.sort()) {
    const dir = path.join(conflictsDir(vaultDir), id);
    const meta = (await readJson(path.join(dir, 'meta.json'), null)) ?? { id };
    let ours = await readText(path.join(dir, 'ours.md'));
    let theirs = await readText(path.join(dir, 'theirs.md'));
    // 第三輪審查 R4：環境設定檔與護欄規則檔的紀錄只能選 theirs、ours（兩者都保留、手動合併不適用）；
    // 第四輪審查 F-01：依這台的觀點對調兩邊（介面與 CLI 不必知道觀點），附上兩邊是哪台與選項的說法
    let view = null;
    const v = JSON_REFS.has(meta.ref) ? await jsonView(vaultDir, meta, mid) : null;
    if (v) {
      if (v.swap) [ours, theirs] = [theirs, ours];
      view = {
        choices: v.choices, view: v.view, sides: v.sides, choiceLabels: v.choiceLabels,
        ...(v.view === 'recorder' || v.view === 'other' ? { otherMachine: v.sides.theirs.label ?? undefined } : {}),
      };
    }
    out.push({
      id,
      ref: meta.ref ?? null,
      kind: meta.kind ?? 'content',
      createdAt: meta.createdAt ?? null,
      ours,
      theirs,
      base: await readText(path.join(dir, 'base.md')),
      summary: meta.summary ?? '',
      ...(typeof meta.by === 'string' && meta.by ? { by: meta.by } : {}),
      ...(view ?? {}),
      ...((typeof meta.en?.summary === 'string' && meta.en.summary) || view ? {
        en: {
          ...(typeof meta.en?.summary === 'string' && meta.en.summary ? { summary: meta.en.summary } : {}),
          ...(v ? { choiceLabels: v.choiceLabelsEn } : {}),
        },
      } : {}),
    });
  }
  return out;
}

/** 同步時逐項合併的 JSON 檔（第二輪審查 R4）：兩邊都改了同一個鍵或同一條規則時，輸的那一邊記成衝突紀錄 */
const JSON_REFS = new Set(['env/profile.json', 'guardrails/rules.json']);

/**
 * 處理衝突。choice：'ours' 保留目前檔案；'theirs' 改用對方版本；'both' 對方版本另存一筆；'manual' 寫入 body。
 * reviewed：結果記為確認過（true 或來源字串；CLI 在 Claude Code 裡執行時傳 claude，第三輪審查 A）；自動駕駛傳 false。
 * 環境設定檔與護欄規則檔的紀錄另外處理（resolveJsonConflict）。
 * 回傳 { ok, ref, commit?, undo?, backup? }；環境設定檔與護欄規則檔另外有 changed、message、en.message（做了什麼）。
 */
export async function resolveConflict(ctx, id, { choice, body, reviewed = true } = {}) {
  invariant(['ours', 'theirs', 'both', 'manual'].includes(choice), 'choice 必須是 ours、theirs、both 或 manual', undefined, { message: 'choice must be ours, theirs, both, or manual' });
  // R-45：id 會用來組路徑並遞迴刪除，必須是 cf_ 開頭的單一資料夾名稱，而且就在 conflicts/ 底下
  invariant(typeof id === 'string' && /^cf_[0-9A-Za-z_]+$/.test(id), '不合法的衝突 id', undefined, { message: 'Invalid conflict id' });
  return ctx.locked('conflicts.resolve', async () => {
    const root = conflictsDir(ctx.vault);
    const dir = path.resolve(root, id);
    invariant(path.dirname(dir) === path.resolve(root), '不合法的衝突 id', undefined, { message: 'Invalid conflict id' });
    if (!exists(dir)) throw new EngramError(E.NOT_FOUND, `找不到衝突：${id}`).withEn(`Conflict not found: ${id}`);
    const meta = (await readJson(path.join(dir, 'meta.json'), null)) ?? {};
    if (JSON_REFS.has(meta.ref)) return resolveJsonConflict(ctx, id, dir, meta, choice);
    // meta.ref 來自同步的檔案，同樣要驗證是記憶檔或核心準則
    const { scopeOfRef: refScope } = await import('./memories.mjs');
    const ref = meta.ref && (meta.ref === 'core/CORE.md' || refScope(meta.ref) || /^projects\/[a-z0-9][a-z0-9-]*\/project\.json$/.test(meta.ref)) ? meta.ref : null;
    const theirs = await readText(path.join(dir, 'theirs.md'));
    const touched = [toRef(ctx.vault, dir)];
    let resultRef = ref;
    let backup = null; // 覆蓋原檔前備份的位置（相對於 local/）
    if (ref && choice !== 'ours') {
      const abs = fromRef(ctx.vault, ref);
      if (choice === 'theirs') {
        backup = await backupUncommitted(ctx, abs, ref);
        if (theirs === null) await fsp.rm(abs, { force: true }); // 對方是刪除
        else await safeWrite(abs, theirs);
        touched.push(ref);
      } else if (choice === 'manual') {
        invariant(typeof body === 'string', '手動合併需要提供 body', undefined, { message: 'Manual merge requires a body' });
        await assertNoNewSecrets(ctx.local, ref, body, { before: await readText(abs), what: '合併後的內容' });
        backup = await backupUncommitted(ctx, abs, ref);
        await safeWrite(abs, body);
        touched.push(ref);
      } else if (choice === 'both' && theirs !== null) {
        const destDir = path.dirname(abs);
        const file = uniqueFileName(path.basename(abs), (f) => exists(path.join(destDir, f)));
        const name = file.replace(/\.md$/i, '');
        let text = theirs;
        // 對方版本無法解析時（R-28），保留原文另存，不嘗試改名欄位
        try { if (parseMemoryFile(theirs).hasFrontmatter) text = setFields(theirs, { name }); } catch { text = theirs; }
        await safeWrite(path.join(destDir, file), text);
        resultRef = toRef(ctx.vault, path.join(destDir, file));
        touched.push(resultRef);
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    if (ref) {
      const { scopeOfRef, refreshIndex } = await import('./memories.mjs');
      const scope = scopeOfRef(ref);
      if (scope) touched.push(...await refreshIndex(ctx, scope));
    }
    // 1.4.0：解衝突是使用者看過兩個版本後做的決定，結果記為確認過。
    // 1.5.0：自動駕駛處理的（reviewed: false）不算，留給下一輪的「待你確認」把關
    if (reviewed) {
      const { markReviewed } = await import('./review.mjs');
      touched.push(...await markReviewed(ctx, touched.filter((r) => !/(INDEX|MEMORY)\.md$/i.test(r)), { by: typeof reviewed === 'string' ? reviewed : 'user' }));
    }
    const commit = await commitPaths(ctx.vault, touched, `resolve ${id} (${choice})`, { action: 'resolve', refs: ref ? [ref] : [], mid: ctx.mid });
    return { ok: true, ref: resultRef, commit: commit ?? undefined, undo: commit ? { sha: commit.sha } : undefined, ...(backup ? { backup } : {}) };
  });
}

/**
 * 環境設定檔與護欄規則檔的衝突紀錄（第三輪審查 R4、第四輪審查 F-01）。
 * - 觀點（jsonView）：「保留這台的版本」永遠寫入執行處理的這台的值、「改用另一台的版本」永遠寫入另一台的值；
 *   第三台電腦（兩邊都不是它）：ours＝記下紀錄的那台、theirs＝另一台，訊息用電腦名稱。
 *   沒有記下是哪台的舊紀錄（legacy）：不猜，只能「維持目前的值，只移除紀錄」（ours），theirs 回報 E_INVALID。
 * - 每個兩邊都改了的鍵（或規則），改成選的那一邊的值。檔案裡已經是那個值就不改；是另一邊的值就寫入（和 env set、規則檔的驗證同一套，
 *   不核可：核可記的是鍵＋值或規則內容的雜湊）；兩邊的值都不是（之後又被改過）就回報 E_CONFLICT、紀錄留著。
 *   寫入與移除紀錄在同一個 commit（engram undo 一次還原兩者）；commit 失敗時把檔案與紀錄都還原（U-1）。
 * - both、manual：不適用，回報 E_INVALID、紀錄留著。
 * - 沒有逐項的值（兩邊都讀不懂，或兩個版本沒有兩邊都改過的值）：ours 只移除紀錄；theirs 回報 E_INVALID（F-11：兩種情況的說法不同）。
 */
async function resolveJsonConflict(ctx, id, dir, meta, choice) {
  const ref = meta.ref;
  const what = ref === 'env/profile.json' ? { zh: '環境設定檔', en: 'environment profile' } : { zh: '護欄規則檔', en: 'guardrail rules file' };
  if (choice === 'both' || choice === 'manual') {
    throw new EngramError(E.INVALID, `${what.zh}的衝突只能選「改用另一台的版本」或「保留這台的版本」`, '「兩者都保留」與手動合併不適用；紀錄留著').withEn(`A conflict in the ${what.en} can only be resolved with "use the other computer's version" or "keep this computer's version"`, 'Keeping both or merging by hand does not apply; the record is kept');
  }
  const view = await jsonView(ctx.vault, meta, ctx.mid);
  const record = toRef(ctx.vault, dir);
  const removeOnly = async (zh, en) => {
    fs.rmSync(dir, { recursive: true, force: true });
    const commit = await commitPaths(ctx.vault, [record], `resolve ${id} (${choice})`, { action: 'resolve', refs: [ref], mid: ctx.mid });
    return { ok: true, ref, changed: false, message: zh, en: { message: en }, commit: commit ?? undefined, undo: commit ? { sha: commit.sha } : undefined };
  };
  if (view.view === 'legacy') {
    if (choice !== 'ours') {
      throw new EngramError(E.INVALID, `這筆${what.zh}的衝突紀錄沒有記下是哪台電腦記的，不能判斷哪一邊是這台的版本，所以不能改值`, '看過兩個版本後需要的話自己改設定，再選「維持目前的值，只移除紀錄」').withEn(`This ${what.en} conflict does not say which computer recorded it, so it cannot tell which version is this computer's and will not change any value`, 'Look at both versions, change the setting yourself if needed, then choose "keep the current value and only remove the record"');
    }
    return removeOnly(`沒有改任何值：這筆${what.zh}的衝突紀錄沒有記下是哪台電腦記的，只移除了紀錄。`, `No value was changed: this ${what.en} conflict does not say which computer recorded it, so only the record was removed.`);
  }
  const { jsonConflictValues, sameValue } = await import('./jsonmerge.mjs');
  const ours = await readText(path.join(dir, 'ours.md'));
  const theirs = await readText(path.join(dir, 'theirs.md'));
  const base = await readText(path.join(dir, 'base.md'));
  const values = ours !== null && theirs !== null ? jsonConflictValues(ref, ours, theirs, base) : { unreadable: true };
  const diffs = values.diffs ?? null;
  // 使用者選的那一邊在紀錄裡是哪個檔（依觀點換算）、怎麼稱呼
  const file = view.fileOf(choice);
  const side = { zh: view.said.zh[choice], en: view.said.en[choice] };
  if (!diffs) {
    if (choice === 'theirs') {
      const why = values.unreadable ? { zh: '兩個版本都讀不懂', en: 'neither version could be read' } : { zh: '這筆紀錄的兩個版本沒有兩邊都改過的值', en: 'the two versions in this record have no value that both computers changed' };
      throw new EngramError(E.INVALID, `這筆${what.zh}的衝突紀錄沒有逐項的值（${why.zh}），不能直接改成${side.zh}`, '看過兩個版本後需要的話自己修正檔案，再選「保留這台的版本」移除紀錄').withEn(`This ${what.en} conflict has no per-item values (${why.en}), so ${side.en} cannot be applied`, "Fix the file yourself after looking at both versions if needed, then choose \"keep this computer's version\" to remove the record");
    }
    return removeOnly(`${what.zh}維持目前的內容，移除了這筆紀錄`, `The ${what.en} was kept as it is and the record was removed`);
  }
  const label = (d) => (d.kind === 'setting' ? `setting:${d.key}` : d.key);
  const curText = await readText(fromRef(ctx.vault, ref));
  const doc = (() => { try { return JSON.parse(String(curText ?? '').replace(/^﻿/, '')); } catch { return null; } })();
  const current = (d) => {
    if (!doc || typeof doc !== 'object') return undefined;
    if (d.kind === 'rule') return Array.isArray(doc.rules) ? doc.rules.find((r) => r && r.id === d.key) : undefined;
    const map = doc[d.kind === 'setting' ? 'settings' : 'env'];
    return map && typeof map === 'object' && Object.hasOwn(map, d.key) ? map[d.key] : undefined;
  };
  const change = [];
  const same = [];
  for (const d of diffs) {
    const target = file === 'theirs' ? d.theirs : d.ours;
    const other = file === 'theirs' ? d.ours : d.theirs;
    const now = current(d);
    if (sameValue(now, target)) same.push(d);
    else if (sameValue(now, other)) change.push({ ...d, target });
    else {
      throw new EngramError(E.CONFLICT, `${what.zh}的 ${label(d)} 在這筆紀錄之後又被改過（兩個版本的值都不是），沒有改；紀錄留著`, '看過目前的值後自己決定，再選「保留這台的版本」移除紀錄').withEn(`${label(d)} in the ${what.en} changed after this record was made, so nothing was changed; the record is kept`, "Check the current value, then choose \"keep this computer's version\" to remove the record");
    }
  }
  // 紀錄在所有檢查（env set 的檢查、疑似金鑰、規則驗證）都通過之後才移除，和寫入放在同一個 commit；檢查沒過時紀錄留著。
  // U-1：commit 本身失敗（例如 git 的鎖、提交前的金鑰檢查）時，檔案已改、紀錄已刪：把兩者還原成處理之前的樣子再回報錯誤
  // （紀錄可能還沒進 git，所以先在記憶體留一份，不靠 git 還原）
  const kept = Object.fromEntries((await fsp.readdir(dir).catch(() => [])).map((n) => [n, fs.readFileSync(path.join(dir, n))]));
  const removeRecord = async () => { fs.rmSync(dir, { recursive: true, force: true }); };
  const restore = async () => {
    if (curText === null) await fsp.rm(fromRef(ctx.vault, ref), { force: true }); else await safeWrite(fromRef(ctx.vault, ref), curText);
    await fsp.mkdir(dir, { recursive: true });
    for (const [n, buf] of Object.entries(kept)) fs.writeFileSync(path.join(dir, n), buf);
  };
  let commit = null;
  try {
    if (change.length) {
      if (ref === 'env/profile.json') {
        const { writeProfileValues } = await import('./envsync.mjs');
        commit = (await writeProfileValues(ctx, change.map((d) => ({ area: d.kind, key: d.key, value: d.target })), { extra: [record], beforeCommit: removeRecord })).commit ?? null;
      } else {
        const { writeRuleVersions } = await import('./guardrails.mjs');
        commit = (await writeRuleVersions(ctx, change.map((d) => ({ id: d.key, rule: d.target })), { extra: [record], beforeCommit: removeRecord })).commit ?? null;
      }
    } else {
      await removeRecord();
      commit = await commitPaths(ctx.vault, [record], `resolve ${id} (${choice})`, { action: 'resolve', refs: [ref], mid: ctx.mid });
    }
  } catch (err) {
    if (!exists(dir) || (await readText(fromRef(ctx.vault, ref))) !== curText) await restore().catch(() => {});
    throw err;
  }
  const changedKeys = change.map(label).join('、');
  const sameKeys = same.map(label).join('、');
  const note = ref === 'env/profile.json' ? { zh: '這台還沒核可過的值要核可之後才會套用', en: 'a value this computer has not approved is applied only after you approve it' } : { zh: '內容換了的擋下規則在這台核可之前只會提醒', en: 'a blocking rule whose content changed only warns until this computer approves it' };
  const zh = [change.length ? `已把${what.zh}的 ${changedKeys} 改成${side.zh}的值（${note.zh}）` : null, same.length ? `${sameKeys} 已經是${side.zh}的值，維持不變` : null].filter(Boolean).join('；');
  const en = [change.length ? `Changed ${change.map(label).join(', ')} in the ${what.en} to ${side.en} (${note.en})` : null, same.length ? `${same.map(label).join(', ')} already had ${side.en}, so it was kept` : null].filter(Boolean).join('; ');
  return { ok: true, ref, changed: change.length > 0, message: `${zh}。`, en: { message: `${en}.` }, commit: commit ?? undefined, undo: commit ? { sha: commit.sha } : undefined };
}

/**
 * 要覆蓋的原檔目前有還沒 commit 的內容（和 HEAD 不同、或從未被追蹤；例如自我修復放回的、被扣住的本機版本）時，
 * 先把原檔原封不動另存到 local/backup/<時間>/：那份內容沒進過 git，覆蓋之後連復原都找不回來。
 * 備份失敗就丟錯，不覆蓋。不論由使用者、命令列或自動駕駛呼叫都一樣。
 * @returns {Promise<string|null>} 備份位置（相對於 local/）；原檔不存在或和 HEAD 一樣時 null
 */
async function backupUncommitted(ctx, abs, ref) {
  if (!exists(abs)) return null;
  const st = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ref], { cwd: ctx.vault, allowFail: true });
  if (st.code === 0 && !st.stdout.replace(/\0/g, '').trim()) return null;
  return backupFile(ctx, abs, ref, { source: 'resolve' }); // git 失敗時也備份（寧可多存）
}
