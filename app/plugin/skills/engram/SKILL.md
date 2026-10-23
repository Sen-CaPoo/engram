---
name: engram
description: 使用 Engram 憶跡管理跨電腦同步的記憶。要寫入「全域」或「單機」記憶、查詢其他專案的記憶、或確認目前專案的綁定與同步狀態時使用；指令為 engram remember、engram search、engram status。
---

# Engram 記憶指令

Engram 把 Claude Code 的記憶存在 `~/.engram/vault`（git），在使用者的多台電腦之間同步。`engram` 指令可以直接在 Bash 執行。寫入內容一律用 Bash 的 heredoc 傳入。只有 PowerShell 工具、沒有 Bash 時，不要用 PowerShell 的管線傳內容（Windows PowerShell 5.1 會把中文變成問號）：先用 Write 工具把內文寫成 `~/.engram/local/drafts/<名稱>.md`，再在指令加上 `--file <那個檔案>`。

## 寫到哪個範圍

- **專案**（預設）：照平常方式寫進自動記憶資料夾，不需要 `engram`。
- **全域**：所有專案都成立的事（使用者偏好、跨專案的工具經驗）→ `engram remember --scope global`
- **單機**：只在這台電腦成立的事（安裝路徑、網路設定、本機工具版本）→ `engram remember --scope machine`；只跟某個專案有關時加 `--project <pid>`（pid 見對話開頭的 [Engram] 動態內容或 `engram status`）。

全域與單機記憶一律用 `engram remember` 寫入，不要用 Write 直接寫 vault（預設權限模式會被拒絕）。

## engram remember

先查再寫：先執行 `engram search <關鍵字>`，已有相近的記憶就更新那一筆，不要新增重複的。

```bash
engram remember --scope global --name <kebab-case-英數名稱> --type <user|feedback|project|reference> \
  --description "<一句話說明>" <<'EOF'
<內文>
EOF
```

- `--name` 用 kebab-case 英數，同時是檔名。一個檔案只記一件事。
- feedback 與 project 類型，內文之後加上 `**Why:**` 與 `**How to apply:**` 兩行。
- 一律寫絕對日期（例如 2026-10-22）。
- 不要寫入密鑰的值（token、密碼、連線字串）；改記「存放在哪裡、怎麼取得」。內容疑似含有金鑰時 Engram 會拒絕（`E_SECRET`）：向使用者說明，不要改寫到別的地方；使用者表示那不是金鑰時，請使用者自己在終端機執行 `engram not-secret --value <那個值>`（在 Claude Code 裡執行會被拒絕），或在管理介面按「這不是金鑰」，完成後再重試。
- 成功時會印出一行「已記住：…」。寫完後告訴使用者寫進了哪個範圍、記憶名稱是什麼。
- 指令失敗時，改寫成專案記憶，並在內文第一行註明「建議範圍：全域」或「建議範圍：單機」。

## engram search

`engram search <關鍵字>` 搜尋所有範圍（全域、各專案、單機）的記憶，中英文皆可。結果附檔案完整路徑，需要細節時用 Read 讀取。適合用來找其他專案累積的經驗。

## engram status

`engram status` 顯示這台電腦、目前資料夾的綁定與同步狀態。使用者問「記憶有沒有同步」「這個專案有沒有接上 Engram」時使用。

## 讀其他範圍的記憶

`engram memory show <ref> [<ref> ...]` 讀出記憶全文（疑似金鑰已在本機遮蔽），ref 見 `engram search` 或 `engram memory list` 的結果。讀其他專案、全域或單機的記憶時用它，不必用 Read 開 vault 裡的檔案。

## 整理記憶的流程

使用者要整理記憶時，依對應技能的流程做（每個流程都是先提出計畫、使用者同意後才寫入）：

- 整理收件匣 → `/engram:inbox`
- 整理專案、全域、單機記憶、核心準則或全部 → `/engram:tidy`：Claude 分析後把建議存成整理記錄，使用者在管理介面逐項決定，再貼上 `/engram:tidy-apply <id>` 執行
- 把對話重點存成記憶 → `/engram:save`
- 從其他專案、其他電腦找經驗 → `/engram:recall`

## 不要做的事

- 不要修改任何 `INDEX.md`，它們由 Engram 產生。
- 收件匣的待整理事項，除非使用者問起，否則不要主動提。
- 不要在使用者沒有同意的情況下改寫、合併、移動或封存既有的記憶。
- 加上 `--json` 可取得機器可讀的輸出；一般情況直接讀中文輸出即可。
