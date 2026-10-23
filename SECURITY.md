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
| 1.2.x | 支援 |
| < 1.2 | 不支援（請更新到最新版） |

## Engram 如何處理你的資料

| 項目 | 做法 |
| --- | --- |
| 資料存放 | 只在你的電腦（`%USERPROFILE%\.engram\`）與你自己指定的 git 遠端（預設是你帳號底下的私人 repo `engram-vault`）。Engram 沒有伺服器，不蒐集任何資料或使用統計 |
| 同步內容 | 記憶檔、索引、核心準則與 Engram 的設定。對話紀錄（transcript）不會同步 |
| 疑似金鑰 | 每次存檔與同步前掃描。含疑似金鑰的檔案只留在本機、不會推送，並在收件匣提醒你遮蔽；寫入 API 也拒絕帶進新的疑似金鑰 |
| AI 呼叫 | 日常運作不呼叫 AI。只有 Claude Code 改版時的相容性探測（只用合成資料、可關閉），以及你主動輸入 `/engram:` 開頭的指令時，才會使用你的 Claude 額度（記憶面板只在本機讀取，不用額度）；交給 Claude 前，偵測到的金鑰會先在本機遮蔽 |
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
| 1.2.x | Supported |
| < 1.2 | Not supported (please update to the latest version) |

## How Engram handles your data

| Topic | What Engram does |
| --- | --- |
| Data storage | Only on your computer (`%USERPROFILE%\.engram\`) and the git remote you choose (by default a private repo named `engram-vault` under your account). Engram has no server and collects no data or usage statistics |
| What gets synced | Memory files, indexes, the core rules, and Engram's settings. Conversation transcripts are never synced |
| Possible secrets | Scanned before every save and sync. A file containing a possible secret stays on your computer and is never pushed, and the inbox reminds you to redact it; the write API also refuses to take in new possible secrets |
| AI calls | None in day-to-day operation. Your Claude quota is used only for the compatibility probe when Claude Code is updated (synthetic data only, and it can be turned off) and when you type an `/engram:` command yourself (the memory pane reads files locally and uses no quota); before anything is handed to Claude, detected secrets are redacted on your computer |
| Dashboard | Listens only on `127.0.0.1:4777` on your computer, protects its API with a random token, and is not exposed externally |
| Scope of changes | Before installing, Engram lists every location it will change and gets your approval; each one is recorded in the installation record, and `engram uninstall` reverts them one by one from that record |

Secret detection covers common formats but can't promise to catch every way of writing one. Please don't deliberately write passwords, tokens, or connection strings into memories; record where they're stored and how to get them instead.
