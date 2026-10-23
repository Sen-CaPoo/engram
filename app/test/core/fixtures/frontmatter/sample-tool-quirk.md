---
name: sample-tool-quirk
description: 範例工具採 A 版＋純 Skill 整合；同名的 B 版外掛是不同產品，已於 2026-09-06 移除，勿再安裝
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f3fb9d72-28f3-44d6-b0aa-d559879077d9
  modified: 2026-09-06T05:04:24.414Z
---

本機文件處理一律使用 **範例工具 A 版**：執行檔位於 `C:\Users\Someone\AppData\Local\SampleTool\sample.exe`（PATH 已含）。

**Why:** B 版會常駐佔用 context，而且功能重疊。

**How to apply:** 遇到文件處理需求時直接呼叫 A 版 CLI，不要安裝 B 版外掛。
