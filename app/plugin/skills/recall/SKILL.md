---
name: recall
description: 從 Engram 的所有範圍（其他專案、全域、每台電腦）找出和目前問題相關的經驗、決定與踩過的坑，整理成可以直接套用的結論並附上來源。使用者問「之前有沒有遇過…」「其他專案怎麼做的」「我以前怎麼設定…」，或輸入 /engram:recall 時使用。只讀不寫。
argument-hint: "<主題或問題>"
allowed-tools: Bash(engram search *) Bash(engram memory show *) Bash(engram memory list *) Bash(engram projects) Bash(engram status) PowerShell(engram search *) PowerShell(engram memory show *) PowerShell(engram memory list *) PowerShell(engram projects) PowerShell(engram status)
---

# 從記憶找經驗

要找的主題：`$ARGUMENTS`（空白時依目前對話正在處理的問題決定；看不出來就問使用者）。

這個流程只讀不寫，不修改任何記憶。用 Bash 工具執行 `engram` 指令。

## 步驟

1. **搜尋**：用 `engram search <關鍵字> --limit 10` 搜 3～5 次，換不同的說法：中文與英文、工具或產品名稱、錯誤訊息裡的關鍵字、同義詞（例如「編碼／encoding／BOM」）。
2. **讀內容**：挑相關的結果，用 `engram memory show <ref> [<ref> ...]` 讀全文。需要看某個專案還有哪些記憶時，用 `engram memory list --project <pid>`。
3. **整理成答案**：
   - **結論**：可以直接套用在目前問題的做法，條列。
   - **注意事項**：踩過的坑、例外、前提條件。
   - **來源**：一張表，列出記憶名稱、範圍（哪個專案、全域或哪台電腦）、記憶裡寫的日期。
4. **標出需要確認的地方**：
   - 單機記憶只在那台電腦成立；在這台電腦用之前要先確認環境相同（目前在哪台電腦，看對話開頭的 [Engram] 動態內容或 `engram status`）。
   - 日期很舊、或記憶之間說法不一致的，指出來，不要自己挑一個當成事實。
   - 找不到相關記憶就直接說找不到，不要用一般知識冒充記憶的內容。
5. 答案對目前專案很重要、而專案裡還沒有記錄時，可以建議使用者用 `/engram:save` 存一份到目前的專案。

不要整段貼上記憶的原文；摘要重點並註明出處。
