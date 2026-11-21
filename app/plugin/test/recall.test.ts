// 情境召回（hooks/recall.ts）的行為：claude plugin test plugin（npm run test:lens）。
// 計分本身的案例在 test/plugin/recall.test.mjs（純函式）；這裡測 mod 的事件流程：附加 context、哪些訊息不處理、設定、不重複、
// 讀檔失敗與超時時原樣送出、帶出紀錄。測試裡沒有 Claude Code：engine() 的 hook 代替引擎回答 $ 的呼叫，檔案放在記憶體裡。
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

import { buildIndex, tokenize } from '../hooks/lens/recall.mjs'

const HOME = 'C:/Users/T'
const ENGRAM = `${HOME}/.engram`
const INDEX = `${ENGRAM}/local/cache/recall.json`
const SETTINGS = `${ENGRAM}/local/settings.json`
const SHARED = `${ENGRAM}/vault/settings.json`
const USAGE_DIR = `${ENGRAM}/local/usage/recall`
/** 這個程序寫的帶出紀錄：<日期>.<程序代號>.jsonl（指令型後備寫的是 <日期>.jsonl） */
const OWN_USAGE = /^2026-11-21\.[A-Za-z0-9_-]+\.jsonl$/
const MARKER = `${ENGRAM}/local/cache/session/s1.mod`
const NOW = Date.parse('2026-11-21T01:00:00.000Z')

type Doc = { ref: string; path: string; name: string; desc: string; type?: string; pid?: string | null; loaded?: string | null; body: string }
const g = (file: string, name: string, desc: string, body: string, loaded: string | null = null): Doc => ({
  ref: `global/${file}.md`, path: `~/.engram/vault/global/${file}.md`, name, desc, body, loaded,
})
const DOCS: Doc[] = [
  // 全部是虛構的題材（烤箱溫度計、虛構的烘焙坊專案）
  g('oven-thermometer', 'oven-thermometer', '烤箱溫度計每季用沸水校正一次，誤差超過 3 度就換', '把探針放進沸水，讀數應該接近 100 度。'),
  g('listed-rule', 'listed-rule', '回覆先列步驟；烤箱溫度計的校正也一樣', '烤箱 溫度計 校正 沸水', '*'),
  { ref: 'projects/p-bakery/memory/cake-deposit.md', path: '~/.engram/vault/projects/p-bakery/memory/cake-deposit.md', name: 'cake-deposit', desc: '客製蛋糕先收三成訂金，取貨前兩天內不能退', pid: 'p-bakery', loaded: 'p-bakery', body: '訂金在下單時付清。' },
  ...Array.from({ length: 12 }, (_, i) => g(`filler-${i}`, `filler-${i}`, `不相關的記憶 ${i}`, `內容 ${i}`)),
]
const indexText = (docs: Doc[] = DOCS) => buildIndex(docs, { mid: 'm-test', roots: [{ path: 'C:/work/bakery', pid: 'p-bakery' }] }).text as string
const ASK = '烤箱溫度計好像不準，多久要用沸水校正一次？'

type Host = {
  files: Map<string, { text: string; mtime: number }>
  reads: string[]
  writes: string[]
  /** 送到最底下（引擎）的訊息：附加的 context 在這裡看得到 */
  submitted: { text: string; context?: readonly string[]; marker?: string }[]
  clock: MockClock
  text: (path: string) => string | undefined
  /** mod 自己寫的帶出紀錄檔（<日期>.<程序代號>.jsonl） */
  usage: () => { file: string | undefined; text: string }
}
type Options = { files?: Record<string, string>; env?: Record<string, string>; readFails?: boolean; writeFails?: boolean; slowReadMs?: number; cwd?: string; noIndex?: boolean }

const norm = (p: unknown) => String(p).replace(/\\/g, '/')

