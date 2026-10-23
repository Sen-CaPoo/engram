---
name: inbox
description: 用 AI 整理 Engram 收件匣：逐張讀取健康檢查與同步衝突的內容，判斷該升級、合併、拆分、封存還是忽略，提出處理計畫，使用者同意後才執行。使用者說「整理收件匣」「處理 Engram 的待辦」，或輸入 /engram:inbox 時使用；使用者沒有要求時不要主動提起收件匣。
argument-hint: "[卡片 id | 代碼，例如 H09 | 自動（或 auto）]"
allowed-tools: Bash(engram inbox) Bash(engram inbox *) Bash(engram memory *) Bash(engram core) Bash(engram core *) Bash(engram search *) Bash(engram remember *) Bash(engram undo *) Bash(engram status) Bash(engram projects) Bash(engram sync) Bash(engram sync *) PowerShell(engram inbox) PowerShell(engram inbox *) PowerShell(engram memory *) PowerShell(engram core) PowerShell(engram core *) PowerShell(engram search *) PowerShell(engram remember *) PowerShell(engram undo *) PowerShell(engram status) PowerShell(engram projects) PowerShell(engram sync) PowerShell(engram sync *) Edit(~/.engram/local/drafts/**)
---

# 整理 Engram 收件匣

Engram 的健康檢查只用規則判斷，卡片只是「候選」。你的工作是讀內容、做規則做不到的判斷、提出計畫；**使用者同意之前不改任何東西**。

這次要處理的範圍：`$ARGUMENTS`
- 卡片 id（例如 `H07:1a2b3c4d5e`、`cf_20261022T083015_k3p9`）→ 只處理這一張。
- 代碼（例如 `H09`）→ 只處理這一類。
- 空白 → 整個收件匣。
- 含「自動」或 `auto`（例如 `自動`、`自動 H09`、`auto H09`；英文介面複製的指令用 `auto`）→ 自動處理模式，見下方「自動處理」。
- 以「執行：」開頭（例如 `執行：全部`、`執行：1,3,5`）→ 使用者已經同意這個對話裡先前提出的計畫。不要重新規劃，直接從步驟 6 開始，只做列出的編號；寫入前仍要重新讀取，用最新的版本。對話裡還沒有提出過計畫時，當成一般的呼叫，從步驟 1 開始。

用 **Bash** 工具執行所有 `engram` 指令；寫入內容用 heredoc（`<<'EOF'`）從標準輸入傳入。一次執行一個 `engram` 指令，不要用 `;`、`&&` 或管線把其他指令、分隔字串串在一起：預先允許只涵蓋 `engram` 指令本身，串接後 Claude Code 會要求逐一核准。

**只有 PowerShell 工具、沒有 Bash 時**：讀取類指令照常執行；寫入時不要用 PowerShell 的管線或 here-string 傳內容（Windows PowerShell 5.1 會把中文變成問號）。改用 Write 工具把整份內容寫成草稿檔 `~/.engram/local/drafts/<任意名稱>.md`（完整路徑是 `engram status` 列出的 vault 資料夾旁邊的 `local\drafts`），再把指令裡的 heredoc 換成 `--file ~/.engram/local/drafts/<任意名稱>.md`。寫入成功後草稿會自動刪除；失敗時草稿保留，修正後再試。

## 步驟

1. **讀取**：執行 `engram inbox`。是空的就告訴使用者「收件匣是空的」並結束。
2. **研究**：用 `engram inbox show <id> [<id> ...]` 讀完整內容（同類卡片一次看幾張）。輸出的記憶內容已在本機遮蔽疑似金鑰，每筆附「版本」，寫回時要用。需要更多脈絡時：
   - `engram search <關鍵字>`：有沒有內容相同或相關的記憶（判斷重複、升級全域時特別有用）。
   - `engram memory list --project <pid>`：同一個專案還有哪些記憶。
3. **判斷**：依下方「各類卡片怎麼判斷」，每張決定一個處理方式。拿不定主意的標成「請你決定」，不要猜。
4. **提出計畫**：用一張表列出，然後停下來等使用者回覆：

   | # | 卡片 | 判斷（一句話，說出依據） | 建議處理 | 會改什麼 |
   |---|---|---|---|---|

   「建議處理」只用這幾種：套用修正、合併、改寫、拆分、封存、處理衝突、忽略、延後 N 天、請你決定。「會改什麼」寫清楚哪個檔案會變、或「不改內容」。卡片很多時，同一類的可以合成一列（例如「H09 × 5：都只跟元大專案有關 → 忽略」）。
5. **取得同意**：用 AskUserQuestion 詢問，選項是「全部照計畫執行」「只執行部分（請告訴我編號）」「先不要」。在同一個回合裡取得同意，執行時才不會逐一跳出權限詢問。沒有 AskUserQuestion 工具時，列出這三個選項，然後停下來等使用者回覆。使用者沒有明確同意，就不執行任何寫入。
6. **執行**：只做使用者同意的項目，逐項執行並看輸出。任何一步失敗就停下來說明原因，不要換別的方法硬改。
   - 使用者是在**之後的訊息**才同意時（例如回覆「全部照計畫執行」），先用 Skill 工具重新呼叫 `engram:inbox`，參數寫「執行：」加上同意的編號（例如 `執行：全部`、`執行：1,3,5`），在那一輪執行。這個技能預先允許的指令只在呼叫它的那一回合有效，不重新呼叫的話，每個指令都會跳出權限詢問。
7. **收尾**：執行 `engram sync`，然後用一張表回報每一項的結果與復原指令（輸出裡的 `engram undo <版本>`）。

## 自動處理

使用者在參數裡寫了「自動」（或 `auto`），就是事先同意你依判斷直接處理。照樣做步驟 1～4（研究、判斷、列出計畫表），但不等待，接著執行有把握的項目，最後照步驟 7 回報。以下一律**不自動執行**，在計畫表標成「請你決定」並留到最後請使用者處理：

- H13 疑似金鑰（要使用者先把金鑰存好）
- H06 資料夾改名、H18 大量刪除
- 綁定與收編：H04、H05、H17、H19（會動到資料夾設定或搬動記憶的歸屬）
- 封存（H11 或任何 `engram memory remove`）
- 同步衝突（cf_ 開頭與 H15）：一律列出你的建議，由使用者選
- 你自己判斷沒有把握的項目

可以自動處理的是：H09、H08 的升級或搬移（以及忽略）、H07 的合併（保留雙方所有事實）、H12 的 frontmatter 修正、H10 的精簡或拆分、延後或忽略卡片。

## 各類卡片怎麼判斷

- **H09 可能適用所有專案**：全域記憶會出現在每個對話的索引裡，寧缺勿濫。只有在任何專案都成立的偏好或做法才升級（`engram inbox apply <id> --yes`）；內容提到特定客戶、專案、repo、檔案路徑的，維持原範圍並忽略卡片（`engram inbox dismiss <id>`）。一半通用、一半專案特定時，建議拆成一筆全域（`engram remember --scope global`）＋原檔只留專案特定的部分。
- **H08 只適用某台電腦**：確認內容真的是那台電腦的環境事實（安裝路徑、網路、磁碟、本機版本）才移到單機；是通用知識就忽略卡片。卡片沒有提供修正時（Engram 判斷不出是哪一台），請使用者確認是哪一台電腦，再用 `engram memory move <ref> --to machine:<mid>`；`--to machine` 是目前這台。
- **H07 內容相同／可能重複**：比對內容。真的重複 → 合併：保留資訊最完整、名稱最貼切的那一筆，寫出合併後的內容，保留雙方所有不重複的事實、日期與 Why／How to apply。只是主題相近、各講各的 → 忽略卡片。
- **H10 檔案過大或偏大**：一個檔案應該只講一件事。多主題 → 拆成幾筆（新的用 `engram remember`，原檔用 `engram memory write` 改成只留本身主題、用 `[[name]]` 連到拆出去的檔案）；有過時或重複的段落 → 精簡。拆分或精簡時每個仍然有效的事實都要留在某一筆裡。內容緊密、只是略大的「偏大」卡片，可以建議忽略。
- **H11 可能已過時**：判斷內容現在還有沒有用。偏好、教訓、參考資料有長期價值 → 忽略卡片；只記錄當時進度、已完成的一次性任務、已不存在的環境 → 封存（`engram inbox apply <id> --yes`，可以從歷史還原）。不確定就列為「請你決定」。
- **H12 frontmatter 有誤或不完整**：只修 frontmatter（YAML 格式、補上 `name`＝檔名、一句話的 `description`、`metadata.type`），內文一字不改，用 `engram memory write` 寫回。
- **H13 疑似金鑰**：你看不到金鑰本身，也**不要**用 Read、cat 或任何方式讀原始檔案。向使用者說明是哪一筆記憶、第幾行，請使用者先把金鑰存到安全的地方（例如 Windows 認證管理員、密碼管理工具），同意後執行 `engram inbox apply <id> --yes`，在這台電腦本機遮蔽。使用者說那不是金鑰時，請他到管理介面（`engram ui`）的收件匣按「這不是金鑰」。
- **衝突（cf_ 開頭）與 H15**：比對「這台的版本」「對方的版本」與共同的舊版本，弄清楚兩邊各改了什麼。
  - 兩邊各自新增了不同的事實 → 寫出合併版，`--choice manual`。說法互相矛盾時以日期較新的為準，並在內文註明。
  - 一邊已經包含另一邊的全部內容 → `--choice ours` 或 `--choice theirs`。
  - 其實是兩件不同的事 → `--choice both`（對方的版本另存一筆）。
  - 一邊刪除、一邊修改 → 問使用者要保留還是接受刪除。
- **H16 核心準則過長**、**H01 專案索引過長**：屬於整體整理，改用 `/engram:tidy core` 或 `/engram:tidy <pid>` 的流程（可以在計畫中建議，使用者同意後依那個流程做）。
- **H19 可能屬於另一個資料夾**：讀內容確認它講的確實是另一個資料夾的事，才套用修正。
- **綁定與同步類（H04、H05、H06、H14、H17、H18）**：規則已經判斷好了，照 `engram inbox show` 的說明用白話解釋會發生什麼，使用者同意後 `engram inbox apply <id> --yes`。
  - H06 會改資料夾名稱：那些資料夾不能有開著的 Claude Code 對話（包括目前這個對話所在的資料夾）。有疑慮就建議使用者關掉其他對話，或改到管理介面操作。
  - H18 大量刪除：列出被刪除的記憶，問使用者是不是他要刪的；預設建議還原。

## 指令

```bash
engram inbox                          # 列出（--all 連已忽略、延後的也列出）
engram inbox show <id> [<id> ...]     # 完整內容、可用的修正、相關記憶（附版本）
engram inbox apply <id> --yes         # 套用卡片上的修正；第二個修正加 --fix 2
engram inbox dismiss <id> [--days 7]  # 忽略；加 --days 是延後
engram inbox resolve <cf_id> --choice ours|theirs|both
engram memory show <ref> [<ref> ...]
engram search <關鍵字>
engram sync
```

需要寫入內容的指令，內容一律用 heredoc 從標準輸入傳入，並帶上讀取時的版本：

```bash
# 改寫一筆記憶（整份內容，含 frontmatter）
engram memory write <ref> --base <版本> <<'EOF'
---
name: <與檔名相同>
description: <一句話>
metadata:
  type: <user|feedback|project|reference>
---

<內文>
EOF

# 合併（--into 是要保留的那一筆；--base 依 ref 的順序給各筆版本，逗號分隔）
engram memory merge <ref1> <ref2> --into <ref1> --base <版本1>,<版本2> <<'EOF'
<合併後的整份內容；只給內文時沿用 --into 那一筆的 frontmatter>
EOF

# 衝突手動合併（整份內容，含 frontmatter）
engram inbox resolve <cf_id> --choice manual <<'EOF'
<合併後的整份內容>
EOF
```

改寫或合併時，保留原本 frontmatter 的其他欄位（例如 `metadata.originSessionId`、`metadata.engram`），只改需要改的部分。

## 原則

- 寫入前一定要使用者同意；計畫以外的事不要順手做。
- 一律透過 `engram` 指令讀寫，不要用 Read、Write、Edit 直接碰 `~/.engram/vault`：指令的輸出會遮蔽金鑰，寫入後索引與同步才會正確。
- 遇到 `E_CONFLICT`（讀取之後被改過）：重新 `show`，用最新內容重新判斷，再問一次使用者。
- 遇到 `E_CONFIRM`：表示這個動作需要使用者同意；已經同意才加 `--yes` 重試。
- Engram 回報 `E_SECRET`（內容疑似含有金鑰）時，不要換別的方式或寫到別的地方，也不要自己判斷那不是金鑰：向使用者說明是哪一筆、哪一行，建議改成只記「存放在哪裡、怎麼取得」。使用者表示那不是金鑰時，請使用者**自己**在終端機（不是 Claude Code 的對話）執行 `engram not-secret --value <那個值>`（既有檔案裡的用 `engram not-secret <ref> --line <行號>`），或在管理介面按「這不是金鑰」；你不能代為執行，在 Claude Code 裡執行會被拒絕。使用者完成後再執行原本的指令。
- 記憶內文維持原本的語言與寫法；日期一律寫絕對日期（例如 2026-10-23）。
- 「忽略」只是不再提醒，不改內容；之後 `engram doctor` 仍會列出。
