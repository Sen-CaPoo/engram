// 情境召回（2.0.0 P3）：使用者送出訊息時，附上最多 3 筆「和這則訊息相關、但不在這次對話已載入的索引裡」的記憶，只有 Claude 看得到。
// 索引是常駐程式建好的 local/cache/recall.json（以修改時間判斷要不要重讀，快取在模組變數）；計分是 lens/recall.mjs 的純函式。
// 任何錯誤或超過 250 毫秒就原樣送出：情境召回壞掉或太慢絕不能擋住使用者的訊息。超時的那次讀檔會在背景讀完，下一則訊息就用得到。
// 帶出的 ref 寫進這個程序自己的紀錄檔 local/usage/recall/<日期>.<程序代號>.jsonl（時間、對話 id、ref、分數；同時開著好幾個 Claude Code 也不會互相覆蓋），
// 寫不了不影響送出。同一場對話帶過的不重複：記在模組變數，第一次看到一場對話時再從今天與昨天的紀錄補上（重新啟動或熱重載之後也記得）。
// mod 沒有載入時，由指令型的 UserPromptSubmit hook（hooks/recall-hook.mjs）用同一份計分做；它看到 guard.ts 在開場寫的標記檔就不做。
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import { contextText, parseIndex, projectOf, recalledIn, recallMode, recentUsageFiles, score, TIMEOUT_MS, usageFileName, usageLine } from './lens/recall.mjs'
import { normPath } from './lens/model.mjs'

type Index = NonNullable<ReturnType<typeof parseIndex>>
type Hit = ReturnType<typeof score>[number]

// 模組變數在熱重載後會重來，只放可以重算的東西
let cachedHome: string | null = null
let headless: boolean | null = null
let index: { mtime: number; value: Index | null } | null = null
let loading: Promise<Index | null> | null = null
let mode: { sig: string; on: boolean } | null = null
/** 這場對話已經帶過的 ref（不重複帶） */
const recalled = new Map<string, Set<string>>()
/** 已經從紀錄補上「帶過的」的對話 */
const seeded = new Set<string>()
/** 已經確認有標記檔的對話 → 上次確認的時間。每天重寫一次標記檔：每週的清理只刪超過 7 天沒動的，開了很久的對話才不會被清掉標記 */
const marked = new Map<string, number>()
const MARK_REFRESH_MS = 24 * 3600 * 1000
/** 這個程序的代號：帶出紀錄各寫各的檔 */
const INSTANCE = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
// 寫檔排成一串：連續送出的訊息，先讀再寫才不會互相覆蓋
let writing: Promise<void> = Promise.resolve()

/** 使用者自己送出的訊息：在終端機按 Enter（composer）、Remote Control（bridge）、claude -p 與 SDK（sdk）；沒有 origin 也算 */
const USER_ORIGINS = new Set(['composer', 'bridge', 'sdk'])
const fromUser = (origin: PromptOrigin | undefined) => !origin || USER_ORIGINS.has(origin.kind)

