---
name: tidy
description: 用 AI 深度整理 Engram 記憶：找出規則抓不到的語意重複、過時或互相矛盾的內容、放錯範圍的記憶、說不清楚的說明，以及過長的索引與核心準則，提出整理計畫，使用者同意後才執行。可以整理一個專案、全域、單機、核心準則或單筆記憶。使用者說「整理這個專案的記憶」「精簡核心準則」「檢查這筆記憶」，或輸入 /engram:tidy 時使用。
argument-hint: "[專案 pid | global | machine | core | 記憶 ref]"
allowed-tools: Bash(engram inbox) Bash(engram inbox *) Bash(engram memory *) Bash(engram core) Bash(engram core *) Bash(engram search *) Bash(engram remember *) Bash(engram undo *) Bash(engram status) Bash(engram projects) Bash(engram sync) Bash(engram sync *) PowerShell(engram inbox) PowerShell(engram inbox *) PowerShell(engram memory *) PowerShell(engram core) PowerShell(engram core *) PowerShell(engram search *) PowerShell(engram remember *) PowerShell(engram undo *) PowerShell(engram status) PowerShell(engram projects) PowerShell(engram sync) PowerShell(engram sync *) Edit(~/.engram/local/drafts/**)
---

# 整理 Engram 記憶

健康檢查用規則只能抓到「名稱相同」「檔案太大」這類表面問題。這個流程靠你讀懂內容，把記憶整理成 Claude 每次都用得上的樣子。**使用者同意之前不改任何東西。**

整理的對象：`$ARGUMENTS`
- 空白 → 目前資料夾所屬的專案（`engram status` 的「目前資料夾」一行有 pid）。沒有綁定時，用 `engram projects` 列出專案，問使用者要整理哪一個。
- 專案 pid → 那個專案的記憶。
- `global` → 全域記憶；`machine` → 這台電腦的單機記憶。
- `core` → 每次對話都會載入的部分：核心準則 CORE.md、全域索引、這台電腦的單機索引（合計建議 200 行以內）。
- 記憶 ref（含 `/`，例如 `global/powershell-bom.md`）→ 只檢查這一筆。
- 以「執行：」開頭（例如 `執行：全部`、`執行：1,3,5`）→ 使用者已經同意這個對話裡先前提出的計畫。不要重新規劃，直接從步驟 6 開始，只做列出的編號；寫入前仍要重新讀取，用最新的版本。對話裡還沒有提出過計畫時，當成一般的呼叫，從步驟 1 開始。

用 **Bash** 工具執行所有 `engram` 指令；寫入內容用 heredoc（`<<'EOF'`）從標準輸入傳入。一次執行一個 `engram` 指令，不要用 `;`、`&&` 或管線把其他指令、分隔字串串在一起：預先允許只涵蓋 `engram` 指令本身，串接後 Claude Code 會要求逐一核准。

**只有 PowerShell 工具、沒有 Bash 時**：讀取類指令照常執行；寫入時不要用 PowerShell 的管線或 here-string 傳內容（Windows PowerShell 5.1 會把中文變成問號）。改用 Write 工具把整份內容寫成草稿檔 `~/.engram/local/drafts/<任意名稱>.md`（完整路徑是 `engram status` 列出的 vault 資料夾旁邊的 `local\drafts`），再把指令裡的 heredoc 換成 `--file ~/.engram/local/drafts/<任意名稱>.md`。寫入成功後草稿會自動刪除；失敗時草稿保留，修正後再試。

## 步驟

1. **盤點**：
   - 專案：`engram memory list --project <pid>`；`engram projects` 看索引用了幾行（Claude Code 只載入 MEMORY.md 的前 200 行）。
   - 全域／單機：`engram memory list --scope global` 或 `--scope machine`。
   - core：`engram core`（附載入預算），再加上全域與單機的清單。
   - 也看一下收件匣有沒有相關的卡片：`engram inbox`。
2. **讀內容**：`engram memory show <ref> [<ref> ...]`，一次 5～10 筆。內容已在本機遮蔽疑似金鑰；每筆附「版本」，寫回時要用。整理的是目前資料夾的專案時，可以對照程式碼與 `git log` 確認記憶是否已過時。
3. **找問題**，逐項檢查：
   - **重複或該合併**：同一件事分散在幾筆、或兩筆講的是同一個主題。
   - **互相矛盾**：新舊說法不同。以日期較新、或與程式碼現況相符的為準。
   - **過時**：已完成的一次性任務、只記錄當時進度、已不存在的路徑或版本。
   - **範圍放錯**：任何專案都成立的偏好 → 全域；只在某台電腦成立的環境事實 → 單機；講的是別的專案 → 移到那個專案。
   - **一筆講好幾件事** → 拆分。
   - **說明（description）不清楚**：索引只顯示 description，Claude 靠它決定要不要打開這筆。改寫成具體、可以判斷用途的一句話。
   - **缺少脈絡**：feedback 與 project 類型缺 `**Why:**`、`**How to apply:**`；寫了「昨天」「下週」這類相對日期。
   - **不該記的**：從程式碼或 git 歷史就看得出來的事、密鑰的值（遇到疑似金鑰時照 `/engram:inbox` 的 H13 做法處理，不要讀原檔）。
   - core：核心準則裡重複、已被全域記憶涵蓋、或很少用到的規則；全域記憶的 description 是否夠精簡（每一筆在索引裡佔一行）。
4. **提出計畫**：一張表，然後停下來等使用者回覆：

   | # | 記憶 | 問題 | 建議 | 會改什麼 |
   |---|---|---|---|---|

   表格下方用一兩行寫出預期效果（例如「32 筆 → 24 筆，索引 168 → 121 行」）。拿不定主意的標成「請你決定」。
5. **取得同意**：用 AskUserQuestion 詢問，選項是「全部照計畫執行」「只執行部分（請告訴我編號）」「先不要」。在同一個回合裡取得同意，執行時才不會逐一跳出權限詢問。沒有 AskUserQuestion 工具時，列出這三個選項，然後停下來等使用者回覆。使用者沒有明確同意，就不執行任何寫入。
6. **執行**：只做使用者同意的項目，逐項執行並看輸出。任何一步失敗就停下來說明原因，不要換別的方法硬改。
   - 使用者是在**之後的訊息**才同意時（例如回覆「全部照計畫執行」），先用 Skill 工具重新呼叫 `engram:tidy`，參數寫「執行：」加上同意的編號（例如 `執行：全部`、`執行：1,3,5`），在那一輪執行。這個技能預先允許的指令只在呼叫它的那一回合有效，不重新呼叫的話，每個指令都會跳出權限詢問。
7. **收尾**：執行 `engram sync`，用一張表回報每一項的結果與復原指令（輸出裡的 `engram undo <版本>`）。

## 指令

```bash
engram memory list --project <pid>                # 或 --scope global|machine，可加 --type feedback
engram memory show <ref> [<ref> ...]
engram memory move <ref> --to global              # 或 --to machine、--to project:<pid>
engram memory remove <ref>                        # 封存到歷史，可以還原
engram remember --scope project --project <pid> --name <名稱> --type <類型> --description "<一句話>" <<'EOF'
<拆分出來的新記憶內文>
EOF
engram core
engram search <關鍵字>
engram sync
```

改寫、合併與寫回核心準則，內容一律用 heredoc 從標準輸入傳入，並帶上讀取時的版本：

```bash
engram memory write <ref> --base <版本> <<'EOF'
<整份內容，含 frontmatter：name 與檔名相同、description、metadata.type>
EOF

engram memory merge <ref1> <ref2> [<ref3> ...] --into <ref1> --base <版本1>,<版本2>[,...] <<'EOF'
<合併後的整份內容；只給內文時沿用 --into 那一筆的 frontmatter>
EOF

engram core write --base <版本> <<'EOF'
<整份 CORE.md>
EOF
```

## 原則

- **不讓事實消失**：合併、拆分、精簡時，每個仍然有效的事實（含日期、原因、做法）都要留在某一筆裡。真的要拿掉的內容，在計畫裡逐項說明理由。
- 封存（`engram memory remove`）只用在使用者明確同意的項目；可以用 `engram undo` 或管理介面的歷史還原。
- 改寫時保留 frontmatter 的其他欄位（例如 `metadata.originSessionId`、`metadata.engram`），只改需要改的部分；`name` 必須與檔名相同。
- 記憶內文維持原本的語言與寫法，不要改成你的風格；日期一律寫絕對日期。
- 釘選的記憶（`metadata.engram.pinned: true`）是使用者特別要保留在索引前面的，可以改寫得更清楚，但不要建議封存或合併掉。
- 寫回核心準則時：檔案開頭的註解、`<!-- engram:environments:begin -->` 到 `<!-- engram:environments:end -->` 之間的內容、以及引用全域索引的那一行（`@` 開頭）由 Engram 維護，原樣保留。只精簡使用者自己寫的規則，並在計畫中列出刪改前後的差異。
- 一律透過 `engram` 指令讀寫，不要用 Read、Write、Edit 直接碰 `~/.engram/vault`。
- 遇到 `E_CONFLICT`（讀取之後被改過）：重新 `show`，依最新內容重新判斷，再問一次使用者。
- Engram 回報 `E_SECRET`（內容疑似含有金鑰）時，不要換別的方式或寫到別的地方，也不要自己判斷那不是金鑰：向使用者說明是哪一筆、哪一行，建議改成只記「存放在哪裡、怎麼取得」。使用者表示那不是金鑰時，請使用者**自己**在終端機（不是 Claude Code 的對話）執行 `engram not-secret --value <那個值>`（既有檔案裡的用 `engram not-secret <ref> --line <行號>`），或在管理介面按「這不是金鑰」；你不能代為執行，在 Claude Code 裡執行會被拒絕。使用者完成後再執行原本的指令。
- 移到單機時確認是哪一台電腦的事實：`--to machine` 是目前這台，其他電腦用 `--to machine:<mid>`（mid 見 `engram status` 或管理介面的「裝置與同步」頁）。
