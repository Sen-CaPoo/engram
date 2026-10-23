---
name: sample-engram-meta
description: "示範：metadata.engram 區塊在 Claude Code 改寫後的樣子（逐行列表、巢狀物件）"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 22222222-3333-4444-8555-666666666666
  modified: 2026-10-22T01:30:00.000Z
  engram:
    pinned: true
    tags:
      - windows
      - powershell
    project: demo-app-3fa9k
    reviewedAt: 2026-10-22
---

含中文的 .ps1 一律以 UTF-8 with BOM 存檔。

**Why:** Windows PowerShell 5.1 沒有 BOM 時以系統字碼頁讀取。

**How to apply:** 用 Write 工具寫 .ps1 後，以 node 補上 BOM。