/** 代替引擎回答 $ 的呼叫；檔案在記憶體裡，每次寫入都讓修改時間往前走（mod 靠修改時間決定要不要重讀） */
function engine(on: On, opts: Options = {}): Host {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on) // 同一個外掛的記憶面板（lens.tsx）會讀 $.store
  mock.env(on, { USERPROFILE: HOME, ...(opts.env ?? {}) })
  let tick = 1
  const initial: Record<string, string> = opts.noIndex ? {} : { [INDEX]: indexText() }
  const host: Host = {
    files: new Map(Object.entries({ ...initial, ...(opts.files ?? {}) }).map(([p, text]) => [p, { text, mtime: tick++ }])),
    reads: [],
    writes: [],
    submitted: [],
    clock,
    text: p => host.files.get(p)?.text,
    usage: () => {
      const file = [...host.files.keys()].find(k => k.startsWith(`${USAGE_DIR}/`) && OWN_USAGE.test(k.slice(USAGE_DIR.length + 1)))
      return { file, text: file ? (host.files.get(file)?.text ?? '') : '' }
    },
  }
  on('fs.read', async (_, e) => {
    host.reads.push(norm(e.path))
    if (opts.readFails && norm(e.path) === INDEX) throw new Error('EBUSY')
    if (opts.slowReadMs && norm(e.path) === INDEX) await clock.sleep(opts.slowReadMs)
    const f = host.files.get(norm(e.path))
    if (!f) throw new Error(`ENOENT ${e.path}`)
    return { value: f.text }
  })
  on('fs.stat', (_, e) => {
    const f = host.files.get(norm(e.path))
    if (!f) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtime, isLink: false } } as never
  })
  on('fs.write', (_, e) => {
    if (opts.writeFails) throw new Error('disk full')
    host.writes.push(norm(e.path))
    host.files.set(norm(e.path), { text: e.text, mtime: tick++ })
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const dir = `${norm(e.path).replace(/\/+$/, '')}/`
    const names = [...host.files.keys()].filter(k => k.startsWith(dir) && !k.slice(dir.length).includes('/')).map(k => k.slice(dir.length))
    if (!names.length) throw new Error(`ENOENT ${e.path}`)
    return { value: names.map(name => ({ name, kind: 'file', size: host.files.get(dir + name)?.text.length ?? 0, mtimeMs: host.files.get(dir + name)?.mtime ?? 0 })) } as never
  })
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: opts.cwd ?? 'C:/work/other' }))
  on('prompt.submit', (_, e) => {
    // 指令型的 UserPromptSubmit hook 在這一層（mod 的 hook 之後）才執行：記下那時候有沒有標記檔
    host.submitted.push({ text: e.text, context: e.context, marker: host.text(MARKER) })
    return { text: e.text, context: e.context }
  })
  return host
}

const send = ($: Engine, text: string, extra: { origin?: PromptOrigin; command?: { name: string; args: string }; isMeta?: true } = {}) =>
  $.prompt.submit({ text, wait: false, origin: extra.origin ?? { kind: 'composer' }, ...(extra.command ? { command: extra.command } : {}), ...(extra.isMeta ? { isMeta: true } : {}) })
const last = (host: Host) => host.submitted[host.submitted.length - 1]

test('斷詞在 mod 的環境裡和 Node 一樣（test/plugin/recall.test.mjs 用同一個字串）', () => {
  expect(tokenize('QuillMate 閘道的 cooldown 設定')).toEqual(['quill', 'mate', 'quillmate', '閘道', '道的', 'cooldown', '設定'])
})

test('有索引時，相關的記憶附在 context：每筆一行（名稱、說明、路徑），訊息原文不變', async ($, on) => {
  const host = engine(on)
  await send($, ASK)
  const got = last(host)
  expect(got.text).toBe(ASK)
  expect(got.context).toHaveLength(1)
  expect(got.context?.[0]).toContain('[Engram 情境召回]')
  expect(got.context?.[0]).toContain('- [oven-thermometer](~/.engram/vault/global/oven-thermometer.md) — 烤箱溫度計每季')
  expect(got.context?.[0]).not.toContain('listed-rule') // 已列在全域索引，每場對話都已載入
})

test('帶出紀錄：每個程序各寫自己的檔（<日期>.<程序代號>.jsonl）、一行一筆（時間、對話 id、ref、分數），沒有訊息原文', async ($, on) => {
  const host = engine(on)
  await send($, ASK)
  const own = host.usage()
  expect(own.file).toBeDefined()
  const rows = own.text.trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.at).toBe('2026-11-21T01:00:00.000Z')
  expect(rows[0]?.session).toBe('s1')
  expect(rows[0]?.ref).toBe('global/oven-thermometer.md')
  expect(typeof rows[0]?.score).toBe('number')
  expect(own.text).not.toContain('不準')
})

