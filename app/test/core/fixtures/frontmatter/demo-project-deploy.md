---
name: demo-project-deploy
description: "Demo app deployed 2026-10-01 to C:\\Users\\Someone\\Projects\\demo-app, staging mode; port/allowlist caveats"
metadata:
  node_type: memory
  type: project
  originSessionId: 11111111-2222-4333-8444-555555555555
  modified: 2026-10-01T08:15:30.125Z
---

Deployed demo-app v1.2.3 on 2026-10-01 at C:\Users\Someone\Projects\demo-app (venv in `.venv`), runtime binaries in C:\Users\Someone\Projects\demo-app\runtime.

**Why:** The staging profile mirrors production settings, so problems show up before release.

**How to apply:** Use the staging profile when testing deployments. Always confirm the target port before restarting the service.
