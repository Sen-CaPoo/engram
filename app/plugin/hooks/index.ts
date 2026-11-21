// 外掛唯一的 hooks 模組：hooks.json 的 modules 只能列一個（Claude Code 2.1.329 實測：第二個會被拒絕，validate 與載入都失敗），
// 所以各功能各寫一個檔案、各自匯出 register，在這裡依序註冊。新增功能時在這裡加一行匯入與一行呼叫。
import type { Register } from 'claude-code'

import { register as registerGuard } from './guard'
import { register as registerLens } from './lens'
import { register as registerRecall } from './recall'

export const register: Register = (on, options) => {
  registerLens(on, options)
  registerGuard(on, options)
  registerRecall(on, options)
}