async function engramHome($: EngineInterface): Promise<string> {
  if (cachedHome) return cachedHome
  const home: string = normPath((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '')
  const explicit = await $.env.get('ENGRAM_HOME')
  // 家目錄不明又沒有指定 ENGRAM_HOME：路徑會變成磁碟根目錄的 /.engram，寧可不做事
  if (!explicit && !home) throw new Error('home directory unknown')
  const found: string = normPath(explicit ?? `${home}/.engram`)
  cachedHome = found
  return found
}

/** 自動駕駛等背景的 claude -p 帶 ENGRAM_HEADLESS=1：那些對話不是使用者的，不帶記憶、也不記入統計 */
async function isHeadless($: EngineInterface): Promise<boolean> {
  if (headless === null) headless = (await $.env.get('ENGRAM_HEADLESS')) === '1'
  return headless
}

async function mtimeOf($: EngineInterface, file: string): Promise<number> {
  try {
    return (await $.fs.stat(file)).mtimeMs
  } catch {
    return -1
  }
}

const textOf = async ($: EngineInterface, file: string, mtime: number): Promise<string | null> => {
  if (mtime < 0) return null
  try {
    return await $.fs.read(file)
  } catch {
    return null
  }
}

/**
 * 實際生效的 recall：這台的設定（local/settings.json）與所有電腦共用的索引分層（vault/settings.json；on 時強制開啟）。
 * 兩個檔的修改時間都沒變就用快取
 */
async function recallOn($: EngineInterface, files: [string, string], mtimes: [number, number]): Promise<boolean> {
  const sig = mtimes.join('|')
  if (mode?.sig === sig) return mode.on
  const [local, shared] = await Promise.all([textOf($, files[0], mtimes[0]), textOf($, files[1], mtimes[1])])
  const on = recallMode(local, shared) === 'on'
  mode = { sig, on }
  return on
}

/** 索引：修改時間沒變就用快取；讀檔中的話等同一次讀檔（超時的那次也會讀完並放進快取） */
function loadIndex($: EngineInterface, file: string, mtime: number): Promise<Index | null> {
  if (mtime < 0) {
    index = null
    return Promise.resolve(null)
  }
  if (index?.mtime === mtime) return Promise.resolve(index.value)
  loading ??= (async () => {
    try {
      const value = parseIndex(await $.fs.read(file))
      index = { mtime, value }
      return value
    } catch {
      return null
    } finally {
      loading = null
    }
  })()
  return loading
}

async function find($: EngineInterface, text: string): Promise<{ session: string; hits: Hit[] } | null> {
  if (await isHeadless($)) return null
  const home = await engramHome($)
  const indexFile = `${home}/local/cache/recall.json`
  const settingsFile = `${home}/local/settings.json`
  const sharedFile = `${home}/vault/settings.json`
  const [indexMtime, settingsMtime, sharedMtime, session, cwd] = await Promise.all([
    mtimeOf($, indexFile),
    mtimeOf($, settingsFile),
    mtimeOf($, sharedFile),
    $.session.id().catch(() => ''),
    $.session.cwd().catch(() => ''),
  ])
  // 沒有要帶的也回傳 session：標記檔要用（不再多問一次 $.session.id()）
  if (!(await recallOn($, [settingsFile, sharedFile], [settingsMtime, sharedMtime]))) return { session, hits: [] }
  const [ix] = await Promise.all([loadIndex($, indexFile, indexMtime), seed($, home, session)])
  if (!ix?.n) return { session, hits: [] }
  return { session, hits: score(ix, text, { pid: projectOf(ix, cwd), exclude: recalled.get(session) ?? new Set<string>() }) }
}

/**
 * 第一次看到一場對話：從今天與昨天的帶出紀錄（這個程序之前寫的、別的程序與指令型後備寫的）補上這場對話帶過的 ref。
 * 重新啟動 Claude Code 後 /resume 同一場對話、或 mod 熱重載之後，模組變數是空的，靠這個不重複帶。讀不到紀錄就當作沒有。
 */
async function seed($: EngineInterface, home: string, session: string): Promise<void> {
  if (!session || seeded.has(session)) return
  const dir = `${home}/local/usage/recall`
  let names: string[] = []
  try {
    names = (await $.fs.list(dir)).filter(f => f.kind === 'file').map(f => f.name)
  } catch {
    names = []
  }
  const now = await $.clock.now()
  const texts = await Promise.all(recentUsageFiles(names, now).map((n: string) => $.fs.read(`${dir}/${n}`).catch(() => '')))
  const seen = recalled.get(session) ?? new Set<string>()
  for (const text of texts) for (const ref of recalledIn(text, session)) seen.add(ref)
  recalled.set(session, seen)
  seeded.add(session)
}

/** 真的附上之後才記成「這場對話帶過」：超時而沒有附上的，下一則訊息還可以帶 */
function remember(session: string, hits: Hit[]) {
  const seen = recalled.get(session) ?? new Set<string>()
  for (const h of hits) seen.add(h.ref)
  recalled.set(session, seen)
}

/**
 * 標記檔 local/cache/session/<session id>.mod：告訴指令型後備「mod 已載入」，這則訊息不要再帶一次。
 * guard.ts 在 session.start 寫；/clear 與對話內 /resume 換了 session id 卻不會再觸發 session.start，所以這裡補寫。
 * 一定要在 next(e) 之前寫完：指令型的 UserPromptSubmit hook 是在 next(e) 裡面（mod 的 hook 之後）才執行。
 * 不受 250 毫秒的限制，但每場對話只有第一則訊息要查（一次 stat，沒有標記檔時再一次寫入），之後用模組變數記住。
 */
async function markSession($: EngineInterface, known: string | undefined): Promise<void> {
  if (await isHeadless($)) return
  const session = known ?? (await $.session.id())
  if (!session) return
  const now = Number(await $.clock.now())
  const last = marked.get(session)
  if (last !== undefined && now - last < MARK_REFRESH_MS) return
  const file = `${await engramHome($)}/local/cache/session/${session}.mod`
  // 第一次看到這場對話：沒有標記檔才寫；之後每天重寫一次，更新修改時間
  if (last !== undefined || (await mtimeOf($, file)) < 0) await $.fs.write(file, 'recall\n')
  marked.set(session, now)
}

/** 最多等 TIMEOUT_MS；超過就當作沒有結果（讀檔照樣在背景完成） */
async function withinTimeout<T>($: EngineInterface, work: Promise<T>): Promise<T | null> {
  const stop = new AbortController()
  const late = $.clock.sleep(TIMEOUT_MS, { signal: stop.signal }).then(
    () => null,
    () => null,
  )
  try {
    return await Promise.race([work, late])
  } finally {
    stop.abort()
  }
}

/** 帶出紀錄：local/usage/recall/<日期>.<程序代號>.jsonl，每個程序每天一個檔；只存時間、對話 id、ref 與分數，不存訊息原文 */
function record($: EngineInterface, session: string, hits: Hit[]): Promise<void> {
  writing = writing
    .then(async () => {
      const at = new Date(await $.clock.now()).toISOString()
      const file = `${await engramHome($)}/local/usage/recall/${usageFileName(at.slice(0, 10), INSTANCE)}`
      const lines = hits.map((h: Hit) => usageLine({ at, session, ref: h.ref, score: h.score })).join('')
      let before = ''
      try {
        before = await $.fs.read(file)
      } catch {
        before = ''
      }
      await $.fs.write(file, `${before}${lines}`)
    })
    .catch(() => {
      // 紀錄寫不了不影響送出
    })
  return writing
}

// 同一個外掛裡，同一個事件不能有兩個沒有 matcher 的 hook；prompt.submit 目前只有這裡用。
// 開場的標記檔由 guard.ts 在 session.start 寫；換了 session id 而沒有標記檔時由 markSession 補寫。
export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || !fromUser(e.origin) || !e.text?.trim()) return next(e)
    let found: { session: string; hits: Hit[] } | null = null
    try {
      found = await withinTimeout($, find($, e.text))
    } catch {
      found = null
    }
    try {
      // 超時（found 是 null）時才另外問 session id
      await markSession($, found?.session)
    } catch {
      // 寫不了標記檔：最壞是指令型後備也帶一次
    }
    const extra = found?.hits.length ? contextText(found.hits) : null
    if (!found || !extra) {
      const r = await next(e)
      // 超時的讀檔還沒完成：等它讀完放進快取（訊息已經送出，不耽誤使用者）
      if (loading) await loading.catch(() => null)
      return r
    }
    remember(found.session, found.hits)
    const r = await next({ ...e, context: [...(e.context ?? []), extra] })
    await record($, found.session, found.hits)
    return r
  }).catch(($, e, next) => next(e))
}
