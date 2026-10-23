// 記憶面板：在 Claude Code 旁邊列出本次對話載入與讀取了哪些記憶（只列事實，不推論引用）。
// 資料來源：$.session.usage 的記憶檔清單（開場載入、token 數、後來自動載入的指示檔）與 tool.call（對話中讀取）。
// prompt.context／prompt.attachment 會被排在前面的外掛略過（實測 cc-plugin-sec-default），也會被子代理的對話觸發，所以不用。
// 所有 hook 都只觀察，原樣交給 next。
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LensEntry, LensFilter, LensLang, LensScope } from '../types'
import {
  classify,
  indexFacts,
  displayPath,
  displayWidth,
  formatTokens,
  isIndexFile,
  isMemoryDir,
  levelOf,
  mergeEntry,
  nextFilter,
  normPath,
  padEnd,
  parentsOf,
  parseCommand,
  searchHits,
  splitFrontmatter,
  treeOrder,
  treePrefixes,
  truncate,
} from './lens/model.mjs'
import { langOf, STRINGS } from './lens/strings.mjs'

type Roots = { home: string; vault: string; claudeHome: string; cwd: string }
type Strings = (typeof STRINGS)['zh']

const PANE = 'engram-memories'
const COMMAND = 'engram-memories'

// 欄位或意義改變時換掉 shape 標籤：$.state 在熱重載與更新外掛後仍保留，換標籤才不會讀到舊版存的值
const loaded = atom({ plugin: 'engram', key: 'loaded' } as const, [], { shape: 'loaded-1' })
const reads = atom({ plugin: 'engram', key: 'reads' } as const, [], { shape: 'reads-1' })
const turn = atom({ plugin: 'engram', key: 'turn' } as const, 0)
const filter = atom({ plugin: 'engram', key: 'filter' } as const, 'all')
const detail = atom({ plugin: 'engram', key: 'detail' } as const, null, { shape: 'detail-1' })
// null：這段對話還沒決定語言（/clear 之後的新對話不會再觸發 session.start），畫面改用 langCache 或重新偵測
const lang = atom({ plugin: 'engram', key: 'lang' } as const, null)

const SCOPE_COLOR: Record<LensScope, string> = {
  core: 'claude',
  global: 'suggestion',
  machine: 'warning',
  project: 'success',
  instructions: 'subtle',
}

const pathKey = (p: string) => normPath(p).toLowerCase()

// 模組變數在熱重載後會重來，只放可以重算的東西
let cachedRoots: Roots | null = null
// 自動開啟的面板落在提示列上方（不是全螢幕）時要收起來；使用者自己開的不動
let autoOpened = false
let langCache: LensLang | null = null
// 主對話真的壓縮過（不含 precompute 這種預先計算）：從第幾回合起重新載入，下次更新時重建開場載入
let pendingReload: number | null = null
let turnActive = false
// 上次看到的 /context 估計總 token：壓縮事件被排在前面的外掛略過時，用驟降判斷壓縮
let lastTotal: number | null = null
// /clear、/resume 時加一，之前排定、還沒寫完的更新就作廢；更新一次只跑一個
let generation = 0
let refreshing: Promise<void> = Promise.resolve()

