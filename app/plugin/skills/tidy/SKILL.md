---
name: tidy
description: 請 Claude 深度整理 Engram 記憶：讀過指定範圍的記憶，找出重複、過時、互相矛盾、放錯範圍與說明不清楚的內容，把建議（含修改後的完整內容）存成整理記錄，請使用者到管理介面逐項決定；分析時不改任何記憶。使用者說「整理記憶」「整理全域／這個專案的記憶」，或貼上管理介面產生的 /engram:tidy 指令時使用。
argument-hint: "<global | machine | project:<pid> | core | all | 記憶 ref> [補充說明]"
allowed-tools: Bash(engram memory list) Bash(engram memory list *) Bash(engram memory show *) Bash(engram core) Bash(engram search *) Bash(engram inbox) Bash(engram status) Bash(engram projects) Bash(engram tidy create *) Bash(engram tidy list) Bash(engram tidy show *) PowerShell(engram memory list) PowerShell(engram memory list *) PowerShell(engram memory show *) PowerShell(engram core) PowerShell(engram search *) PowerShell(engram inbox) PowerShell(engram status) PowerShell(engram projects) PowerShell(engram tidy create *) PowerShell(engram tidy list) PowerShell(engram tidy show *) Edit(~/.engram/local/drafts/**)
---

# 請 Claude 整理記憶（產生整理記錄）

這個流程只做分析：讀記憶、判斷、把建議與修改後的內容存成「整理記錄」，再請使用者到管理介面逐項決定。**使用者在網頁決定、同意之前，不改任何記憶**；決定好之後，使用者會貼上 `/engram:tidy-apply <id>`，由那個技能執行。

範圍與補充說明：`$ARGUMENTS`
- 第一個詞是範圍：`global`（全域）、`machine`（這台電腦的單機記憶）、`project:<pid>`（只寫 pid 也可以）、`core`（核心準則與每次都會載入的索引）、`all`（全部範圍）、記憶 ref（只檢查一筆，例如 `global/powershell-bom.md`）。
- 空白：目前資料夾所屬的專案（`engram status` 的「目前資料夾」一行有 pid）。沒有綁定時，用 `engram projects` 列出專案，問使用者要整理哪一個。
- 範圍之後的文字是使用者的補充說明（重點、限制、哪些先不要動）。一律照做，並把原文放進計畫的 `request`。

用 **Bash** 工具執行所有 `engram` 指令。一次執行一個 `engram` 指令，不要用 `;`、`&&` 或管線把其他指令串在一起：預先允許只涵蓋 `engram` 指令本身，串接後 Claude Code 會要求逐一核准。計畫與內容檔一律用 Write 工具寫在 `~/.engram/local/drafts/` 底下。

**只有 PowerShell 工具、沒有 Bash 時**：指令照常執行；計畫與內容檔本來就用 Write 工具寫成 UTF-8 檔案，不要用 PowerShell 的管線或 here-string 傳內容（Windows PowerShell 5.1 會把中文變成問號）。草稿資料夾的完整路徑是 `engram status` 列出的 vault 資料夾旁邊的 `local\drafts`，指令裡寫成 `--file ~/.engram/local/drafts/<資料夾>/plan.json` 即可。

## 步驟

1. **盤點**（只看清單與說明）：
   - 全域：`engram memory list --scope global`；單機：`engram memory list --scope machine`；專案：`engram memory list --project <pid>`。
   - core：`engram core`（附載入預算）、全域與單機的清單。
   - all：全域、單機，再用 `engram projects` 列出專案，逐一 `engram memory list --project <pid>`。
   - 也看一下收件匣的健康檢查：`engram inbox`（清單裡每筆記憶後面的 H 代碼也是線索）。
2. **讀內容**：`engram memory show <ref> [<ref> ...]`，一次 5～10 筆。內容已在本機遮蔽疑似金鑰；每筆附「版本」，寫計畫時要用。範圍超過 40 筆時，先從清單與說明挑出可能有問題的，只讀那些的全文。整理的是目前資料夾的專案時，可以對照程式碼與 `git log` 確認記憶是否已過時。需要比對其他範圍時用 `engram search <關鍵字>`。
3. **判斷**，逐筆檢查：
   - **重複或該合併**：同一件事分散在幾筆、或兩筆講的是同一個主題。
   - **已寫在核心準則**：使用者的身分、公司、常用工具等已在 CORE.md 的內容，不必在記憶裡再存一份。
   - **互相矛盾**：新舊說法不同，以日期較新、或與程式碼現況相符的為準。
   - **過時**：已完成的一次性任務、只記錄當時進度、已不存在的路徑或版本、會過期的狀態（例如「截至某日尚未確認」）。
   - **範圍放錯**：任何專案都成立 → 全域；只在某台電腦成立 → 單機；講的是某個專案（尤其是只在那個專案講的授權或前提）→ 搬到那個專案。
   - **一筆講好幾件事**：搬移或拆分時，先把仍然跨專案有用的部分抽出成新的一筆（create），不要讓有用的經驗跟著搬走。
   - **說明（description）不清楚**：索引只顯示 description，Claude 靠它決定要不要打開這筆。改寫成具體、可以判斷用途的一句話。
   - **缺少脈絡**：feedback 與 project 類型缺 `**Why:**`、`**How to apply:**`；寫了「昨天」「下週」這類相對日期。
   - **連結**：斷掉的 `[[名稱]]`；被搬走的記憶如果被其他記憶連結，順手更新那些連結；相關的記憶互相連結。
   - core：核心準則裡重複、已被全域記憶涵蓋、或很少用到的規則；全域記憶的 description 是否夠精簡。
4. **寫整理計畫**：用 Write 工具把檔案寫進 `~/.engram/local/drafts/tidy-<範圍>/`（例如 `tidy-global`、`tidy-demo-repo-x1y2z`；Write 會自動建立資料夾，不必先檢查或建立）：
   - 每一個要改寫、合併或新增的記憶，寫一個完整的記憶檔（frontmatter＋內文），檔名用記憶名稱，例如 `client-proposal-wording.md`；改寫核心準則時寫 `CORE.md`。
   - `plan.json`，格式如下（字串裡的換行寫成 `\n`；長內容放 .md 檔，不要塞進 JSON）：

   ```json
   {
     "scope": "global",
     "request": "使用者的補充說明原文（沒有就省略）",
     "summary": "一兩句整體結論",
     "highlights": ["整體建議的要點（3～5 點）"],
     "items": [
       {
         "ref": "global/user-profile.md",
         "group": "你的背景",
         "action": "move",
         "title": "整筆搬到訂單系統專案",
         "reason": "判斷的依據：引用記憶裡的具體內容，說明為什麼這樣處理",
         "ops": [
           { "op": "create", "scope": "global", "file": "git-longpaths.md" },
           { "op": "write", "ref": "global/user-profile.md", "base": "6aeadf16af", "file": "user-profile.md" },
           { "op": "move", "ref": "global/user-profile.md", "to": "project:order-system-x1y2z" }
         ]
       },
       { "ref": "global/powershell-bom.md", "group": "工具經驗", "action": "keep", "title": "保留", "reason": "跨專案通用，內容仍然正確", "ops": [] }
     ],
     "kept": []
   }
   ```

   - `action`（顯示用的標籤）：keep、update、move、archive、merge、create、split、promote。建議保留就用 keep，`ops` 留空。
   - `ops` 依序執行：`write {ref, base, file}`、`move {ref, base, to}`（to：global、machine、machine:<mid>、project:<pid>）、`remove {ref, base}`（封存，可以復原）、`merge {refs, bases, into, file}`、`create {scope, file}`（scope：global、machine、project:<pid>；名稱、說明、類型取自內容檔的 frontmatter）、`core {base, file}`。`base` 是 `engram memory show`（核心準則是 `engram core`）印出的版本：第一次處理一筆記憶時一定要給，Engram 靠它確認建議之後記憶沒有被改過；同一項裡第二次處理同一筆記憶時不必再給。搬移的目的地不能已有同名的記憶（會被改名）：那種情況改用合併。
   - 每一筆記憶只能出現在一項裡（當主角或被修改都算）；整份計畫一筆記憶最多由一個項目修改。範圍 40 筆以內時每一筆都列一項（含建議保留的）；範圍更大時只列有建議的，其餘看過的 ref 放進 `kept`。
   - `title` 一句話說出建議；`reason` 寫依據（使用者是看這段決定的），具體到哪一句、哪個日期；`group` 依主題分 3～6 組。
   - 內容檔：frontmatter 保留原有欄位（例如 `metadata.originSessionId`、`metadata.engram`），`name` 與檔名相同；只改需要改的部分，維持原本的語言與寫法；日期一律寫絕對日期。不要寫出「‹已遮蔽›」標記：含疑似金鑰的記憶不要提出改寫，改在 reason 建議使用者先到收件匣遮蔽。
   - 核心準則：檔案開頭的註解、`<!-- engram:environments:begin -->` 到 `<!-- engram:environments:end -->` 的內容、引用全域索引的那一行（`@` 開頭）原樣保留。
   - 釘選的記憶（`metadata.engram.pinned: true`）可以建議改寫得更清楚，但不要建議封存或合併掉。
   - 不讓事實消失：合併、拆分、精簡時，每個仍然有效的事實（含日期、原因、做法）都要留在某一筆裡。
5. **建立整理記錄**：`engram tidy create --file ~/.engram/local/drafts/tidy-<範圍>/plan.json`。驗證不通過時會一次列出所有問題（記錄還沒有建立）：依訊息修正計畫或內容檔，再執行一次。成功後草稿會自動刪除。
6. **回報並停下來**：用幾行字告訴使用者範圍、共幾項、建議變更幾項、整體建議的 2～3 個重點，附上輸出裡的網址，請使用者到網頁逐項選「採用建議／維持原狀／封存／依備註調整」，按「產生執行指令」後把 `/engram:tidy-apply <id>` 貼回來。不要在對話裡逐項列出（網頁上都有），不要執行 `engram tidy apply`，停下來等使用者回覆。

## 不要做的事

- 不要改寫、搬移、封存或合併任何記憶；這個技能沒有那些權限，也不該嘗試其他方法。
- 不要用 Read、Write、Edit 直接碰 `~/.engram/vault`；讀取一律用 `engram memory show`、`engram core`。
- 疑似金鑰：`engram tidy create` 回報新的內容疑似含有金鑰時（訊息會寫明，處理方式與 E_SECRET 相同），不要換別的方式或寫到別的地方，也不要自己判斷那不是金鑰：把那一項改成只記「存放在哪裡、怎麼取得」。使用者表示那不是金鑰時，請使用者**自己**在終端機（不是 Claude Code 的對話）執行 `engram not-secret --value <那個值>`，或在管理介面按「這不是金鑰」；你不能代為執行。
