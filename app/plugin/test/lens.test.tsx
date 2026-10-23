// 記憶面板（hooks/lens.tsx）的行為：claude plugin test plugin（npm run test:lens）。
// 測試裡沒有 Claude Code：engine() 的 hook 代替引擎回答面板對 $ 的呼叫，時鐘用 mock.clock 手動推進。
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = 'C:/Users/T'
const VAULT = `${HOME}/.engram/vault`
const LOGO = `${VAULT}/global/brand-colors.md`
const ENC = `${HOME}/.claude/projects/C--proj/memory` // Claude Code 的記憶資料夾（junction → 記憶庫的 p1）

const FILES: Record<string, string> = {
  [`${HOME}/.claude/settings.json`]: JSON.stringify({ language: 'zh-TW, 正體中文' }),
  [LOGO]: '---\nname: brand-colors\ndescription: 品牌主色\nmetadata:\n  type: user\n---\n\n主色 #0072CE',
  [`${HOME}/.claude/CLAUDE.md`]: '# 準則\n\n@~/.engram/vault/core/CORE.md\n@~/.engram/vault/machines/m1/INDEX.md\n\n寄信給 someone@example.com，`@not/an/import.md`',
  [`${VAULT}/core/CORE.md`]: '# 核心\n\n@../global/INDEX.md\n\n```\n@../not/import.md\n```',
  [`${VAULT}/global/INDEX.md`]: '- [a](a.md) — x\n- [b](b.md) — y\n- [c](c.md) — z',
  [`${VAULT}/machines/m1/INDEX.md`]: '- [d](d.md) — w',
  // 一行標題加 250 則：Claude Code 只載入前 200 行，看得到 199 則
  [`${VAULT}/projects/p1/memory/MEMORY.md`]: ['# 記憶', ...Array.from({ length: 250 }, (_, i) => `- [m${i}](m${i}.md) — 第 ${i} 則`)].join('\n'),
  [`${VAULT}/projects/p1/memory/release.md`]: '---\ndescription: 發版流程\n---\n\n三步',
  [`${ENC}/MEMORY.md`]: '- [release](release.md) — 發版流程',
  [`${ENC}/release.md`]: '---\ndescription: 發版流程\n---\n\n三步',
}
const REAL: Record<string, string> = {
  [`${ENC}/MEMORY.md`]: `${VAULT}/projects/p1/memory/MEMORY.md`,
  [`${ENC}/release.md`]: `${VAULT}/projects/p1/memory/release.md`,
}

