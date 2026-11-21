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
| 2.0.x | 支援 |
| < 2.0 | 不支援（1.6.x 與更早的版本不再提供安全性更新；升級是免費的，請更新到 2.0.x） |

## Engram 如何處理你的資料

| 項目 | 做法 |
| --- | --- |
| 資料存放 | 只在你的電腦（`%USERPROFILE%\.engram\`）與你自己指定的 git 遠端（預設是你帳號底下的私人 repo `engram-vault`）。Engram 沒有伺服器，不蒐集任何資料或使用統計 |
| 同步內容 | 記憶檔、索引、核心準則與 Engram 的設定，以及每台電腦每筆記憶近 90 天的讀取次數（不含對話內容）、你確認過哪些內容的版本雜湊。2.0 起還有：環境指紋（名稱、版本、雜湊，以及每個 hook 的指令開頭、哪些外掛啟用、對話紀錄的保留天數；沒有其他設定值，也沒有環境變數的值）、共用的環境設定檔與自製技能、護欄規則、沒有對話內容的保留區項目、自動更新用的發佈資訊。對話紀錄（transcript）、對話回顧產生的保留區項目、你糾正 Claude 的原話與各種命中紀錄不會同步 |
| 對話紀錄 | 只在這台電腦讀：計算讀取統計，以及你輸入 `/engram:dream` 時轉成精簡文字（疑似金鑰先遮蔽）放在 `~/.engram/local/dream/`，整理記錄建立後就刪除，中途沒完成的 14 天後自動清除。為了讓分析用的子代理讀取時不跳出詢問，這個資料夾會加進 Claude Code 的 `permissions.additionalDirectories`（記在安裝紀錄，解除安裝時移除） |
| 疑似金鑰 | 每次存檔與同步前掃描。含疑似金鑰的檔案只留在本機、不會推送，並在收件匣提醒你遮蔽；寫入 API 也拒絕帶進新的疑似金鑰 |
| AI 呼叫 | 日常運作不呼叫 AI。只有 Claude Code 改版時的相容性探測（只用合成資料、可關閉）、你主動輸入 `/engram:` 開頭的指令時，以及你開啟自動駕駛時（預設關閉），才會使用你的 Claude 額度（記憶面板、讀取統計、情境召回、護欄與環境健檢只在本機計算，不用額度）；交給 Claude 前，偵測到的金鑰會先在本機遮蔽 |
| 每次都會載入的內容 | 全域記憶、單機記憶與核心準則在每次對話都會被讀到。Claude 自己寫入這些內容時（例如被對話中夾帶的指示誘導），收件匣會請你確認或退回；對話回顧的提示詞也要求把對話內容當成資料，不照裡面的指示做。`/engram:save` 寫入時帶的 `--reviewed` 表示 Claude 轉達你已經看過全文並同意，這是流程上的約定，Engram 無法驗證 Claude 是不是真的列出全文、取得你的同意，所以 2.0 起在 Claude Code 對話裡執行的寫入（包含 `/engram:save`、`/engram:tidy-apply`、`/engram:inbox` 處理衝突，以及 `engram holding adopt`、`engram import apply`）記成「Claude 代為確認」，不會被自動駕駛當成你的偏好（只有你在管理介面，或在你自己開的終端機、不是 Claude Code 對話裡確認過的才算）。兩個例外：不改變內容意思的修改（改連結、更新驗證日期）沿用原本的確認；在對話裡採用會改到核心準則的保留區項目，不記確認，核心準則留在「待你確認」等你看過；Claude Code 的權限詢問（執行指令前請你同意）是另一道把關 |
| 環境設定同步 | 預設只報告，不會自動改你的設定。從記憶庫同步來的環境設定、技能與護欄的「擋下」規則，要在這台電腦由你核可才會生效；核可只能在管理介面或你自己的終端機做，在 Claude Code 的對話裡執行會被拒絕。statusLine、hooks、權限，以及名稱像金鑰或會改變執行環境的環境變數，一律不同步；套用前先備份、可以還原 |
| 自動更新 | 預設開啟。只從你安裝時的 git 儲存庫取得帶版本標籤的更新，只接受快轉；更新前備份、更新後驗證，失敗自動退回並通知你。用 ZIP 安裝的電腦不會自動更新，可以在設定頁關閉 |
| 記憶整理的記錄 | Claude 的建議（含修改後的內容；對話回顧的記錄還包含對話原文引句，已遮蔽疑似金鑰）與你的決定只存在這台電腦的 `~/.engram/local/tidy/`，不會同步，90 天後自動清除；執行前的備份放在 `~/.engram/local/backups/` |
| 管理介面 | 只監聽本機 `127.0.0.1:4777`，以隨機權杖保護 API，不對外開放 |
| 改動範圍 | 安裝前列出所有會改動的位置並取得同意；每一項都記錄在安裝紀錄，`engram uninstall` 依紀錄逐項還原 |

金鑰偵測涵蓋常見格式，但無法保證涵蓋所有寫法。請不要刻意把密碼、權杖、連線字串寫進記憶，改記「存放在哪裡、怎麼取得」。

## 這些把關的範圍與已知限制

- **「Claude 代為確認」與核可的拒絕，防的是照著指令做事的 Claude。** Engram 用環境判斷指令是不是在 Claude Code 的對話裡執行。以你的身分在這台電腦執行的程式，本來就能直接修改記憶庫的檔案，也讀得到管理介面的權杖；刻意繞過這些判斷的程式不在防護範圍內。Claude Code 的權限詢問是這一類行為的把關。
- **記憶庫的內容就是 Claude 會讀到的內容。** 能寫入你的記憶庫的人（取得你的 GitHub 帳號，或你的任何一台電腦），可以改變 Claude 讀到的記憶，也可以偽造「你確認過」的紀錄，因為確認紀錄跟著記憶庫同步。請替 GitHub 帳號開啟兩步驟驗證，記憶庫的 repo 保持私人。
- **會執行程式或改變環境的東西另外把關。** 環境設定、技能與護欄「擋下」規則的核可只存在每台電腦本機，不會同步，所以同步來的內容無法替自己核可。
- **還有電腦停在 1.x 的期間。** 舊版不認得 2.0 新增的檔案（共用設定、環境設定檔、護欄規則、保留區項目），也不會替它們檢查疑似金鑰。請不要在舊版的電腦上手動編輯這些檔案，並盡快把每台電腦更新到 2.0.x。

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
| 2.0.x | Supported |
| < 2.0 | Not supported (1.6.x and earlier no longer get security updates; upgrading is free, so please update to 2.0.x) |

## How Engram handles your data

| Topic | What Engram does |
| --- | --- |
| Data storage | Only on your computer (`%USERPROFILE%\.engram\`) and the git remote you choose (by default a private repo named `engram-vault` under your account). Engram has no server and collects no data or usage statistics |
| What gets synced | Memory files, indexes, the core rules, and Engram's settings, plus each computer's read counts for each memory over the last 90 days (no conversation content) and hashes of the content versions you've reviewed. Since 2.0 also: environment fingerprints (names, versions, and hashes, plus the start of each hook command, which plugins are enabled, and the transcript retention days; no other setting values and no environment variable values), the shared environment profile and custom skills, guardrail rules, holding-area items that contain no conversation content, and the release information used by automatic updates. Conversation transcripts, holding-area items produced by conversation review, the words you used to correct Claude, and the various hit records are never synced |
| Conversation transcripts | Read only on this computer: to calculate read statistics and, when you type `/engram:dream`, to turn them into compact text (possible secrets masked first) stored in `~/.engram/local/dream/`, deleted as soon as the tidy-up record is created (or after 14 days if the run is never finished). So the analysis subagents can read it without a prompt, this folder is added to Claude Code's `permissions.additionalDirectories` (recorded in the installation record and removed on uninstall) |
| Possible secrets | Scanned before every save and sync. A file containing a possible secret stays on your computer and is never pushed, and the inbox reminds you to redact it; the write API also refuses to take in new possible secrets |
| AI calls | None in day-to-day operation. Your Claude quota is used only for the compatibility probe when Claude Code is updated (synthetic data only, and it can be turned off), when you type an `/engram:` command yourself, and when you turn on autopilot (off by default). The memory pane, read statistics, context recall, guardrails, and the environment check are computed locally and use no quota; before anything is handed to Claude, detected secrets are redacted on your computer |
| What loads in every conversation | Global memories, machine memories, and the core rules are read in every conversation. When Claude writes to them on its own (for example, because instructions slipped into a conversation nudged it to), the inbox asks you to confirm or go back; the conversation review prompt also tells Claude to treat conversation content as data and not follow instructions in it. The `--reviewed` option that `/engram:save` uses means Claude is passing on that you read the full text and agreed; it's an agreed procedure, and Engram can't verify that Claude really showed the full text and got your agreement, so since 2.0 writes made inside a Claude Code conversation (including `/engram:save`, `/engram:tidy-apply`, handling conflicts with `/engram:inbox`, and `engram holding adopt` and `engram import apply`) are recorded as "confirmed on your behalf by Claude", and autopilot doesn't treat them as your preferences (only what you confirmed in the dashboard, or in a terminal you opened yourself rather than a Claude Code conversation, counts). Two exceptions: edits that don't change what the content means (fixing a link, updating a verified date) keep the confirmation the content already had; and adopting a holding-area item that changes the core rules from inside a conversation records no confirmation at all, so the core rules stay under "Confirmations" in the inbox until you look. Claude Code's permission prompt (asking you before a command runs) is a separate safeguard |
| Environment sync | Report only by default; it never changes your settings on its own. Environment settings, skills, and "block" guardrail rules that synced from the vault take effect only after you approve them on this computer; approval works only in the dashboard or in your own terminal, and is refused when run inside a Claude Code conversation. `statusLine`, hooks, permissions, and environment variables whose names look like secrets or that change the runtime environment are never synced; changes are backed up first and can be undone |
| Automatic updates | On by default. It fetches only updates carrying a version tag from the git repository you installed from, accepts only fast-forwards, backs up before updating and verifies afterwards, and rolls back and notifies you on failure. Computers installed from a ZIP don't update automatically, and you can turn it off in Settings |
| Tidy-up records | Claude's suggestions (including revised content; conversation review records also include quotes from your conversations, with possible secrets masked) and your decisions are stored only on this computer in `~/.engram/local/tidy/`, are not synced, and are cleared after 90 days; the backup made before a tidy-up runs goes to `~/.engram/local/backups/` |
| Dashboard | Listens only on `127.0.0.1:4777` on your computer, protects its API with a random token, and is not exposed externally |
| Scope of changes | Before installing, Engram lists every location it will change and gets your approval; each one is recorded in the installation record, and `engram uninstall` reverts them one by one from that record |

Secret detection covers common formats but can't promise to catch every way of writing one. Please don't deliberately write passwords, tokens, or connection strings into memories; record where they're stored and how to get them instead.

## What these safeguards cover, and known limits

- **"Confirmed on your behalf by Claude" and refused approvals guard against a Claude that is following instructions.** Engram checks the environment to tell whether a command runs inside a Claude Code conversation. A program running as you on this computer can already edit the vault's files directly and can read the dashboard's token, so a program that deliberately works around these checks is out of scope. Claude Code's permission prompt is the safeguard for that kind of behavior.
- **What is in the vault is what Claude reads.** Anyone who can write to your vault (by getting into your GitHub account or any one of your computers) can change the memories Claude reads, and can also forge "you confirmed this" records, because those records sync with the vault. Turn on two-factor authentication for your GitHub account and keep the vault repository private.
- **Anything that runs code or changes the environment is guarded separately.** Approvals for environment settings, skills, and "block" guardrail rules are stored only on each computer and never sync, so content that syncs in cannot approve itself.
- **While a computer is still on 1.x.** The old version doesn't know the files 2.0 adds (shared settings, the environment profile, guardrail rules, holding-area items) and doesn't scan them for possible secrets. Don't hand-edit those files on a computer running the old version, and update every computer to 2.0.x as soon as you can.
