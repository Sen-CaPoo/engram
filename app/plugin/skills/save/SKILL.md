---
name: save
description: 把這次對話裡值得長期記住的事存進 Engram：判斷該放專案、全域還是單機，先查有沒有相近的記憶（有就更新那一筆），格式符合 Claude Code 的記憶規範，使用者確認後才寫入。使用者說「把這些記下來」「存成記憶」「記住這個做法」，或輸入 /engram:save 時使用。
argument-hint: "[要記住的事；省略時回顧整段對話]"
allowed-tools: Bash(engram memory *) Bash(engram search *) Bash(engram remember *) Bash(engram undo *) Bash(engram status) Bash(engram projects) Bash(engram sync) Bash(engram sync *) PowerShell(engram memory *) PowerShell(engram search *) PowerShell(engram remember *) PowerShell(engram undo *) PowerShell(engram status) PowerShell(engram projects) PowerShell(engram sync) PowerShell(engram sync *) Edit(~/.engram/local/drafts/**)
---

# 把對話重點存進 Engram

要記住的內容：`$ARGUMENTS`（空白時回顧整段對話，自己找出值得記住的事）。

- 以「執行：」開頭（例如 `執行：全部`、`執行：1,3,5`）→ 使用者已經同意這個對話裡先前提出的計畫。不要重新規劃，直接從步驟 6 開始，只做列出的編號；寫入前仍要重新讀取，用最新的版本。對話裡還沒有提出過計畫時，當成一般的呼叫，從步驟 1 開始。

用 **Bash** 工具執行所有 `engram` 指令；寫入內容用 heredoc（`<<'EOF'`）從標準輸入傳入。一次執行一個 `engram` 指令，不要用 `;`、`&&` 或管線把其他指令、分隔字串串在一起：預先允許只涵蓋 `engram` 指令本身，串接後 Claude Code 會要求逐一核准。

**只有 PowerShell 工具、沒有 Bash 時**：讀取類指令照常執行；寫入時不要用 PowerShell 的管線或 here-string 傳內容（Windows PowerShell 5.1 會把中文變成問號）。改用 Write 工具把整份內容寫成草稿檔 `~/.engram/local/drafts/<任意名稱>.md`（完整路徑是 `engram status` 列出的 vault 資料夾旁邊的 `local\drafts`），再把指令裡的 heredoc 換成 `--file ~/.engram/local/drafts/<任意名稱>.md`。寫入成功後草稿會自動刪除；失敗時草稿保留，修正後再試。

## 步驟

1. **找出值得記的事**。值得記的：
   - 使用者的偏好、糾正過你的地方、明確認可的做法（feedback）
   - 使用者的角色、背景、工作方式（user）
   - 專案的決策、限制、進度里程碑、踩過的坑（project）
   - 外部資源的位置：網址、儀表板、文件、帳號存放處（reference）

   不要記：從程式碼或 git 歷史就看得出來的事、只跟這次任務有關的暫時狀態、CLAUDE.md 或核心準則已經寫過的、密鑰的值（改記「存放在哪裡、怎麼取得」）。
2. **決定範圍**，一筆一件事：
   - **專案**（預設）：只跟目前這個專案有關。pid 看 `engram status` 的「目前資料夾」一行。
   - **全域**：任何專案都成立（使用者偏好、跨專案通用的工具經驗）。全域記憶會進每個對話的索引，寧缺勿濫。
   - **單機**：只在這台電腦成立（安裝路徑、網路設定、本機版本）；只跟某個專案有關時加 `--project <pid>`。
   - 判斷不了就放專案範圍。
3. **先查再寫**：每一筆都用 `engram search <關鍵字>` 查（中英文各試一次）。有講同一件事的記憶，就用 `engram memory show <ref>` 讀出來，計畫改成「更新那一筆」，不要新增重複的。
4. **提出計畫**，然後停下來等使用者回覆：

   | # | 動作 | 範圍 | 名稱 | 類型 | 一句話說明 |
   |---|---|---|---|---|---|

   「動作」是「新增」或「更新 <ref>」。表格下方附上每一筆的內文草稿（不長的話）。
5. **取得同意**：用 AskUserQuestion 詢問，選項是「全部寫入」「只寫部分（請告訴我編號）」「先不要」。在同一個回合裡取得同意，執行時才不會逐一跳出權限詢問。沒有 AskUserQuestion 工具時，列出這三個選項，然後停下來等使用者回覆。使用者沒有明確同意，就不執行任何寫入。
6. **執行**：只做使用者同意的項目，逐項執行並看輸出。任何一步失敗就停下來說明原因，不要換別的方法硬改。
   - 使用者是在**之後的訊息**才同意時（例如回覆「全部寫入」），先用 Skill 工具重新呼叫 `engram:save`，參數寫「執行：」加上同意的編號（例如 `執行：全部`、`執行：1,3,5`），在那一輪執行。這個技能預先允許的指令只在呼叫它的那一回合有效，不重新呼叫的話，每個指令都會跳出權限詢問。
7. **收尾**：執行 `engram sync`，回報每一筆寫到哪個範圍、記憶名稱是什麼，以及復原指令（如果輸出有附）。

## 格式

- `--name` 用 kebab-case 英數，會成為檔名；`--description` 是一句具體的話（索引只顯示這一句，Claude 靠它判斷要不要讀）。
- feedback 與 project 類型，內文之後加上 `**Why:**` 與 `**How to apply:**` 兩行。
- 一律寫絕對日期（例如 2026-10-23），不寫「今天」「下週」。
- 相關的記憶用 `[[name]]` 連結。
- 用使用者平常的語言寫。

## 指令

```bash
# 新增（--scope project|global|machine；專案以外要指定專案時加 --project <pid>）
engram remember --scope project --name <名稱> --type <user|feedback|project|reference> \
  --description "<一句話>" <<'EOF'
<內文>

**Why:** <原因>
**How to apply:** <之後怎麼做>
EOF

# 更新既有的一筆（整份內容，含 frontmatter；--base 是 show 時的版本）
engram memory write <ref> --base <版本> <<'EOF'
<整份內容>
EOF
```

- 更新既有記憶時保留原本 frontmatter 的其他欄位，只改需要改的部分。
- 一律透過 `engram` 指令寫入，不要用 Write 直接寫 `~/.engram/vault`。
- `engram remember` 因為 `E_SECRET` 以外的原因失敗時（例如找不到 engram 指令），說明錯誤並問使用者要不要改成寫在專案的自動記憶資料夾。被 `E_SECRET` 擋下的內容不可以改寫到任何地方，照下一點處理。
- Engram 回報 `E_SECRET`（內容疑似含有金鑰）時，不要換別的方式或寫到別的地方，也不要自己判斷那不是金鑰：向使用者說明是哪一筆、哪一行，建議改成只記「存放在哪裡、怎麼取得」。使用者表示那不是金鑰時，請使用者**自己**在終端機（不是 Claude Code 的對話）執行 `engram not-secret --value <那個值>`（既有檔案裡的用 `engram not-secret <ref> --line <行號>`），或在管理介面按「這不是金鑰」；你不能代為執行，在 Claude Code 裡執行會被拒絕。使用者完成後再執行原本的指令。