const PANE = {
  plugin: 'engram',
  component: 'Pane',
  requestId: 'engram-memories',
  props: {
    title: '憶跡',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

type MemoryFile = { path: string; type: string; tokens: number }
type Pane = { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }
type Host = { store: Map<string, unknown>; panes: Pane[]; settle: () => Promise<void> }

const win = (p: string) => p.replace(/\//g, '\\')
const norm = (p: unknown) => String(p).replace(/\\/g, '/')
const BASE: MemoryFile[] = [
  { path: win(`${HOME}/.claude/CLAUDE.md`), type: 'User', tokens: 600 },
  { path: win(`${VAULT}/core/CORE.md`), type: 'User', tokens: 1200 },
  { path: win(`${VAULT}/global/INDEX.md`), type: 'User', tokens: 900 },
]
const done = (turnId: string) => ({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer' as const })

/** 代替引擎回答 $ 的呼叫；回傳的 host 記下 store 與開著的面板，settle() 推進時鐘讓排定的更新跑完 */
function engine(on: On, opts: { files?: () => MemoryFile[]; total?: () => number; toolText?: string } = {}): Host {
  const clock = mock.clock(on)
  const host: Host = { store: new Map(), panes: [], settle: () => clock.advance(5) }
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? HOME : undefined }))
  on('session.cwd', () => ({ value: 'C:/proj' }))
  on('fs.read', (_, e) => {
    const text = FILES[norm(e.path)]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.exists', (_, e) => ({ value: FILES[norm(e.path)] !== undefined }))
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath: REAL[norm(e.path)] ?? norm(e.path) } }) as never)
  on('store.get', (_, e) => ({ value: host.store.get(e.key) }))
  on('store.set', (_, e) => {
    host.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'engram-memories' } }))
  on('ui.open', (_, e) => {
    if (!host.panes.some(p => p.id === e.id)) host.panes.push({ id: e.id, title: e.title ?? '', isShown: true, isFocused: false, isPlaced: true })
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    host.panes = host.panes.filter(p => p.id !== e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: host.panes }))
  // 底部模式標籤列：代替 Claude Code 自己畫的標籤
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{e.props.modes.join(' & ')}</Text>
  })
  on('session.usage', () => ({
    value: { startedAt: 0, rateLimits: [], context: { breakdown: { memoryFiles: (opts.files ?? (() => BASE))(), totalTokens: opts.total?.() } } },
  }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.compact', (_, e) => ({ messages: e.messages }))
  on('tool.call', () => ({ result: {}, text: opts.toolText ?? '' }) as never)
  return host
}

async function start($: Engine, host: Host) {
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  await host.settle()
  await $.turn.start({ text: 'hi', turnId: 't1' })
}

test('開場載入與對話中讀取都列在面板裡，每種介面都一樣', async ($, on) => {
  const host = engine(on)
  await start($, host)
  await $.tool.call({ tool: 'Read', file_path: LOGO })
  await $.tool.call({ tool: 'Read', file_path: 'C:/proj/README.md' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /開場載入/ }))?.text).toContain('2.7k tok')
    expect((await ui.find({ key: `L:${VAULT.toLowerCase()}/global/index.md` }))?.text).toContain('標題 3 則')
    const read = await ui.find({ key: `R:${LOGO.toLowerCase()}` })
    expect(read?.text).toContain('brand-colors')
    expect(read?.text).toContain('全文 #1')
    // 不是記憶的檔案不會出現
    expect(await ui.find({ type: 'Text', text: /README/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('點一列看內容，返回後回到清單', async ($, on) => {
  const host = engine(on)
  await start($, host)
  await $.tool.call({ tool: 'Read', file_path: LOGO })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `R:${LOGO.toLowerCase()}` })
  expect((await ui.find({ type: 'Text', text: /品牌主色/ }))?.text).toBe('品牌主色')
  expect((await ui.find({ type: 'Text', text: /第 1 回合讀取/ }))?.text).toBe('第 1 回合讀取')
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toContain('#0072CE')
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  await ui.unmount()
})

test('engram search 的結果算搜尋命中，篩選切到別的範圍就不顯示', async ($, on) => {
  const host = engine(on, { toolText: `找到 1 筆：\n• brand-colors — 品牌主色\n  ${win(LOGO)}\n` })
  await start($, host)
  await $.tool.call({ tool: 'Bash', command: 'engram search 品牌 --limit 10' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: `R:${LOGO.toLowerCase()}` }))?.text).toContain('摘要 #1')
  await ui.press({ key: 'filter' }) // 全部 → 核心
  expect(await ui.find({ key: `R:${LOGO.toLowerCase()}` })).toBeUndefined()
  await ui.unmount()
})

test('讀過全文之後又出現在搜尋結果，仍標全文與讀取的那一回合', async ($, on) => {
  const host = engine(on, { toolText: `  ${LOGO}\n` })
  await start($, host)
  await $.tool.call({ tool: 'Read', file_path: LOGO })
  await $.turn.start({ text: 'again', turnId: 't2' })
  await $.tool.call({ tool: 'Bash', command: 'engram search 品牌' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: `R:${LOGO.toLowerCase()}` }))?.text).toMatch(/全文 #1 ×2$/)
  await ui.unmount()
})