async function roots($: EngineInterface): Promise<Roots> {
  if (cachedRoots) return cachedRoots
  const home = normPath((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '')
  const engramHome = normPath((await $.env.get('ENGRAM_HOME')) ?? `${home}/.engram`)
  const claudeHome = normPath((await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`)
  const cwd = normPath(await $.session.cwd())
  cachedRoots = { home, vault: `${engramHome}/vault`, claudeHome, cwd }
  return cachedRoots
}

/** 使用者在面板切換過語言就用那個（跨對話保存）；沒切換過跟著 Claude Code 的 language 設定 */
async function detectLang($: EngineInterface): Promise<LensLang> {
  const chosen = await $.store.get('lang')
  if (chosen === 'zh' || chosen === 'en') return chosen
  const r = await roots($)
  try {
    const settings = JSON.parse(await $.fs.read(`${r.claudeHome}/settings.json`)) as { language?: unknown }
    return langOf(settings.language)
  } catch {
    return 'en'
  }
}

async function currentLang($: EngineInterface): Promise<LensLang> {
  const l = (await read($, lang)) ?? langCache ?? (await detectLang($))
  langCache = l
  return l
}

async function strings($: EngineInterface): Promise<Strings> {
  return STRINGS[await currentLang($)]
}

/** 開關面板：/engram-memories 與底部的「憶跡」按鈕共用。回傳要顯示給使用者的訊息（沒有就是成功） */
async function togglePane($: EngineInterface): Promise<string | undefined> {
  const S = await strings($)
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  if (pane?.isPlaced) {
    await $.store.set('autoOpen', false)
    await $.ui.close({ id: PANE })
    return undefined
  }
  autoOpened = false
  await $.store.set('autoOpen', true)
  const opened = await $.ui.open({ id: PANE, title: S.title })
  return opened.isPlaced ? undefined : S.notPlaced(opened.reason)
}

/** 切換介面語言：記住選擇，並更新指令說明與面板標題 */
async function switchLang($: EngineInterface) {
  const l: LensLang = (await currentLang($)) === 'zh' ? 'en' : 'zh'
  langCache = l
  await $.store.set('lang', l)
  await update($, lang, () => l)
  const S = STRINGS[l]
  await $.command.register({ name: COMMAND, description: S.command })
  if ((await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)) await $.ui.open({ id: PANE, title: S.title })
}

type MemoryFile = { path: string; tokens: number }

// 估計總 token 一次掉超過這麼多、而且剩不到六成，就當成壓縮過（壓縮事件可能被其他外掛略過）
const COMPACT_DROP = 20_000

/**
 * 開場載入來自 /context 的記憶檔清單（$.session.usage）：清單還沒建立、或剛壓縮過時重建；
 * 其他時候補上 token 數，並把之後才出現的檔案（子資料夾的 CLAUDE.md、符合條件的規則檔）算成自動載入。
 * gen 是排定時的世代：/clear、/resume 之後就不再寫入，舊對話的清單不會被寫回。
 */
async function refreshLoaded($: EngineInterface, gen: number) {
  if (gen !== generation) return
  const usage = await $.session.usage({ breakdown: 'summary' })
  if (gen !== generation) return
  const total = usage.context.breakdown?.totalTokens
  if (pendingReload === null && total !== undefined && lastTotal !== null && lastTotal - total > COMPACT_DROP && total < lastTotal * 0.6) {
    const t = await read($, turn)
    if (gen !== generation) return
    pendingReload = t
  }
  if (total !== undefined) lastTotal = total
  const files = usage.context.breakdown?.memoryFiles ?? []
  if (!files.length) return
  const current = await read($, loaded)
  if (!current.length || pendingReload !== null) {
    const at = pendingReload
    await rebuildLoaded($, files, at, gen)
    if (gen === generation && pendingReload === at) pendingReload = null
    return
  }
  const tokenOf = new Map(files.map(f => [pathKey(f.path), f.tokens]))
  await update($, loaded, list => list.map(x => ({ ...x, tokens: tokenOf.get(pathKey(x.path)) ?? x.tokens })))

  const known = new Set([...current, ...(await read($, reads))].map(x => pathKey(x.path)))
  const later = files.filter(f => !known.has(pathKey(f.path)))
  if (later.length && gen === generation) {
    const r = await roots($)
    await addReads(
      $,
      later.map(f => {
        const c = classify(f.path, r) ?? { scope: 'instructions' as const, name: displayPath(f.path, r) }
        return { path: f.path, scope: c.scope, name: c.name, owner: c.owner, how: 'nested' as const, tokens: f.tokens }
      }),
    )
  }
}

/** compactTurn：從第幾回合起是壓縮後重新載入；null 是對話開始時載入 */
async function rebuildLoaded($: EngineInterface, files: readonly MemoryFile[], compactTurn: number | null, gen: number) {
  const r = await roots($)
  const texts = new Map<string, string>()
  for (const f of files) texts.set(pathKey(f.path), await $.fs.read(f.path).catch(() => ''))
  const { parents, ranks } = parentsOf(files.map(f => ({ path: f.path, text: texts.get(pathKey(f.path)) ?? '' })), r.home)
  const entries: LensEntry[] = []
  for (const f of files) {
    const c = classify(f.path, r) ?? { scope: 'instructions' as const, name: displayPath(f.path, r) }
    entries.push({
      id: `L:${pathKey(f.path)}`,
      path: f.path,
      scope: c.scope,
      name: c.name,
      owner: await ownerOf($, f.path, c, r),
      how: compactTurn !== null ? 'compact' : 'start',
      turn: compactTurn ?? 0,
      tokens: f.tokens,
      ...(isIndexFile(f.path) ? indexFacts(f.path, texts.get(pathKey(f.path))) : {}),
      parent: parents.get(pathKey(f.path)),
    })
  }
  if (gen === generation) await update($, loaded, () => treeOrder(entries, ranks))
}

/**
 * 排到這次事件之後才更新：/context 的估算要掃過整個對話，不擋住對話開始或回合結束。
 * 一次只跑一個，接連排定的會依序執行，不會重複把同一個檔案記成兩次自動載入。
 */
function refreshSoon($: EngineInterface) {
  const gen = generation // 排定當下的世代：/clear 之前排定、之後才觸發的也作廢
  $.clock.after(1, () => {
    refreshing = refreshing
      .then(() => refreshLoaded($, gen))
      .catch(() => {
        // 拿不到 /context 時保留原本的清單，下一回合再試
      })
  })
}

/**
 * 專案記憶的擁有者（pid）。Claude Code 的記憶資料夾是 junction（指向記憶庫）時用實際路徑判斷，
 * 這樣經由 ~/.claude/projects/<編碼>/memory 或記憶庫讀到同一個專案，都認得是同一個 pid。
 */
async function ownerOf($: EngineInterface, p: string, c: { scope: LensScope; owner?: string }, r: Roots) {
  if (c.scope !== 'project' || !pathKey(p).startsWith(`${pathKey(r.claudeHome)}/projects/`)) return c.owner
  try {
    const real = (await $.fs.stat(p, { resolve: true })).realPath
    const rc = real ? classify(real, r) : null
    return rc?.scope === 'project' ? rc.owner : c.owner
  } catch {
    return c.owner
  }
}

async function addReads($: EngineInterface, found: Omit<LensEntry, 'id' | 'turn'>[]) {
  if (!found.length) return
  const t = await read($, turn)
  await update($, reads, list => found.reduce((acc, f) => mergeEntry(acc, { ...f, id: `R:${pathKey(f.path)}`, turn: t }), list))
}

async function existing($: EngineInterface, paths: string[]): Promise<string[]> {
  const out: string[] = []
  for (const p of paths) if (await $.fs.exists(p).catch(() => false)) out.push(p)
  return out
}

async function entriesFor($: EngineInterface, paths: string[], r: Roots, how: LensEntry['how'], extra: Partial<LensEntry> = {}) {
  const out: Omit<LensEntry, 'id' | 'turn'>[] = []
  for (const p of paths) {
    const c = classify(p, r)
    if (c) out.push({ path: p, scope: c.scope, name: c.name, owner: await ownerOf($, p, c, r), how, ...extra })
  }
  return out
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const l = await detectLang($)
    langCache = l
    await update($, lang, () => l)
    const S = STRINGS[l]
    await $.command.register({ name: COMMAND, description: S.command })
    if (e.isInteractive && (await $.store.get('autoOpen')) !== false) {
      autoOpened = true
      void $.ui.open({ id: PANE, title: S.title })
    }
    refreshSoon($)
    return next(e)
  })

  // /clear 與對話內 /resume 換成另一段對話：清單從頭開始，排定中的更新作廢
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      generation += 1
      pendingReload = null
      lastTotal = null
      turnActive = false
      await update($, loaded, () => [])
      await update($, reads, () => [])
      await update($, turn, () => 0)
      await update($, detail, () => null)
    }
    return next(e)
  })

  // precompute 只是預先算好、沒有套用，不算壓縮。回合進行中壓縮（自動）是這一回合起，閒置時 /compact 是下一回合起
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (done.skip === undefined && !e.agentId && e.trigger !== 'precompute') {
      pendingReload = (await read($, turn)) + (turnActive ? 0 : 1)
      lastTotal = null // 壓縮前開始的估算晚到時，不要再被當成一次壓縮
    }
    return done
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      turnActive = true
      await update($, turn, n => n + 1)
      // /clear 之後的新對話不會再觸發 session.start：語言在這裡補上
      if ((await read($, lang)) === null) {
        const l = langCache ?? (await detectLang($))
        await update($, lang, () => l)
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) {
      turnActive = false
      refreshSoon($)
    }
    return done
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    try {
      const r = await roots($)
      const tool = String(e.tool)
      const input = e as unknown as Record<string, unknown>
      const isAgent = e.agentId !== undefined || undefined
      if (tool === 'Read' && typeof input.file_path === 'string') {
        await addReads($, await entriesFor($, [input.file_path], r, 'read', { isAgent }))
      } else if ((tool === 'Bash' || tool === 'PowerShell') && typeof input.command === 'string') {
        const cmd = parseCommand(input.command, r, tool === 'PowerShell' ? 'powershell' : 'bash')
        // 指令與輸出裡提到的路徑不一定真的存在，確認過才列
        if (cmd?.search != null) await addReads($, await entriesFor($, await existing($, searchHits(ran.text, r)), r, 'search', { isAgent, query: cmd.search }))
        if (cmd?.paths.length) await addReads($, await entriesFor($, await existing($, cmd.paths), r, 'read', { isAgent }))
      } else if (tool === 'Grep' && typeof input.path === 'string' && isMemoryDir(input.path, r)) {
        const query = typeof input.pattern === 'string' ? input.pattern : undefined
        await addReads($, await entriesFor($, await existing($, searchHits(ran.text, r)), r, 'search', { isAgent, query }))
      }
    } catch {
      // 只是觀察，失敗也不影響工具結果
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async $ => {
    const problem = await togglePane($)
    return problem ? { text: problem } : {}
  })

  // 底部右側的模式標籤列（focus 等標籤的位置）加一顆「憶跡」按鈕，不熟指令的人點它就能開關面板。
  // 原本的標籤照 Claude Code 與其他外掛畫的樣子（next）放在前面，按鈕接在後面
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const S = await strings($)
    const n = (await read($, reads)).length
    return (
      <Box flexDirection="row">
        {below}
        {e.props.modes.length ? <Text dimColor> · </Text> : null}
        <Button key="lens-toggle" plain onPress={async () => {
          const problem = await togglePane($)
          if (problem) $.ui.toast(problem)
        }}>
          <Text color="claude">◆ </Text>
          <Text dimColor>{n ? S.chipCount(n) : S.chip}</Text>
        </Button>
      </Box>
    )
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set('autoOpen', false)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const S = await strings($)

    if (autoOpened && e.props.placement === 'inline') {
      autoOpened = false
      void $.ui.close({ id: PANE })
    }

    const cols = Math.max(24, e.props.bodyColumns)
    const scopeLabel = (s: LensScope) => S.scope[s]
    const chipW = Math.max(...(['core', 'global', 'machine', 'project', 'instructions'] as const).map(s => displayWidth(scopeLabel(s))))
    const r = await roots($)

    const loadedList = await read($, loaded)
    const readEntries = await read($, reads)

    /** 這一項怎麼、什麼時候進到對話：開場載入（由誰匯入）、第幾回合讀取或搜尋 */
    const whenOf = (x: LensEntry) => {
      const base =
        x.how === 'start'
          ? [S.whenStart, x.parent ? S.importedBy(displayPath(x.parent, r)) : ''].filter(Boolean).join(' · ')
          : x.how === 'compact'
            ? S.whenCompact(x.turn)
            : x.how === 'nested'
              ? S.whenNested(x.turn)
              : x.how === 'search'
                ? S.whenSearch(x.turn, x.query)
                : S.whenRead(x.turn)
      return [base, x.isAgent ? S.agent : '', (x.times ?? 1) > 1 ? S.timesLong(x.times ?? 1) : ''].filter(Boolean).join(' · ')
    }

    const shown = await read($, detail)
    if (shown) {
      const entry = [...loadedList, ...readEntries].find(x => x.id === shown.id)
      const level = entry ? levelOf(entry) : 'full'
      const isCut = entry?.titles !== undefined && entry.visible !== undefined && entry.visible < entry.titles
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button key="back" hotkey="b" label={S.back} onPress={() => update($, detail, () => null)} />
            <Text color={SCOPE_COLOR[shown.scope]} bold>
              {scopeLabel(shown.scope)}
            </Text>
            <Text bold wrap="truncate-end">
              {shown.name}
            </Text>
          </Box>
          <Text dimColor wrap="truncate-middle">
            {displayPath(shown.path, r)}
          </Text>
          {entry ? <Text dimColor>{whenOf(entry)}</Text> : null}
          <Text>{S.levelNote[level]}</Text>
          {isCut ? <Text color="warning">{S.truncatedNote(entry?.titles ?? 0, entry?.visible ?? 0)}</Text> : null}
          {shown.description ? <Text italic>{shown.description}</Text> : null}
          <Text> </Text>
          {shown.isMissing ? <Text color="warning">{S.missing}</Text> : <Markdown key="body" text={shown.body} />}
        </Box>
      )
    }

    const current = await read($, turn)
    const f = (await read($, filter)) as LensFilter
    const keep = (x: LensEntry) => f === 'all' || x.scope === f
    const readList = [...readEntries].reverse()
    // 開場載入裡出現的專案與電腦，就是「這個專案」「這台電腦」
    const ownersHere = new Set(loadedList.map(x => x.owner).filter(Boolean))

    const openDetail = async (x: LensEntry) => {
      let text: string | null = null
      try {
        text = await $.fs.read(x.path)
      } catch {
        text = null
      }
      const { description, body } = splitFrontmatter(text ?? '')
      await update($, detail, () => ({ id: x.id, path: x.path, scope: x.scope, name: x.name, description, body, isMissing: text === null }))
    }

    /**
     * 一列：● 標記、樹狀連接線、範圍、名稱，靠右是「全文／標題／摘要」加上補充資訊。
     * 補充資訊依重要性排列，太窄時從最後一項開始拿掉；完整度一定留著。
     */
    const row = (x: LensEntry, parts: string[], sep: string, isNew: boolean, prefix: string, isOld = false) => {
      const owner = x.owner && ownersHere.size && !ownersHere.has(x.owner) ? ` · ${x.owner}` : ''
      const level = S.level[levelOf(x)]
      const lead = 2 + displayWidth(prefix) + chipW + 1
      const kept = [...parts]
      const restOf = () => (kept.length ? ` ${kept.join(sep)}` : '')
      while (kept.length && cols - lead - displayWidth(level + restOf()) - 1 < 8) kept.pop()
      const shownRest = restOf()
      const nameW = Math.max(1, cols - lead - displayWidth(level + shownRest) - 1)
      const name = padEnd(truncate(x.name + owner, nameW), nameW + 1)
      return (
        <Button key={x.id} plain onPress={() => openDetail(x)}>
          <Text color="success">{isNew ? '● ' : '  '}</Text>
          {prefix ? <Text dimColor>{prefix}</Text> : ''}
          <Text color={SCOPE_COLOR[x.scope]}>{padEnd(scopeLabel(x.scope), chipW)}</Text>
          {' '}
          {isNew ? <Text bold>{name}</Text> : isOld ? <Text dimColor>{name}</Text> : name}
          <Text dimColor={isOld}>{level}</Text>
          {shownRest ? <Text dimColor>{shownRest}</Text> : ''}
        </Button>
      )
    }

    const header = (left: string, right: string) => (
      <Text bold>
        {padEnd(truncate(left, cols - displayWidth(right) - 1), cols - displayWidth(right))}
        <Text dimColor>{right}</Text>
      </Text>
    )

    const shownLoaded = loadedList.filter(keep)
    const totalTokens = loadedList.reduce((n, x) => n + (x.tokens ?? 0), 0)
    const reloadTurn = loadedList.find(x => x.how === 'compact')?.turn
    const prefixes = treePrefixes(shownLoaded)
    const loadedRows = shownLoaded.flatMap(x => {
      const prefix = prefixes.get(pathKey(x.path)) ?? ''
      // 全文 807；標題 23 則 · 1.2k
      const parts = [x.titles !== undefined ? S.titleCount(x.titles) : '', formatTokens(x.tokens)].filter(Boolean)
      const drawn = [row(x, parts, ' · ', false, prefix)]
      // MEMORY.md 超過上限：在那一列底下另起一行警告，不跟其他資訊搶寬度
      if (x.titles !== undefined && x.visible !== undefined && x.visible < x.titles) {
        const pad = ' '.repeat(2 + displayWidth(prefix) + chipW + 1)
        drawn.push(<Text color="warning">{truncate(`${pad}${S.visible(x.visible, x.titles)}`, cols)}</Text>)
      }
      return drawn
    })

    const shownReads = readList.filter(keep)
    // 壓縮前讀取的內容已整理成摘要：分成壓縮後、壓縮前兩組（各自由新到舊），壓縮前的調暗並在上方加一行說明。
    // 重讀過的檔案回合會更新，所以要先分組，不能只靠清單順序
    const readRow = (x: LensEntry, old: boolean) => {
      const parts = [S.turn(x.turn)]
      if ((x.times ?? 1) > 1) parts.push(S.times(x.times ?? 1))
      if (x.isAgent) parts.push(S.agent)
      return row(x, parts, ' ', !old && x.turn === current && current > 0, '', old)
    }
    const isOld = (x: LensEntry) => reloadTurn !== undefined && x.turn < reloadTurn
    const byTurn = (a: LensEntry, b: LensEntry) => b.turn - a.turn
    const fresh = shownReads.filter(x => !isOld(x)).sort(byTurn)
    const old = shownReads.filter(isOld).sort(byTurn)
    const readRows = [
      ...fresh.map(x => readRow(x, false)),
      ...(old.length && reloadTurn !== undefined ? [<Text dimColor>{S.compactedNote(reloadTurn)}</Text>] : []),
      ...old.map(x => readRow(x, true)),
    ]

    return (
      <Box flexDirection="column">
        {header(reloadTurn !== undefined ? S.reloaded(reloadTurn) : S.loaded, totalTokens ? `${formatTokens(totalTokens)} tok` : '')}
        {loadedList.length ? loadedRows : <Text dimColor>{S.loadedPending}</Text>}
        <Text> </Text>
        {header(S.reads, S.count(readList.length))}
        {shownReads.length ? readRows : <Text dimColor>{S.readsEmpty}</Text>}
        <Text> </Text>
        <Text dimColor>{S.legend}</Text>
        <Box flexDirection="row" gap={2}>
          <Button key="filter" hotkey="f" label={S.filter(S.scope[f])} onPress={() => update($, filter, cur => nextFilter(cur))} />
          <Button key="lang" hotkey="l" label={S.otherLang} onPress={() => switchLang($)} />
          <Text dimColor>{S.hint}</Text>
        </Box>
      </Box>
    )
  })
}
