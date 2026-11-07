**繁體中文** · [English](#security-policy)

# 安全政策

## 回報安全問題

發現可能的安全漏洞時，**請不要開公開的 Issue**。請到本儲存庫的 **Security → Report a vulnerability**，用 GitHub 的私人漏洞回報功能告訴我們，內容請包含：

- 受影響的版本（`engram version` 的輸出）
- 重現步驟
- 可能造成的影響

我們會盡快確認並回覆，修正後在[更新紀錄](CHANGELOG.md)註明。回報時請只使用合成資料，不要附上真實的記憶內容或金鑰。

## 支援的版本

| 版本 | 安全性更新 |
| --- | --- |
| 1.5.x | 支援 |
| < 1.5 | 不支援（請更新到最新版） |

## Engram 如何處理你的資料

| 項目 | 做法 |
| --- | --- |
| 資料存放 | 只在你的電腦（`%USERPROFILE%\.engram\`）與你自己指定的 git 遠端（預設是你帳號底下的私人 repo `engram-vault`）。Engram 沒有伺服器，不蒐集任何資料或使用統計 |
| 同步內容 | 記憶檔、索引、核心準則與 Engram 的設定，以及每台電腦每筆記憶近 90 天的讀取次數（不含對話內容）、你確認過哪些內容的版本雜湊。對話紀錄（transcript）不會同步 |
| 對話紀錄 | 只在這台電腦讀：計算讀取統計，以及你輸入 `/engram:dream` 時轉成精簡文字（疑似金鑰先遮蔽）放在 `~/.engram/local/dream/`，整理記錄建立後就刪除，中途沒完成的 14 天後自動清除。為了讓分析用的子代理讀取時不跳出詢問，這個資料夾會加進 Claude Code 的 `permissions.additionalDirectories`（記在安裝紀錄，解除安裝時移除） |
| 疑似金鑰 | 每次存檔與同步前掃描。含疑似金鑰的檔案只留在本機、不會推送，並在收件匣提醒你遮蔽；寫入 API 也拒絕帶進新的疑似金鑰 |
| AI 呼叫 | 日常運作不呼叫 AI。只有 Claude Code 改版時的相容性探測（只用合成資料、可關閉），以及你主動輸入 `/engram:` 開頭的指令時，才會使用你的 Claude 額度（記憶面板與讀取統計只在本機計算，不用額度）；交給 Claude 前，偵測到的金鑰會先在本機遮蔽 |
| 每次都會載入的內容 | 全域記憶、單機記憶與核心準則在每次對話都會被讀到。Claude 自己寫入這些內容時（例如被對話中夾帶的指示誘導），收件匣會請你確認或退回；對話回顧的提示詞也要求把對話內容當成資料，不照裡面的指示做。`/engram:save` 寫入時帶的 `--reviewed` 表示 Claude 轉達你已經看過全文並同意，這是流程上的約定，Engram 無法從技術上驗證；Claude Code 的權限詢問（執行指令前請你同意）是另一道把關 |
| 記憶整理的記錄 | Claude 的建議（含修改後的內容；對話回顧的記錄還包含對話原文引句，已遮蔽疑似金鑰）與你的決定只存在這台電腦的 `~/.engram/local/tidy/`，不會同步，90 天後自動清除；執行前的備份放在 `~/.engram/local/backups/` |
| 管理介面 | 只監聽本機 `127.0.0.1:4777`，以隨機權杖保護 API，不對外開放 |
| 改動範圍 | 安裝前列出所有會改動的位置並取得同意；每一項都記錄在安裝紀錄，`engram uninstall` 依紀錄逐項還原 |

金鑰偵測涵蓋常見格式，但無法保證涵蓋所有寫法。請不要刻意把密碼、權杖、連線字串寫進記憶，改記「存放在哪裡、怎麼取得」。

---

[繁體中文](#安全政策) · **English**

# Security policy

## Reporting a security issue

If you find a possible security vulnerability, **please don't open a public issue**. Go to **Security → Report a vulnerability** in this repository and tell us through GitHub's private vulnerability reporting. Please include:

- The affected version (the output of `engram version`)
- Steps to reproduce
- The possible impact

We'll confirm and reply as soon as we can, and note the fix in the [changelog](CHANGELOG.md) (in Traditional Chinese) once it's fixed. When you report, please use synthetic data only, and don't attach real memory contents or secrets.

## Supported versions

| Version | Security updates |
| --- | --- |
| 1.5.x | Supported |
| < 1.5 | Not supported (please update to the latest version) |

## How Engram handles your data

| Topic | What Engram does |
| --- | --- |
| Data storage | Only on your computer (`%USERPROFILE%\.engram\`) and the git remote you choose (by default a private repo named `engram-vault` under your account). Engram has no server and collects no data or usage statistics |
| What gets synced | Memory files, indexes, the core rules, and Engram's settings, plus each computer's read counts for each memory over the last 90 days (no conversation content) and hashes of the content versions you've reviewed. Conversation transcripts are never synced |
| Conversation transcripts | Read only on this computer: to calculate read statistics and, when you type `/engram:dream`, to turn them into compact text (possible secrets masked first) stored in `~/.engram/local/dream/`, deleted as soon as the tidy-up record is created (or after 14 days if the run is never finished). So the analysis subagents can read it without a prompt, this folder is added to Claude Code's `permissions.additionalDirectories` (recorded in the installation record and removed on uninstall) |
| Possible secrets | Scanned before every save and sync. A file containing a possible secret stays on your computer and is never pushed, and the inbox reminds you to redact it; the write API also refuses to take in new possible secrets |
| AI calls | None in day-to-day operation. Your Claude quota is used only for the compatibility probe when Claude Code is updated (synthetic data only, and it can be turned off) and when you type an `/engram:` command yourself (the memory pane and read statistics are computed locally and use no quota); before anything is handed to Claude, detected secrets are redacted on your computer |
| What loads in every conversation | Global memories, machine memories, and the core rules are read in every conversation. When Claude writes to them on its own (for example, because instructions slipped into a conversation nudged it to), the inbox asks you to confirm or go back; the conversation review prompt also tells Claude to treat conversation content as data and not follow instructions in it. The `--reviewed` option that `/engram:save` uses means Claude is passing on that you read the full text and agreed; it's an agreed procedure that Engram can't verify technically. Claude Code's permission prompt (asking you before a command runs) is a separate safeguard |
| Tidy-up records | Claude's suggestions (including revised content; conversation review records also include quotes from your conversations, with possible secrets masked) and your decisions are stored only on this computer in `~/.engram/local/tidy/`, are not synced, and are cleared after 90 days; the backup made before a tidy-up runs goes to `~/.engram/local/backups/` |
| Dashboard | Listens only on `127.0.0.1:4777` on your computer, protects its API with a random token, and is not exposed externally |
| Scope of changes | Before installing, Engram lists every location it will change and gets your approval; each one is recorded in the installation record, and `engram uninstall` reverts them one by one from that record |

Secret detection covers common formats but can't promise to catch every way of writing one. Please don't deliberately write passwords, tokens, or connection strings into memories; record where they're stored and how to get them instead.
