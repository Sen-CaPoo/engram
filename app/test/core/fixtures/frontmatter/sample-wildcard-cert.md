---
name: sample-wildcard-cert
description: "*.example.test Let's Encrypt 萬用憑證（給另一台伺服器用）的簽發方式、位置與到期日"
metadata:
  node_type: memory
  type: project
  originSessionId: 9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a
  modified: 2026-10-16T08:03:21.225Z
---

2026-10-16 用 DNS-01 簽了 `*.example.test`（RSA2048，**2027-01-14 到期**），只含萬用、不含裸網域。
輸出在 `C:\Users\Someone\Desktop\example-cert\`：`wildcard.example.test.pfx` ＋ `pfx-password.txt`。

決策：伺服器由使用者**直連**（不經代理），所以用公開信任的憑證。
