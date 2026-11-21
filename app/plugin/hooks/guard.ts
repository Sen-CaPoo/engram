// 護欄：Bash／PowerShell 的指令送出前，用 vault/guardrails/rules.json（沒有就用內建的 6 條）比對。
// 把握高的規則直接擋下並附正確寫法（deny），把握低的在結果後附上只有模型讀得到的提醒（context）。
// 任何錯誤都原樣交給 next：護欄壞掉絕不能擋住工具。
// 誤擋的自我修正：同一場對話裡，被擋下的指令原封不動再送一次就放行；重送後指令成功，才證實是誤擋，把那幾條規則在本機暫時降成提醒（14 天後自動恢復）。
// 重送後工具回報錯誤，代表規則擋對了：不降級，之後同一個指令再送仍然會被擋。
// 「失敗不會報錯」的規則（silentFailure，例如輸出悄悄變錯）重送成功不代表是誤擋：不自動降級，只記一筆 falseBlock，由使用者決定。
// 規則檔來的 block 規則要在這台電腦核可過（local/guardrails-approved.json）才真的擋下，否則只當提醒；
// 規則檔來的規則單次比對超過 50 毫秒，就在本機停用那條規則（local/guardrails-overrides.json，reason: slow）並記一筆。
import type { EngineInterface, Register } from 'claude-code'

import {
  createBlockLog, denyText, evaluate, falseBlockUntil, hintTexts, loadRules, normalizeMode, parseApprovals, parseOverrides, stringifyOverrides, usageLine, withOverride,
} from './lens/guard.mjs'
import { normPath } from './lens/model.mjs'
import { langOf } from './lens/strings.mjs'

type Mode = 'block' | 'hint' | 'off'
type Overrides = Record<string, { action: 'hint' | 'off'; at?: string; reason?: string; until?: string }>
type Entries = ReturnType<typeof loadRules>['entries']
type Config = { slowMs: number | undefined; mode: Mode; entries: Entries; overrides: Overrides; approvals: Record<string, { hash: string; at?: string }>; hasExpiry: boolean }
type Hit = { id: string; action: 'block' | 'hint'; declared: 'block' | 'hint'; message: string; messageEn?: string; silentFailure: boolean }
// falseBlock：重送後成功，證實是誤擋；confirmed：重送後工具回報錯誤，證實規則擋對了；slow：規則比對太慢，被停用
type Use = { rule: string; kind: 'block' | 'hint' | 'falseBlock' | 'confirmed' | 'slow' }
// pending：被擋下過、這次原封不動重送而放行的規則（silent：失敗不會報錯的規則）；要等工具跑完看結果才決定降不降級
type Pending = { id: string; silent: boolean }
type Verdict = { deny: string } | { hints: string[]; uses: Use[]; pending: Pending[] } | null

const MOD_NAME = 'guard'

// 模組變數在熱重載後會重來，只放可以重算的東西
let cachedHome: string | null = null
let config: { sig: string; value: Config } | null = null
const blocked = createBlockLog()
// 寫檔排成一串：同一回合平行的工具呼叫，先讀再寫才不會互相覆蓋
let writing: Promise<void> = Promise.resolve()

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

async function mtimeOf($: EngineInterface, file: string): Promise<number> {
  try {
    return (await $.fs.stat(file)).mtimeMs
  } catch {
    return -1
  }
}

async function textOf($: EngineInterface, file: string): Promise<string | null> {
  try {
    return await $.fs.read(file)
  } catch {
    return null
  }
}

/**
 * 給模型的說明用哪個語言（2.0.0）：記憶面板選過的語言 → Claude Code 的 language 設定（判斷方式同 strings.mjs 的 langOf）
 * → 系統語系（LC_ALL、LC_MESSAGES、LANG）→ 英文（和記憶面板一致：沒有任何設定時 langOf 也是英文）。
 * 規則有 messageEn 時英文用它，沒有就用 message。只在有命中時才判斷；判斷不出來不影響擋下與提醒。
 */