test('同一場對話帶過的不重複；換了索引（修改時間變了）會重讀', async ($, on) => {
  const host = engine(on)
  await send($, ASK)
  expect(last(host).context).toHaveLength(1)
  await send($, ASK)
  expect(last(host).context).toBeUndefined()
  expect(host.reads.filter(p => p === INDEX)).toHaveLength(1) // 第二次用快取

  host.files.set(INDEX, { text: indexText([...DOCS, g('sourdough-feeding', 'sourdough-feeding', '酸種每 12 小時餵一次，麵粉與水一比一', '冷藏時可以改成一週餵一次。')]), mtime: 999 })
  await send($, '酸種多久要餵一次？麵粉和水的比例是多少')
  expect(last(host).context?.[0]).toContain('sourdough-feeding')
  expect(host.reads.filter(p => p === INDEX)).toHaveLength(2)
})

test('claude -p 與 SDK（sdk）送出的算使用者自己送出的', async ($, on) => {
  const host = engine(on)
  await send($, ASK, { origin: { kind: 'sdk' } })
  expect(last(host).context).toHaveLength(1)
})

test('Remote Control（bridge）送出的算使用者自己送出的', async ($, on) => {
  const host = engine(on)
  await send($, ASK, { origin: { kind: 'bridge' } })
  expect(last(host).context?.[0]).toContain('oven-thermometer')
})

test('不處理：斜線指令、其他外掛或排程送出的、使用者看不到的訊息', async ($, on) => {
  const host = engine(on)
  await send($, ASK, { command: { name: 'review', args: ASK } })
  expect(last(host).context).toBeUndefined()
  await send($, ASK, { origin: { kind: 'scheduled-trigger' } })
  expect(last(host).context).toBeUndefined()
  await send($, ASK, { origin: { kind: 'task-notification' } })
  expect(last(host).context).toBeUndefined()
  await send($, ASK, { isMeta: true })
  expect(last(host).context).toBeUndefined()
  expect(host.reads).toEqual([])
})

test('設定 recall 是 off 時不帶；改回 on 就恢復', async ($, on) => {
  const host = engine(on, { files: { [SETTINGS]: JSON.stringify({ recall: 'off' }) } })
  await send($, ASK)
  expect(last(host).context).toBeUndefined()
  host.files.set(SETTINGS, { text: JSON.stringify({ recall: 'on' }), mtime: 999 })
  await send($, ASK)
  expect(last(host).context).toHaveLength(1)
})

test('所有電腦共用的索引分層（vault/settings.json）是 on 時，這台的 recall: off 也會被強制開啟', async ($, on) => {
  const host = engine(on, { files: { [SETTINGS]: JSON.stringify({ recall: 'off' }), [SHARED]: JSON.stringify({ v: 1, indexLayers: 'on' }) } })
  await send($, ASK)
  expect(last(host).context).toHaveLength(1)
  host.files.set(SHARED, { text: JSON.stringify({ v: 1, indexLayers: 'observe' }), mtime: 999 })
  await send($, '客製蛋糕的訂金可以退嗎？') // 分層關掉之後，這台的 recall: off 生效（沒關的話這則會帶出 cake-deposit）
  expect(last(host).context).toBeUndefined()
})

test('背景的 claude -p（ENGRAM_HEADLESS=1，例如自動駕駛）不帶、不記紀錄', async ($, on) => {
  const host = engine(on, { env: { ENGRAM_HEADLESS: '1' } })
  await send($, ASK, { origin: { kind: 'sdk' } })
  expect(last(host).context).toBeUndefined()
  expect(host.writes).toEqual([])
})

test('目前專案的 MEMORY.md 已列的不帶（cwd 在專案的子資料夾也算）', async ($, on) => {
  const host = engine(on, { cwd: 'C:/work/bakery/src' })
  await send($, '客製蛋糕的訂金可以退嗎？')
  expect(last(host).context).toBeUndefined()
})

test('在別的專案的對話裡，另一個專案的記憶不會被帶出來', async ($, on) => {
  const host = engine(on, { cwd: 'C:/work/other' })
  await send($, '客製蛋糕的訂金可以退嗎？')
  expect(last(host).context).toBeUndefined()
})