test('匯入關係畫成樹狀連接線，每列標出全文或標題，點開寫出怎麼進到對話', async ($, on) => {
  // 跟實機一樣：CLAUDE.md 匯入 CORE.md 與單機 INDEX.md，CORE.md 再匯入全域 INDEX.md；MEMORY.md 自己一棵
  const host = engine(on, {
    files: () => [
      { path: `${VAULT}/global/INDEX.md`, type: 'User', tokens: 1200 },
      { path: `${VAULT}/machines/m1/INDEX.md`, type: 'User', tokens: 617 },
      { path: `${HOME}/.claude/CLAUDE.md`, type: 'User', tokens: 807 },
      { path: `${VAULT}/core/CORE.md`, type: 'User', tokens: 719 },
      { path: `${VAULT}/projects/p1/memory/MEMORY.md`, type: 'AutoMem', tokens: 3000 },
    ],
  })
  await start($, host)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('L:'))
  // 去掉名稱後面靠右的資訊，只比對左半邊
  expect(rows.map(b => b.text.trimEnd().replace(/(\S) {2,}\S.*$/, '$1'))).toEqual([
    '  指示 ~/.claude/CLAUDE.md',
    '  ├ 核心 CORE.md',
    '  │ └ 全域 INDEX.md',
    '  └ 單機 INDEX.md',
    '  專案 MEMORY.md',
  ])
  expect(rows[0]?.text).toMatch(/全文 807$/)
  expect(rows[2]?.text).toMatch(/標題 3 則 · 1\.2k$/)
  // MEMORY.md 超過上限：警告另起一行，48 欄也不會被擠掉
  expect(rows[4]?.text).toMatch(/標題 250 則 · 3k$/)
  expect((await ui.find({ type: 'Text', text: /⚠/ }))?.text.trim()).toBe('⚠ 只看得到前 199 則（共 250 則）')
  expect((await ui.find({ type: 'Text', text: /全文＝/ }))?.text).toBe('全文＝整份內容　標題＝只有標題與一句話　摘要＝搜尋片段')

  await ui.press({ key: `L:${VAULT.toLowerCase()}/global/index.md` })
  expect(await ui.find({ type: 'Text', text: /由 ~\/\.engram\/vault\/core\/CORE\.md 匯入/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^標題：/ }))?.text).toContain('完整內容要等 Claude 讀取那一則')
  await ui.press({ key: 'back' })
  await ui.press({ key: `L:${VAULT.toLowerCase()}/projects/p1/memory/memory.md` })
  expect((await ui.find({ type: 'Text', text: /只看得到前 199 則/ }))?.text).toContain('列了 250 則')
  await ui.unmount()
})

test('後來才出現在 context 的檔案算自動載入；壓縮後重建，precompute 不算', async ($, on) => {
  let files = BASE
  const host = engine(on, { files: () => files })
  await start($, host)

  files = [...BASE, { path: win('C:/proj/sub/CLAUDE.md'), type: 'Project', tokens: 50 }]
  await $.turn.complete(done('t1'))
  await host.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'R:c:/proj/sub/claude.md' }))?.text).toContain('全文 #1')

  // precompute 只是預先計算，沒有套用：標題不變
  await $.turn.start({ text: 'more', turnId: 't2' })
  await $.session.compact({ trigger: 'precompute', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  await $.turn.complete(done('t2'))
  await host.settle()
  expect(await ui.find({ type: 'Text', text: /重新載入/ })).toBeUndefined()

  await $.turn.start({ text: 'more', turnId: 't3' })
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  await $.turn.complete(done('t3'))
  await host.settle()
  expect((await ui.find({ type: 'Text', text: /重新載入/ }))?.text).toContain('壓縮後重新載入（第 3 回合）')
  await ui.unmount()
})

test('/clear 之後清單從頭開始', async ($, on) => {
  const host = engine(on)
  await start($, host)
  await $.tool.call({ tool: 'Read', file_path: LOGO })
  await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /還沒讀取任何記憶/ }))?.text).toBe('這次對話還沒讀取任何記憶')
  expect(await ui.find({ type: 'Text', text: /送出第一個訊息後/ })).toBeDefined()
  await ui.unmount()
})

test('對話內 /resume 也會清空清單', async ($, on) => {
  const host = engine(on)
  await start($, host)
  await $.tool.call({ tool: 'Read', file_path: LOGO })
  await $.session.end({ reason: 'resume', sessionId: 's', resume: {} } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /還沒讀取任何記憶/ }))?.text).toBe('這次對話還沒讀取任何記憶')
  await ui.unmount()
})

