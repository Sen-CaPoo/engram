// 憶跡面板保存在 $.state 的值。

/** 記憶屬於哪個範圍；instructions 是 CLAUDE.md 與 .claude/rules 這類指示檔 */
export type LensScope = 'core' | 'global' | 'machine' | 'project' | 'instructions'

/** 怎麼進到對話裡：開場載入、壓縮後重新載入、巢狀載入、讀取全文、搜尋命中 */
export type LensHow = 'start' | 'compact' | 'nested' | 'read' | 'search'

export type LensEntry = {
  /** 清單裡的唯一鍵：L: 開場載入、R: 對話中讀取，後面接路徑 */
  id: string
  path: string
  scope: LensScope
  name: string
  how: LensHow
  /** 第幾回合；開場載入是 0 */
  turn: number
  /** 專案 pid 或電腦 mid */
  owner?: string
  /** 用 @ 匯入這個檔案的上層檔案 */
  parent?: string
  tokens?: number
  /** 索引檔列了幾則記憶 */
  titles?: number
  /** 其中 Claude 看得到幾則（MEMORY.md 只載入前 200 行或 25KB） */
  visible?: number
  query?: string
  isAgent?: boolean
  times?: number
}

export type LensDetail = {
  /** 點開的是哪一列（LensEntry.id），用來顯示它怎麼、什麼時候進到對話 */
  id: string
  path: string
  scope: LensScope
  name: string
  description: string
  body: string
  isMissing: boolean
}

export type LensFilter = LensScope | 'all'

export type LensLang = 'zh' | 'en'

declare module 'claude-code' {
  interface PluginState {
    engram: {
      loaded: Shaped<LensEntry[]>
      reads: Shaped<LensEntry[]>
      turn: number
      filter: LensFilter
      detail: Shaped<LensDetail | null>
      /** null：這段對話還沒決定語言（/clear 之後） */
      lang: LensLang | null
    }
  }
}
