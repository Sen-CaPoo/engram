// 管理介面的 JSON API：逐一實作 app/src/ui/src/api.js 檔頭列出的端點，對應到引擎呼叫（40 號 §15）。
// 回傳型別與引擎一致；外殼只補上引擎沒有的部分（常駐程式狀態、核心準則載入鏈、本次對話載入的檔案、日誌）。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { countLines, readJson } from '../cli/fsutil.mjs';
import { readLogs } from '../cli/log.mjs';
import { claudeHome as defaultClaudeHome } from '../cli/paths.mjs';
import { buildCoreChain } from './corechain.mjs';
import { claudePluginStatus } from './plugin.mjs';
import { HttpError } from './server.mjs';

/** 'global'、'project:<pid>'、'machine:<mid>'、'project'（只限種類）或 Scope 物件 → Scope 物件 */
export function parseScope(value) {
  if (value == null || value === '' || value === 'all') return undefined;
  if (typeof value === 'object') return value;
  const [kind, id] = String(value).split(':');
  if (kind === 'global') return { kind };
  if (kind === 'project') return id ? { kind, pid: id } : { kind };
  if (kind === 'machine') return id ? { kind, mid: id } : { kind };
  throw new HttpError(400, 'E_INVALID', `看不懂的範圍：${value}`, '範圍格式為 global、project:<pid> 或 machine:<mid>。');
}

function need(value, name) {
  if (value === undefined || value === null || value === '') throw new HttpError(400, 'E_INVALID', `缺少 ${name}`);
  return value;
}

const toInt = (v, def) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

/** 去掉值為 undefined 的鍵，避免把空篩選條件傳給引擎 */
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** 引擎修改動作回傳 ActionResult；沒有回傳值時補上 { ok: true } */
const done = (r) => r ?? { ok: true };