test('經由 Claude Code 記憶資料夾（junction）讀到的本專案記憶，不會被標成其他專案', async ($, on) => {
  const host = engine(on, { files: () => [...BASE, { path: win(`${ENC}/MEMORY.md`), type: 'AutoMem', tokens: 40 }] })
  await start($, host)
  await $.tool.call({ tool: 'Read', file_path: win(`${ENC}/release.md`) })
  await $.tool.call({ tool: 'Read', file_path: `${VAULT}/projects/p1/memory/release.md` })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('R:'))
  expect(rows.length).toBe(2)
  for (const r of rows) expect(r.text).not.toContain('·')
  await ui.unmount()
})

test('回歸：寫檔、here-string、sed -i 不算讀取；/c/ 路徑、sudo、cd 之後的相對路徑算', async ($, on) => {
  const host = engine(on)
  await start($, host)
  // 2026-10-23 實機發現：cat >> 檔案 <<'EOF' 的內容含 'R:c:/proj/sub/claude.md'，被當成讀取，點開顯示讀不到
  await $.tool.call({ tool: 'Bash', command: "cat >> tests/x.test.tsx <<'EOF'\nfiles = [{ path: 'C:/proj/sub/CLAUDE.md' }]\nkey: 'R:c:/proj/sub/claude.md'\nEOF" })
  await $.tool.call({ tool: 'Bash', command: 'cat ~/.engram/vault/global/gone.md' })
  await $.tool.call({ tool: 'Bash', command: "sed -i 's/a/b/' ~/.engram/vault/core/CORE.md" })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "engram search 品牌"' })
  await $.tool.call({ tool: 'Bash', command: 'cat /c/Users/T/.engram/vault/global/brand-colors.md > /tmp/copy.md' })
  await $.tool.call({ tool: 'Bash', command: 'cd ~/.engram/vault && sudo head global/INDEX.md' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const reads = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('R:'))
  expect(reads.map(b => b.key).sort()).toEqual([`R:${LOGO.toLowerCase()}`, `R:${VAULT.toLowerCase()}/global/index.md`])
  await ui.unmount()
})

test('面板在對話中途才載入時，用 /context 的清單補上開場載入', async ($, on) => {
  const host = engine(on, { files: () => [{ path: win(`${VAULT}/core/CORE.md`), type: 'User', tokens: 1234 }] })
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // 更新排在事件之後，不擋住對話開始
  expect(await ui.find({ type: 'Text', text: /送出第一個訊息後/ })).toBeDefined()
  await host.settle()
  const core = await ui.find({ key: `L:${VAULT.toLowerCase()}/core/core.md` })
  expect(core?.text).toContain('CORE.md')
  expect(core?.text).toContain('1.2k')
  await ui.unmount()
})

test('底部的「憶跡」按鈕接在原本的模式標籤後面，可以開關面板', async ($, on) => {
  const host = engine(on)
  await start($, host) // 自動開啟面板
  await $.tool.call({ tool: 'Read', file_path: LOGO })
  const isOpen = () => host.panes.some(p => p.id === 'engram-memories')
  expect(isOpen()).toBe(true)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'engram', surface, component: 'SessionMode', props: { modes: ['focus'] } })
    expect((await ui.find({ key: 'lens-toggle' }))?.text).toContain('憶跡 · 讀取 1')
    // 原本的標籤由 Claude Code（這裡是測試的 hook）畫
    expect((await ui.find({ type: 'Text', text: /^focus$/ }))?.text).toBe('focus')
    await ui.press({ key: 'lens-toggle' })
    expect(isOpen()).toBe(false)
    expect(host.store.get('autoOpen')).toBe(false)
    await ui.press({ key: 'lens-toggle' })
    expect(isOpen()).toBe(true)
    expect(host.store.get('autoOpen')).toBe(true)
    await ui.unmount()
  }
})

test('面板可以切換中英文，選擇會記住，也優先於 Claude Code 的 language 設定', async ($, on) => {
  const host = engine(on)
  await start($, host)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /開場載入/ })).toBeDefined()
  await ui.press({ key: 'lang' })
  expect(await ui.find({ type: 'Text', text: /Loaded at start/ })).toBeDefined()
  expect((await ui.find({ key: 'lang' }))?.text).toContain('中文')
  expect(host.store.get('lang')).toBe('en')
  await ui.unmount()

  // 下一次對話：settings.json 還是中文，但記住的是英文
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  await host.settle()
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await again.find({ type: 'Text', text: /Loaded at start/ })).toBeDefined()
  await again.unmount()
})

