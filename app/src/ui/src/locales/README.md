# 管理介面的多語系

介面以正體中文撰寫，英文是對照翻譯。架構在 `../i18n.js`，完整性由 `app/test/ui/i18n.test.mjs` 檢查。

## 寫法

| 情況 | 寫法 |
|---|---|
| 一般文字 | `t('立即同步')` |
| 帶參數 | `t('已匯入 {n} 筆記憶', { n })`（參數名稱用英數） |
| 文字中間有元素 | `t('執行 {cmd} 重新登入', { cmd: <code>gh auth login</code> })`，回傳陣列，直接放進 JSX |
| 模組層的標籤表 | 值寫 `N_('全域')`，顯示時 `t(TABLE[k])` |
| 同一句中文、不同英文 | 鍵前加情境：`t('nav::專案')`（Projects）、`t('專案')`（Project）。中文模式會去掉情境 |
| 常駐程式傳來的文字 | `local(finding, 'title')`：英文模式且物件有 `en.title` 時用英文 |
| 刻意不翻的一行 | 行尾加註解 `// i18n-ignore`（例如只是比對中文標點的正規表示式） |

規則：
- 鍵一定是單引號或雙引號的字串字面值，不能用樣板字串、不能串接。動態內容一律走參數。
- 中文改了，鍵就變了：同時更新 `locales/en/<檔名>.js`。測試會抓出缺漏、多餘、參數不一致與英文裡混入的中文。
- 英文值可以是函式，用來處理單複數：`({ n }) => (n === 1 ? '1 memory' : '{n} memories')`。回傳的字串一樣會代入參數。
- 英文值不能有中文；唯一例外是中文原文裡用「」引起來的範例（例如資料夾名稱「照片優化-66ca」），可以原樣保留。
- 每個介面原始檔對應一份 `locales/en/<檔名>.js`；跨檔共用的詞放 `common.js`。同一個鍵出現在兩份檔案時，英文必須相同。

## 英文風格

- 句首大寫（sentence case）：按鈕 `Sync now`、標題 `Recent memories`，不用 Title Case。
- 語氣：直接、簡短、對使用者說「you」。中文的「請」通常不必翻。
- 全形標點換成英文標點：「」→ ""、，→ , 、。→ . 、：→ : 、（）→ ()。
- 數字與單位：`{n} min ago`、`1 memory` / `{n} memories`。
- 中文裡的指令、路徑、檔名、程式識別字原樣保留。

## 詞彙表

| 中文 | English | 說明 |
|---|---|---|
| 記憶 | memory / memories | |
| 記憶庫（頁面） | Library | 導覽與頁面名稱 |
| vault、記憶庫（儲存處） | vault | `~/.engram/vault` |
| 收件匣 | inbox | |
| 卡片 | card | 收件匣的一張卡片 |
| 總覽 | Overview | |
| 專案 | project | |
| 全域 | Global | 範圍 |
| 單機 | Machine（範圍標籤）／machine memory、this computer only（說明文字） | 只在某一台電腦載入 |
| 範圍 | scope | |
| 核心準則 | core rules | CORE.md |
| 工作準則 | working guidelines | `~/.claude/CLAUDE.md` 的內容 |
| 常駐程式 | agent | `engram agent` |
| 管理介面 | dashboard | |
| 同步 | sync | |
| 推送 | push | |
| 遠端 | remote | |
| 這台（電腦） | this computer | |
| 另一台、對方 | the other computer | |
| 裝置 | device | 頁面名稱 Devices |
| 綁定／解除綁定 | bind / unbind | 資料夾與專案的連結 |
| 接上（資料夾） | connect | |
| 收編 | adopt | 把既有記憶收進 vault |
| 匯入 | import | |
| 沙盒演練 | sandbox rehearsal | |
| 還原點 | restore point | |
| 還原（到匯入前） | restore | 整批回到之前的狀態 |
| 復原 | undo | 撤銷單一變更 |
| 歷史 | history | |
| 變更紀錄 | change history | |
| 衝突 | conflict | |
| 健康檢查 | health check | |
| 發現 | finding | 健康檢查的結果 |
| 高／中／建議 | High / Medium / Suggestion | 嚴重度 |
| 需要處理 | needs attention | |
| 忽略 | dismiss | |
| 疑似金鑰 | possible secret | |
| 遮蔽 | redact | |
| 這不是金鑰 | Not a secret | |
| 撞名資料夾 | colliding folders | 中文路徑編碼後相同的資料夾 |
| 依命名規則改名 | rename by naming rule | |
| 索引 | index | MEMORY.md |
| 釘選 | pin | |
| 合併 | merge | |
| 封存 | archive | |
| 交給 Claude | Ask Claude | |
| 對話 | conversation | Claude Code 的一次對話 |
| 排程工作 | scheduled job | |
| 相容性探測 | compatibility probe | |
| 日誌 | logs | |
| 權限模式 | permission mode | |
| 設定檔 | settings file | `.claude/settings.local.json` |
| Engram 憶跡 | Engram | 英文介面只用 Engram |