/** 最新（或指定 sessionId）的 local/loaded/<sessionId>.json */
async function readLoaded(dir, session) {
  if (session && session !== 'latest') return readJson(path.join(dir, `${path.basename(session)}.json`));
  const names = (await fsp.readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json'));
  let latest = null;
  for (const n of names) {
    const st = await fsp.stat(path.join(dir, n)).catch(() => null);
    if (st && (!latest || st.mtimeMs > latest.mtimeMs)) latest = { n, mtimeMs: st.mtimeMs };
  }
  return latest ? readJson(path.join(dir, latest.n)) : null;
}

/** 匯入精靈的後端由 app/src/migrate 提供；還沒有時回 501。 */
async function migrate(fn) {
  let mod;
  try {
    mod = await import('../migrate/index.mjs');
  } catch {
    mod = null;
  }
  if (typeof mod?.[fn] !== 'function') throw new HttpError(501, 'E_NOT_IMPLEMENTED', '匯入精靈尚未安裝', '等 app/src/migrate 完成後即可使用。');
  return mod[fn];
}

/**
 * @param {{ eg, jobs, paths, info, settings?, claudeHome?: string }} deps
 */
export function createApi({ eg, jobs, paths, info, settings, claudeHome = defaultClaudeHome() }) {
  /** 引擎較新的 API（設定、機器改名）可能還不存在：缺少時回 501，而不是讓整個請求失敗 */
  const engineFn = (fn, what) => {
    if (typeof fn !== 'function') throw new HttpError(501, 'E_NOT_IMPLEMENTED', `這個版本的引擎還不支援${what}`, '更新 Engram 後再試。');
    return fn;
  };
  const routes = {
    'GET /api/status': async () => ({ ...(await eg.status()), agent: info.statusSummary() }),
    'GET /api/activity': ({ q }) => eg.activity({ days: toInt(q('days'), 30) }),

    'GET /api/memories': ({ q }) => eg.memories.list(clean({ scope: parseScope(q('scope')), pid: q('pid'), type: q('type'), q: q('q'), sort: q('sort') })),
    'GET /api/memory': ({ q }) => eg.memories.read(need(q('ref'), 'ref')),
    // body.raw：原始碼模式，整份檔案（含 frontmatter）直接寫入；frontmatter 格式有誤時介面會改用這個（R-28）
    // allowSecrets：使用者確認內容裡被判定為疑似金鑰的值不是金鑰（引擎記入「不是金鑰」清單後寫入）
    'PUT /api/memory': async ({ q, body }) => done(await eg.memories.write(need(q('ref'), 'ref'), { ...(typeof body.raw === 'string' ? { text: body.raw } : { frontmatter: body.frontmatter, body: body.body }), allowSecrets: body.allowSecrets === true })),
    'POST /api/memory/move': async ({ body }) => done(await eg.memories.move(need(body.ref, 'ref'), need(parseScope(body.scope), 'scope'))),
    'POST /api/memory/merge': async ({ body }) => done(await eg.memories.merge(need(body.refs, 'refs'), { into: body.into, body: body.body })),
    'POST /api/memory/remove': async ({ body }) => done(await eg.memories.remove(need(body.ref, 'ref'))),
    'POST /api/memory/restore': async ({ body }) => done(await eg.memories.restore(need(body.ref, 'ref'), { rev: body.rev })),
    'POST /api/memory/pin': async ({ body }) => {
      const ref = need(body.ref, 'ref');
      await eg.memories.read(ref); // 先確認存在；不存在時引擎丟 E_NOT_FOUND
      // 只改 metadata.engram.pinned 這一個鍵（點分隔路徑），其餘 frontmatter 原樣保留；取消釘選時移除該鍵。
      // 內容沒有變化時引擎直接回傳 { ok: true }，不產生 commit。
      return done(await eg.memories.write(ref, { frontmatter: { 'metadata.engram.pinned': body.pinned ? true : undefined } }));
    },
    'GET /api/search': ({ q }) => eg.search(q('q') ?? '', { limit: toInt(q('limit'), 20) }),

    'GET /api/projects': () => eg.projects.list(),
    'POST /api/projects/rename': async ({ body }) => done(await eg.projects.rename(need(body.pid, 'pid'), need(body.name, 'name'))),
    'POST /api/projects/link': async ({ body }) => done(await eg.projects.link(need(body.from, 'from'), need(body.to, 'to'))),
    'POST /api/identity/bind': ({ body }) => {
      const target = body.pid ? { pid: body.pid } : body.create ? { create: body.create } : {};
      return eg.identity.bind(need(body.dir, 'dir'), target);
    },
    'POST /api/identity/unbind': async ({ body }) => done(await eg.identity.unbind(need(body.dir, 'dir'))),
    'GET /api/identity/pending': async () => (typeof eg.identity.pending === 'function' ? eg.identity.pending() : []),

    'GET /api/findings': () => eg.health(),
    'POST /api/findings/dismiss': async ({ body }) => done(await eg.findings.dismiss(need(body.id, 'id'), clean({ until: body.until }))),

    // 疑似金鑰：一律在本機遮蔽，不經過任何模型（M5）
    'GET /api/secrets/preview': ({ q }) => eg.secrets.preview(need(q('ref'), 'ref')),
    'POST /api/secrets/redact': async ({ body }) => done(await eg.secrets.redact(need(body.ref, 'ref'))),
    'POST /api/secrets/allow': async ({ body }) => done(await eg.secrets.allow(need(body.ref, 'ref'), body.line)),
    // 引擎遇到 merge、edit、open-* 時回傳 { ok:false, needsUi:true, action, args }，原樣轉回給介面處理
    'POST /api/apply': async ({ body }) => done(await eg.apply(need(body.fix, 'fix'))),
    'GET /api/conflicts': () => eg.conflicts.list(),
    'POST /api/conflicts/resolve': async ({ body }) => done(await eg.conflicts.resolve(need(body.id, 'id'), { choice: need(body.choice, 'choice'), body: body.body })),
    'GET /api/history': ({ q }) => eg.history(clean({ ref: q('ref'), limit: q('limit') ? toInt(q('limit'), 50) : undefined })),
    'POST /api/undo': async ({ body }) => done(await eg.undo(need(body.sha, 'sha'))),
    // 撞名資料夾依命名規則改名（SW-4）：盤點與改名紀錄；改名走 /api/apply 的 rename-collisions，還原走 /api/undo 或這裡
    'GET /api/collisions': async () => ({ plan: await engineFn(eg.collisions?.plan, '撞名盤點')(), history: await engineFn(eg.collisions?.list, '改名紀錄')() }),
    'POST /api/collisions/undo': async ({ body }) => done(await engineFn(eg.collisions?.undo, '還原改名')(need(body.id, 'id'))),

    'GET /api/core': async () => {
      const core = await eg.core.read();
      const text = typeof core === 'string' ? core : core?.text ?? '';
      const chain = await buildCoreChain({ claudeHome, engramHome: eg.paths?.home ?? paths.home, corePath: core?.path ?? path.join(eg.paths?.vault ?? paths.vault, 'core', 'CORE.md') });
      return { text, lines: countLines(text), bytes: Buffer.byteLength(text), chain };
    },
    'PUT /api/core': async ({ body }) => {
      if (typeof body.text !== 'string') throw new HttpError(400, 'E_INVALID', '缺少 text');
      return done(await eg.core.write(body.text, { allowSecrets: body.allowSecrets === true }));
    },
    // 41 號 §11：把 ~/.claude/CLAUDE.md 的工作準則搬進 vault，讓所有電腦共用
    'GET /api/core/guidelines': () => eg.core.guidelines.preview(),
    'POST /api/core/guidelines/adopt': async () => done(await eg.core.guidelines.adopt()),
    'POST /api/core/guidelines/revert': async () => done(await eg.core.guidelines.revert()),

    // 設定：同步間隔、健康檢查時間、暫停由常駐程式保存；名稱與自動綁定由引擎保存
    'GET /api/settings': async () => {
      const st = await eg.status();
      const engineSettings = typeof eg.settings?.get === 'function' ? await eg.settings.get() : {};
      return { machineLabel: st.machine?.label ?? eg.machine?.label, remote: st.vault?.remote ?? null, bindAuto: engineSettings.bindAuto ?? 'confident', collisionRename: engineSettings.collisionRename ?? 'ask', ...(settings?.get() ?? {}) };
    },
    'PUT /api/settings': async ({ body }) => {
      if (body.machineLabel !== undefined) await engineFn(eg.machine?.rename, '電腦改名')(String(body.machineLabel).trim());
      if (body.bindAuto !== undefined) await engineFn(eg.settings?.set, '自動綁定設定')({ bindAuto: body.bindAuto });
      if (body.collisionRename !== undefined) await engineFn(eg.settings?.set, '撞名資料夾改名設定')({ collisionRename: body.collisionRename });
      const local = {};
      for (const k of ['syncIntervalMin', 'healthTime', 'paused']) if (body[k] !== undefined) local[k] = body[k];
      if (Object.keys(local).length) {
        try { await settings.set(local); } catch (err) { throw new HttpError(400, err.code ?? 'E_INVALID', err.message); }
        if (local.paused !== undefined) await settings.writePaused(jobs.paused());
      }
      return routes['GET /api/settings']();
    },

    // 進度與結果經由 SSE 的 sync 事件。hook 的 session-end 通知也走這裡（附 reason、sessionId），順便檢查待切換的綁定。
    'POST /api/sync': ({ body }) => {
      jobs.run('sync', body.reason ?? 'manual');
      if (body.reason === 'session-end') jobs.run('bind', 'session-end');
      return { started: true };
    },
    'GET /api/loaded': ({ q }) => readLoaded(paths.loaded, q('session') ?? 'latest'),

    // 「交給 Claude」的引導：外掛是否已安裝並啟用、有哪些 /engram 技能（唯讀）
    'GET /api/claude-plugin': () => claudePluginStatus({ claudeHome, installFile: paths.installFile }),
    'GET /api/agent': () => info.get(),
    'POST /api/jobs/run': ({ body }) => {
      jobs.run(need(body.id, 'id'), 'manual');
      return { started: true };
    },
    'POST /api/jobs/toggle': async ({ body }) => {
      jobs.toggle(need(body.id, 'id'), !!body.enabled);
      return info.get();
    },
    'GET /api/logs': ({ q }) => readLogs(paths.logs, 'agent', { level: q('level'), limit: Math.min(toInt(q('limit'), 200), 1000) }),

    'POST /api/import/plan': async ({ body }) => (await migrate('planImport'))(eg, body),
    'POST /api/import/rehearse': async ({ body }) => (await migrate('rehearseImport'))(eg, body),
    'POST /api/import/apply': async ({ body }) => (await migrate('applyImport'))(eg, body),
    'POST /api/import/undo': async ({ body }) => (await migrate('undoImport'))(eg, { ...body, tag: need(body.tag, 'tag') }),
  };

  return {
    routes: Object.keys(routes),
    async handle(method, pathname, query, body) {
      const fn = routes[`${method} ${pathname}`];
      if (!fn) throw new HttpError(404, 'E_NOT_FOUND', `沒有這個端點：${method} ${pathname}`);
      const q = (name) => query.get(name) ?? undefined;
      return fn({ q, body: body && typeof body === 'object' ? body : {} });
    },
  };
}