async function guardLang($: EngineInterface): Promise<'zh' | 'en'> {
  try {
    const chosen = await $.store.get('lang')
    if (chosen === 'zh' || chosen === 'en') return chosen
  } catch {
    // 沒有 store：往下找
  }
  try {
    const home = normPath((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '')
    const claudeHome = normPath((await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`)
    const settings = JSON.parse(await $.fs.read(`${claudeHome}/settings.json`)) as { language?: unknown }
    if (typeof settings.language === 'string' && settings.language.trim()) return langOf(settings.language) as 'zh' | 'en'
  } catch {
    // 沒有設定檔或沒設 language：看系統語系
  }
  try {
    // $.env.get 只接受字面的名稱（validate 要列出 mod 讀的環境變數）
    const locales = [await $.env.get('LC_ALL'), await $.env.get('LC_MESSAGES'), await $.env.get('LANG')]
    for (const v of locales) {
      if (v && v !== 'C' && v !== 'POSIX') return /^zh/i.test(v) ? 'zh' : 'en'
    }
  } catch {
    // 讀不到環境變數
  }
  return 'en'
}

/** 規則檔、本機覆寫、核可紀錄、設定；四個檔案的修改時間都沒變就用快取 */
async function loadConfig($: EngineInterface): Promise<Config> {
  const home = await engramHome($)
  const files = [`${home}/vault/guardrails/rules.json`, `${home}/local/guardrails-overrides.json`, `${home}/local/guardrails-approved.json`, `${home}/local/settings.json`]
  const sig = (await Promise.all(files.map(f => mtimeOf($, f)))).join('|')
  if (config?.sig === sig) return config.value
  const [rules = null, overrides = null, approved = null, settings = null] = await Promise.all(files.map(f => textOf($, f)))
  let mode: Mode = 'block'
  try {
    mode = normalizeMode(settings === null ? undefined : (JSON.parse(settings) as { guardrails?: unknown }).guardrails)
  } catch {
    // 設定檔壞掉就用預設
  }
  const parsed: Overrides = parseOverrides(overrides)
  // 診斷與測試用：環境變數 ENGRAM_GUARD_SLOW_MS 覆寫「比對太慢」的門檻（預設 50 毫秒；-1 讓每條規則檔來的規則都算太慢）。
  // 通過驗證的樣式本來就慢不到 50 毫秒，要測「停用」這條路只能調低門檻
  const slowMs = Number(await $.env.get('ENGRAM_GUARD_SLOW_MS'))
  const value: Config = {
    slowMs: Number.isFinite(slowMs) ? slowMs : undefined,
    mode,
    entries: loadRules(rules).entries,
    overrides: parsed,
    approvals: parseApprovals(approved),
    hasExpiry: Object.values(parsed).some(o => o.until !== undefined),
  }
  config = { sig, value }
  return value
}

async function sessionId($: EngineInterface): Promise<string> {
  try {
    return await $.session.id()
  } catch {
    return ''
  }
}

/** 命中紀錄：local/usage/guardrails/<日期>.jsonl，一天一個檔；只存規則 id、種類、時間與對話 id，不存指令原文 */
function recordUse($: EngineInterface, session: string, uses: Use[]): Promise<void> {
  if (!uses.length) return Promise.resolve()
  writing = writing
    .then(async () => {
      const at = new Date(await $.clock.now()).toISOString()
      const file = `${await engramHome($)}/local/usage/guardrails/${at.slice(0, 10)}.jsonl`
      const lines = uses.map((u: Use) => usageLine({ at, session, rule: u.rule, kind: u.kind })).join('')
      const before = (await textOf($, file)) ?? ''
      await $.fs.write(file, `${before}${lines}`)
    })
    .catch(() => {
      // 紀錄寫不了不影響工具
    })
  return writing
}

/**
 * 在本機覆寫檔設定規則的覆寫（local/guardrails-overrides.json，本機覆寫優先於同步的規則）：
 * falseBlock：降成提醒，14 天後自動恢復；slow：停用（比對太慢，要使用者 engram guardrails enable 才恢復）。已經被停用的不改。
 */
function overrideRules($: EngineInterface, ids: string[], reason: 'falseBlock' | 'slow'): Promise<void> {
  writing = writing
    .then(async () => {
      const file = `${await engramHome($)}/local/guardrails-overrides.json`
      const at = new Date(await $.clock.now()).toISOString()
      let overrides: Overrides = parseOverrides(await textOf($, file))
      for (const id of ids) {
        if (overrides[id]?.action === 'off') continue
        overrides = withOverride(overrides, id, reason === 'slow' ? { action: 'off', at, reason } : { action: 'hint', at, reason, until: falseBlockUntil(at) })
      }
      await $.fs.write(file, stringifyOverrides(overrides))
      config = null
    })
    .catch(() => {
      // 寫不了就只有這一次放行（或這一次沒停用）
    })
  return writing
}

async function judge($: EngineInterface, e: Readonly<Record<string, unknown>>): Promise<Verdict> {
  const tool = String(e.tool)
  if ((tool !== 'Bash' && tool !== 'PowerShell') || typeof e.command !== 'string' || !e.command) return null
  const command = e.command
  const cfg = await loadConfig($)
  if (cfg.mode === 'off') return null
  const slow: string[] = []
  const opts = {
    mode: cfg.mode,
    overrides: cfg.overrides,
    approvals: cfg.approvals,
    // 有會到期的覆寫才需要現在的時間
    now: cfg.hasExpiry ? await $.clock.now() : undefined,
    onSlow: (id: string) => { slow.push(id) },
    slowMs: cfg.slowMs,
  }
  let hits: Hit[] = evaluate(cfg.entries, tool, command, opts)
  if (slow.length) {
    // 規則檔來的規則比對太久：這一次的結果照用，之後在本機停用它
    await overrideRules($, slow, 'slow')
    await recordUse($, await sessionId($), slow.map((rule: string) => ({ rule, kind: 'slow' as const })))
  }
  const blocking = hits.filter((h: Hit) => h.action === 'block')
  // 這個指令現在不會被擋了（規則被降級、停用或到期前）：之前擋下它的記錄已經過時，丟掉，
  // 不然降級到期、規則恢復擋下時，這個指令會被當成「剛擋下、重送」而放行一次
  if (!blocking.length && blocked.size > 0) blocked.take(await sessionId($), command)
  if (!hits.length) return null
  const lang = await guardLang($)

  let pending: Pending[] = []
  if (blocking.length) {
    const session = await sessionId($)
    // 擋下過的指令原封不動再送一次：這一次放行，但規則要等指令真的成功才降成提醒（見 tool.call 的 hook）。
    // block 擋的多半是「送出去會失敗」的寫法：重送後如果還是失敗，代表規則擋對了，不能降級
    const earlier = new Set<string>(blocked.take(session, command) ?? [])
    pending = blocking.filter((h: Hit) => earlier.has(h.id)).map((h: Hit) => ({ id: h.id, silent: h.silentFailure }))
    if (pending.length) hits = evaluate(cfg.entries, tool, command, { ...opts, demote: new Set(pending.map((p: Pending) => p.id)), onSlow: undefined })
    const still = hits.filter((h: Hit) => h.action === 'block')
    if (still.length) {
      blocked.remember(session, command, still.map((h: Hit) => h.id))
      await recordUse($, session, still.map((h: Hit) => ({ rule: h.id, kind: 'block' as const })))
      return { deny: denyText(hits, { lang }) }
    }
  }
  const uses: Use[] = hits.filter((h: Hit) => h.action === 'hint').map((h: Hit) => ({ rule: h.id, kind: 'hint' as const }))
  return { hints: hintTexts(hits, { lang }), uses, pending }
}

// 同一個外掛裡，同一個事件不能有兩個沒有 matcher 的 hook（Claude Code 2.1.329 實測：validate 與載入都拒絕），
// lens.tsx 已經用掉 session.start 與 tool.call 的無 matcher 位置，所以這裡一律帶 matcher：
// session.start 用「isInteractive 是 true 或 false」（永遠成立），tool.call 只看 Bash 與 PowerShell。
export const register: Register = on => {
  // 標記檔：告訴開場訊息「護欄 mod 已載入」，這場對話就不需要在開場訊息補後備提示
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    try {
      await $.fs.write(`${await engramHome($)}/local/cache/session/${await $.session.id()}.mod`, `${MOD_NAME}\n`)
    } catch {
      // 寫不了標記檔最壞只是開場訊息多一段後備提示
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    let verdict: Verdict = null
    try {
      verdict = await judge($, e)
    } catch {
      verdict = null
    }
    if (verdict && 'deny' in verdict) return { deny: verdict.deny }
    // next(e) 丟出例外（例如使用者中斷）時由底下的 .catch 處理，不會讓工具執行兩次：
    // 型別檔（claude-code.d.ts 的 Caught）寫明 .catch 裡的 next 是 replay-safe，hook 已經呼叫過 next 時，
    // next(e) 回傳上次呼叫的結果、下層不會再跑一次；還沒呼叫過才會執行一次。所以 .catch 一律原樣 next(e)，不需要判斷 next.called。
    const ran = await next(e)
    // next 之後的程式一律不丟例外（結果不是物件也一樣）：萬一仍然失敗，由 .catch 接手
    if (!verdict || !ran || ran.deny !== undefined) return ran
    try {
      // 重送放行的那幾條規則：看工具的結果決定。
      // 2.1.329 實測（PowerShell 工具）：指令失敗時 next(e) 的結果帶 isError: true，成功時沒有 isError 欄位（undefined）。
      // 所以「重送後成功」就是 isError !== true；工具回報錯誤代表規則擋對了（記 confirmed，不降級）
      const isOk = ran.isError !== true
      // 失敗不會報錯的規則（silent）重送成功也不能證明是誤擋：只記 falseBlock，不自動降級
      const auto = verdict.pending.filter((p: Pending) => !p.silent).map((p: Pending) => p.id)
      if (isOk && auto.length) await overrideRules($, auto, 'falseBlock')
      const settled: Use[] = verdict.pending.map((p: Pending) => ({ rule: p.id, kind: isOk ? ('falseBlock' as const) : ('confirmed' as const) }))
      await recordUse($, await sessionId($), [...settled, ...verdict.uses])
    } catch {
      // 只是紀錄
    }
    return verdict.hints.length ? { ...ran, context: [...(Array.isArray(ran.context) ? ran.context : []), ...verdict.hints] } : ran
  }).catch(($, e, next) => next(e))
}
