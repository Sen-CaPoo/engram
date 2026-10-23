<!-- Engram 核心準則 · schema 1 · 產生於 {{generated_at}} · Engram {{engram_version}}
     這份檔案在所有電腦之間同步。可以在 Engram 介面編輯，也可以直接編輯本檔。
     engram:environments 區塊由 Engram 維護，其餘內容都屬於使用者。 -->
# 核心準則（{{user_name}}）

每次對話都會載入這份準則，所有專案、所有電腦共用。專案自己的 CLAUDE.md 與這份衝突時，以專案的為準。

## 1. 使用者與工作環境

{{user_profile}}

工作環境（以下電腦共用同一套記憶）：
<!-- engram:environments:begin -->
{{environments}}
<!-- engram:environments:end -->

這次對話在哪台電腦、哪個專案，以對話開頭的「[Engram]」動態內容為準。

## 2. 溝通

- 回覆、說明與文件一律使用{{language}}；技術名詞與程式識別字保留原文。
{{communication_extra}}
{{optional_user_guidelines}}

## 3. 記憶寫入協定

### 寫到哪個範圍
- **專案**（預設）：照平常方式寫進自動記憶資料夾。適用於這個專案的決策、慣例、進度、踩過的坑。
- **全域**：所有專案都成立的事，例如使用者偏好、跨專案通用的工具經驗。
- **單機**：只在這台電腦成立的事，例如安裝路徑、網路設定、磁碟狀況、本機工具版本。若同時只跟某個專案有關，加上 `--project <pid>`。
- 判斷不了就寫專案範圍，Engram 會在收件匣建議搬移。

### 全域與單機記憶怎麼寫
1. 首選：用 Bash 執行 `engram remember`，內文從標準輸入傳入：

```bash
engram remember --scope global --name <slug> --type <user|feedback|project|reference> \
  --description "<一句話說明>" <<'EOF'
<內文>
EOF
```

   單機記憶改用 `--scope machine`（需要時加 `--project <pid>`）。
2. 指令無法使用時，若權限允許，直接寫入 `~/.engram/vault/global/<slug>.md` 或 `~/.engram/vault/machines/<mid>/<slug>.md`（`<mid>` 見動態內容）。
3. 兩者都失敗：照平常寫成專案記憶，並在內文第一行註明「建議範圍：全域」或「建議範圍：單機」。

寫入全域或單機記憶後，在回覆中告訴使用者寫進了哪個範圍、記憶名稱是什麼。專案記憶不必特別說明，Claude Code 介面本身就會顯示。

### 每一筆記憶
- 先查再寫：看已載入的索引，或執行 `engram search <關鍵字>`。已有相近的記憶就更新那一筆，不要新增重複的。
- 一個檔案只記一件事；`name` 與檔名相同，用 kebab-case 英數。
- frontmatter 照官方格式（`name`、`description`、`metadata.type`）；自訂欄位只能放在 `metadata.engram` 底下。
- 一律寫絕對日期（例如 2026-10-22），不寫「昨天」「下週」。
- feedback 與 project 類型，內文之後加上 `**Why:**` 與 `**How to apply:**` 兩行。
- 相關的記憶用 `[[name]]` 互相連結。

### 不要寫
- 從程式碼或 git 歷史就看得出來的事、只跟這次任務有關的暫時狀態、CLAUDE.md 已經寫過的內容。
- 密鑰的值（token、密碼、連線字串、私鑰）：改記「存放在哪裡、怎麼取得」。原因不是隱私，而是記憶庫會同步到 GitHub：含密鑰的檔案會被 Engram 擋下、不會同步，也會觸發 GitHub 的推送保護。

### 索引
- `MEMORY.md` 照平常方式維護，Engram 會在對話結束後整理。
- 不要修改任何 `INDEX.md`，它們由 Engram 產生；寫入全域或單機記憶後也不必自己更新。

## 4. Engram 指令

可以直接在 Bash 執行：
- `engram search <關鍵字>`：搜尋所有範圍的記憶，中英文皆可。
- `engram status`：查看這台電腦、目前專案的綁定與同步狀態。
- `engram remember …`：寫入全域或單機記憶（見第 3 節）。

收件匣裡的待整理事項，除非使用者問起，否則不要主動提。

## 5. 全域記憶索引

{{global_index_import}}