test('回歸（2026-10-24 第二輪審查）：這段對話還沒決定語言時（/clear 之後），畫面照設定顯示中文', async ($, on) => {
  engine(on)
  // 沒有 session.start：lang 還是 null，就像 /clear 之後的新對話
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /送出第一個訊息後/ })).toBeDefined()
  await ui.unmount()
  const chip = await $.ui.mount({ plugin: 'engram', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect((await chip.find({ key: 'lens-toggle' }))?.text).toContain('◆ 憶跡')
  await chip.unmount()
})

test('壓縮事件被略過時，估計 token 驟降也當成壓縮；壓縮前讀取的記憶上方加說明並調暗', async ($, on) => {
  let total = 120_000
  const host = engine(on, { total: () => total })
  await start($, host)
  await $.tool.call({ tool: 'Read', file_path: LOGO })
  await $.turn.complete(done('t1'))
  await host.settle()

  await $.turn.start({ text: 'more', turnId: 't2' })
  total = 30_000 // 沒有 session.compact 事件，但 token 從 12 萬掉到 3 萬
  await $.turn.complete(done('t2'))
  await host.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /重新載入/ }))?.text).toContain('壓縮後重新載入（第 2 回合）')
  expect((await ui.find({ type: 'Text', text: /壓縮前讀取/ }))?.text).toBe('── 以下在第 2 回合壓縮前讀取，內容已整理成摘要 ──')
  await ui.unmount()
})

test('閒置時 /compact 從下一回合起算', async ($, on) => {
  const host = engine(on)
  await start($, host)
  await $.turn.complete(done('t1'))
  await host.settle()
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  await $.turn.start({ text: 'next', turnId: 't2' })
  await $.turn.complete(done('t2'))
  await host.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /重新載入/ }))?.text).toContain('壓縮後重新載入（第 2 回合）')
  await ui.unmount()
})

test('回歸（2026-10-24 第二輪審查）：排定中的更新遇到 /clear 不會寫回舊清單；接連的更新不會把同一個檔案記兩次', async ($, on) => {
  let files = BASE
  const host = engine(on, { files: () => files })
  await start($, host)
  files = [...BASE, { path: win('C:/proj/sub/CLAUDE.md'), type: 'Project', tokens: 50 }]
  await $.turn.complete(done('t1'))
  await $.turn.complete(done('t1'))
  await host.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'R:c:/proj/sub/claude.md' }))?.text).toMatch(/全文 #1$/)
  await ui.unmount()

  await $.turn.complete(done('t1')) // 排定一次更新
  await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never)
  await host.settle()
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /送出第一個訊息後/ })).toBeDefined()
  expect(await after.find({ key: 'R:c:/proj/sub/claude.md' })).toBeUndefined()
  await after.unmount()
})

test('回歸（2026-10-24 第三輪審查）：壓縮後重讀的記憶歸到壓縮後那一組，說明只出現一次', async ($, on) => {
  const B = `${VAULT}/projects/p1/memory/release.md`
  const host = engine(on)
  await start($, host)
  await $.tool.call({ tool: 'Read', file_path: LOGO })
  await $.turn.complete(done('t1'))
  await $.turn.start({ text: 'b', turnId: 't2' })
  await $.tool.call({ tool: 'Read', file_path: B })
  await $.turn.complete(done('t2'))
  await $.turn.start({ text: 'c', turnId: 't3' })
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  await $.turn.complete(done('t3'))
  await host.settle()
  await $.turn.start({ text: 'd', turnId: 't4' })
  await $.tool.call({ tool: 'Read', file_path: B })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await ui.findAll({})
  const order = all.filter(x => x.key?.startsWith('R:') || /壓縮前讀取/.test(x.text) && x.type === 'Text').map(x => (x.key ? x.key.split('/').pop() : 'divider'))
  expect(order).toEqual(['release.md', 'divider', 'brand-colors.md'])
  await ui.unmount()
})