test('讀不到索引時原樣送出（不擋住訊息）', async ($, on) => {
  const host = engine(on, { readFails: true })
  await send($, ASK)
  expect(last(host).text).toBe(ASK)
  expect(last(host).context).toBeUndefined()
})

test('沒有索引檔時原樣送出', async ($, on) => {
  const host = engine(on, { noIndex: true })
  await send($, ASK)
  expect(last(host).context).toBeUndefined()
  expect(host.writes).toEqual([MARKER]) // 只有標記檔，沒有帶出紀錄
})

test('超過 250 毫秒就原樣送出；那次讀檔在背景讀完，下一則訊息就帶得出來', async ($, on) => {
  const host = engine(on, { slowReadMs: 400 })
  const first = send($, ASK)
  await host.clock.advance(260)
  await host.clock.advance(200)
  await first
  expect(last(host).context).toBeUndefined()
  expect(host.writes).toEqual([MARKER]) // 沒有附上就不記成帶過（只有標記檔）
  await send($, ASK)
  expect(last(host).context).toHaveLength(1)
  expect(host.reads.filter(p => p === INDEX)).toHaveLength(1) // 用的是背景讀好的快取
})

test('寫不了紀錄時照樣附上', async ($, on) => {
  const host = engine(on, { writeFails: true })
  await send($, ASK)
  expect(last(host).context).toHaveLength(1)
})

test('標記檔：這場對話還沒有（/clear 之後換了 session id）就在交給下一層之前補寫，讓指令型後備不再帶一次', async ($, on) => {
  const host = engine(on)
  await send($, '好，繼續')
  expect(host.text(MARKER)).toBe('recall\n')
  expect(last(host).marker).toBe('recall\n')
  await send($, '好，繼續')
  expect(host.writes.filter(p => p === MARKER)).toHaveLength(1)
})

test('標記檔已經存在（guard.ts 開場寫的）時不覆寫；不處理的訊息不寫', async ($, on) => {
  const host = engine(on, { files: { [MARKER]: 'guard\n' } })
  await send($, '好，繼續')
  expect(host.text(MARKER)).toBe('guard\n')
  expect(host.writes).toEqual([])
})

test('對話開超過一天：重寫一次標記檔（更新修改時間，每週的清理才不會刪掉還開著的對話的標記）', async ($, on) => {
  const host = engine(on, { files: { [MARKER]: 'guard\n' } })
  await send($, '好，繼續')
  expect(host.writes).toEqual([])
  await host.clock.advance(25 * 3600 * 1000)
  await send($, '好，再繼續')
  expect(host.writes).toEqual([MARKER])
  expect(host.text(MARKER)).toBe('recall\n')
})

test('重新啟動或熱重載之後（模組變數清空），這場對話之前帶過的不再帶：讀今天與昨天的紀錄（別的程序與指令型後備寫的也算）', async ($, on) => {
  const row = (session: string, ref: string) => `${JSON.stringify({ at: '2026-11-20T23:00:00.000Z', session, ref, score: 5 })}\n`
  const host = engine(on, {
    files: {
      // 指令型後備寫的（昨天）與另一個程序寫的（今天）
      [`${USAGE_DIR}/2026-11-20.jsonl`]: row('s1', 'global/oven-thermometer.md'),
      [`${USAGE_DIR}/2026-11-21.zz99aa00.jsonl`]: row('s1', 'projects/p-bakery/memory/cake-deposit.md') + row('other', 'global/filler-1.md'),
    },
  })
  await send($, ASK)
  expect(last(host).context).toBeUndefined()
  await send($, '客製蛋糕的訂金可以退嗎？')
  expect(last(host).context).toBeUndefined()
  expect(host.writes.filter(w => w.startsWith(USAGE_DIR))).toEqual([]) // 沒有帶出就不寫紀錄
})

test('前天以前的紀錄不算：同一場對話隔了兩天以上可以再帶', async ($, on) => {
  const host = engine(on, {
    files: { [`${USAGE_DIR}/2026-11-19.jsonl`]: `${JSON.stringify({ at: '2026-11-19T01:00:00.000Z', session: 's1', ref: 'global/oven-thermometer.md', score: 5 })}\n` },
  })
  await send($, ASK)
  expect(last(host).context).toHaveLength(1)
  expect(host.text(`${USAGE_DIR}/2026-11-19.jsonl`)).toContain('oven-thermometer') // 別人的檔不動
})
