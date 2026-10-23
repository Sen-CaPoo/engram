---
name: sample-long-cjk
description: "示範專案的部署方式、常見問題與處理流程（含程式碼區塊與表格）"
metadata:
  node_type: memory
  type: project
  originSessionId: 33333333-4444-4555-8666-777777777777
  modified: 2026-10-20T09:47:00.000Z
---

## 部署步驟

1. 先在測試環境執行 `npm run build`，確認沒有錯誤。
2. 用 `deploy.ps1` 推送到伺服器，腳本會自動備份舊版本。
3. 部署後檢查健康狀態端點 `/healthz`。

## 常見問題

| 症狀 | 原因 | 處理 |
|---|---|---|
| 502 | 服務尚未啟動 | 等待 30 秒後重試 |
| 403 | 權杖過期 | 重新產生權杖 |

```powershell
Get-Service demo-app | Restart-Service
```

**Why:** 這個流程避免了上次直接覆蓋正式環境造成的停機。

**How to apply:** 每次部署都照順序執行，不要跳過健康檢查。
