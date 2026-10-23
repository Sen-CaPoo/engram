# AI 幫你快速安裝 Engram

<p align="center">
  <img src="docs/assets/illustrations/install-with-ai.webp" alt="三個步驟：1 複製一段話、2 貼給 Claude Code、3 完成，記憶開始同步" width="880">
</p>

> **給使用者**：打開 Claude Code，把下面這段話整段貼上，Claude 就會照這份手冊幫你安裝。全程約 10 分鐘，每個會改動電腦的步驟都會先問過你。
>
> ```text
> 請幫我安裝 Engram（Claude Code 記憶同步工具）。
> 安裝手冊：https://raw.githubusercontent.com/Sen-CaPoo/engram/main/AI%20%E5%B9%AB%E4%BD%A0%E5%BF%AB%E9%80%9F%E5%AE%89%E8%A3%9D.md
> 請先完整讀完手冊再開始，照步驟進行；任何會改動電腦的步驟，都先用白話跟我說明並取得我的同意。
> ```
>
> 你需要準備：Windows 11、已登入的 Claude Code、一個 GitHub 帳號。過程中你只需要回答幾個問題，並在登入 GitHub 時點幾下瀏覽器。
> 想自己動手？請看 [快速開始](docs/快速開始.md)。

---

以下是寫給 AI 助理的安裝手冊。

## 你的任務

替使用者在這台 Windows 電腦安裝 **Engram 憶跡**：它把 Claude Code 的記憶存進使用者自己的 GitHub 私人 repo，在多台電腦之間自動同步。安裝完成的定義：

1. `engram status` 顯示這台電腦的名字與記憶庫位置；
2. `engram doctor` 沒有非預期的 ✗；
3. 使用者知道下一步（匯入舊記憶、開新對話確認、第二台電腦怎麼裝）。

## 執行原則（一定要遵守）

1. **先讀完整份手冊再動手。**
2. **改動前先取得同意。** 安裝工具、下載程式、執行安裝、匯入記憶之前，用白話說明「要做什麼、會改動哪裡、怎麼復原」，等使用者明確回覆同意才執行。只查詢狀態的指令可以直接執行。
3. **登入由使用者本人操作。** GitHub 登入需要瀏覽器互動，請使用者自己完成。不要索取、代為輸入或在畫面上輸出任何密碼與權杖。
4. **遇到錯誤就停下來。** 引用錯誤訊息原文，對照下方「疑難排解」，向使用者說明後再決定下一步。不要用刪除資料夾、`--force`、改系統設定等方式硬繞過。
5. **說人話。** 用使用者的語言（預設正體中文），少用術語；每完成一步，用一句話回報進度。

### 指令寫法

- 以下指令在 **PowerShell 與 Git Bash 都能執行**：`$HOME` 兩邊通用，路徑一律用 `/`。
- 剛用 winget 安裝的工具，這個對話可能還找不到（PATH 尚未更新）。這時改用[附錄 B](#附錄-b工具的完整路徑) 的完整路徑；仍然不行就請使用者重新開啟 Claude Code，再說「繼續安裝 Engram」。
- 下文的 `engram` 在安裝完成前請寫成 `node "$HOME/engram/app/bin/engram.mjs"`；安裝完成後寫成 `node "$HOME/.engram/app/current/bin/engram.mjs"`（新開的終端機也可以直接輸入 `engram`）。

## 步驟 1：檢查環境（只讀，可以直接執行）

```bash
powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).Caption"
claude --version
git --version
node --version
gh --version
gh auth status
winget --version
node "$HOME/.engram/app/current/bin/engram.mjs" status
```

依結果判斷：

| 項目 | 通過條件 | 不通過時 |
| --- | --- | --- |
| 作業系統 | 第一行顯示 Windows 11 | **停止**。Engram 1.0 只支援 Windows 11，請告訴使用者 |
| Claude Code | `claude --version` 有版本號 | **停止**。請使用者先安裝並登入 Claude Code |
| Git | 有版本號 | 步驟 3 安裝 |
| Node.js | `v22` 以上 | 步驟 3 安裝或升級 |
| GitHub CLI | 有版本號 | 步驟 3 安裝 |
| GitHub 登入 | `gh auth status` 顯示 Logged in | 步驟 4 |
| winget | 有版本號 | 見疑難排解「找不到 winget」 |
| 既有安裝 | 最後一行指令**失敗**（代表尚未安裝） | 已經裝過：改走[「已經安裝過」](#已經安裝過更新修復或移除) |

把結果整理成一張表回報使用者。

## 步驟 2：跟使用者確認三件事

一次問完，等使用者回答：

1. **這台電腦叫什麼名字？** 例如「公司電腦」「家裡電腦」「筆電」。會顯示在每台電腦的狀態裡。
2. **記憶要同步到哪裡？**
   - **A（建議）**：你 GitHub 帳號底下的私人 repo `engram-vault`。第一台會自動建立，之後的電腦自動接上。
   - **B**：公司指定的私人 repo。適合公司不允許工作資料放在個人 GitHub 的情況；請管理員先建立一個空的私人 repo，提供網址。
   - **C**：只在這台電腦使用，不同步。

   請順帶提醒：記憶裡可能有客戶或專案細節，先確認公司規定是否允許 A。
3. **Engram 程式要放在哪裡？** 預設 `$HOME/engram`（例如 `C:\Users\你的名字\engram`）。安裝後要保留，之後更新會用到。

## 步驟 3：補齊缺少的工具（需要同意）

只安裝步驟 1 判定缺少的項目：

```bash
winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
winget install --id GitHub.cli -e --source winget --accept-package-agreements --accept-source-agreements
```

Node.js 版本低於 22 時改用 `winget upgrade --id OpenJS.NodeJS.LTS -e --source winget`。安裝後重新執行步驟 1 的對應指令確認（必要時用完整路徑）。

安裝時 Windows 可能跳出「是否允許此應用程式變更你的裝置」（UAC），請先提醒使用者按「是」。

## 步驟 4：登入 GitHub（使用者自己操作）

只有選 A 或 B、而且 `gh auth status` 顯示尚未登入時才需要。請使用者：

1. 另外開一個 PowerShell 視窗；
2. 輸入 `gh auth login --hostname github.com --git-protocol https --web`；
3. 照畫面指示：複製一次性代碼 → 按 Enter 開啟瀏覽器 → 貼上代碼 → 授權；
4. 完成後回到這裡說「好了」。

再執行一次 `gh auth status`，確認顯示 Logged in。

## 步驟 5：取得 Engram 程式（需要同意）

```bash
git clone https://github.com/Sen-CaPoo/engram.git "$HOME/engram"
```

- 資料夾已經存在、而且裡面有 `app/bin/engram.mjs`：改執行 `git -C "$HOME/engram" pull` 取得最新版。
- 資料夾已經存在、但不是 Engram：請使用者換一個位置，不要覆蓋。
- 使用者指定了其他位置：之後所有指令裡的 `$HOME/engram` 都換成那個位置。

## 步驟 6：預覽安裝計畫（不改動任何東西，可以直接執行）

```bash
node "$HOME/engram/app/bin/engram.mjs" install --dry-run --label "<電腦名稱>"
```

依步驟 2 的選擇加上參數：B 加 `--remote <repo 網址>`，C 加 `--local`，A 不用加。

輸出的格式：

- `✗` 開頭的行是**必須先解決的問題**，這時不會列出計畫。依疑難排解處理後重新預覽。
- 「Engram 安裝計畫：」底下的編號清單是會做的事。
- `!` 開頭的行是提醒，不影響安裝。

請：

1. 把計畫逐行翻成白話告訴使用者，可以參考[附錄 A](#附錄-a安裝會改動哪些地方)；
2. 特別說明提醒事項。最常見的是「預設權限模式不是 auto」：意思是從專案根目錄開 Claude Code 完全正常，只有從子資料夾開啟時用不到 Engram 的記憶。**不要自行修改使用者的 Claude Code 設定**，使用者主動要求才協助；
3. 問使用者：「要照這個計畫安裝嗎？」

## 步驟 7：正式安裝（需要明確同意）

```bash
node "$HOME/engram/app/bin/engram.mjs" install --label "<電腦名稱>" --yes
```

參數與步驟 6 相同。`--yes` 只是略過程式內建的「要開始安裝嗎？」詢問，因為你已在步驟 6 取得同意；沒有 `--yes` 又不是互動終端機時，程式印完計畫就會結束。通常約 1 分鐘，但第一次建立 GitHub repo、安裝外掛可能更久，請用較長的逾時執行（例如 5 分鐘）。成功時最後會出現「安裝完成」。

第二台以後的電腦，安裝程式會自動發現 GitHub 上已有 `engram-vault` 並接上，同時下載其他電腦已同步的記憶，不需要額外參數。

## 步驟 8：驗證

```bash
node "$HOME/.engram/app/current/bin/engram.mjs" status
node "$HOME/.engram/app/current/bin/engram.mjs" doctor
```

- `status` 應顯示這台電腦的名字、記憶庫位置與同步狀態。
- `doctor` 逐項檢查記憶庫、GitHub 連線、常駐程式與登入工作，應為 ✓。以下情況的 ✗ 是預期的：
  - 選 C（只在這台電腦）時，「遠端連線：尚未設定遠端」一定是 ✗，`doctor` 的結束碼也會是 1，**不代表安裝失敗**。
  - 「常駐程式：沒有在執行」：執行 `node "$HOME/.engram/app/current/bin/engram.mjs" ui` 即可啟動；之後每次登入 Windows 也會自動啟動。
- 其他 ✗：把那一行原文告訴使用者，對照疑難排解。

## 步驟 9：匯入既有的記憶（建議，需要同意）

如果使用者已經用 Claude Code 一陣子，電腦裡會有舊記憶。先產生計畫（不寫入任何東西）：

```bash
node "$HOME/.engram/app/current/bin/engram.mjs" import plan
```

把結果摘要給使用者：幾個資料夾、幾筆記憶、各有多少會複製、略過（重複或較舊版本）、建議放全域或單機。然後讓使用者選：

- **在管理介面檢查（建議第一次使用）**：執行 `node "$HOME/.engram/app/current/bin/engram.mjs" ui`，瀏覽器會開啟 `http://127.0.0.1:4777`。請使用者到「匯入既有記憶」：逐筆檢查 → 按「開始演練」（在複本上完整跑一次匯入、驗證與還原，不碰真實檔案）→ 四項檢查都打勾後按「套用計畫」。等使用者完成。
- **由你直接套用**：使用者明確同意後執行 `node "$HOME/.engram/app/current/bin/engram.mjs" import apply --yes`。把輸出裡的**還原點**告訴使用者，需要時可用 `engram import undo <還原點>` 還原。輸出若有「延後：…正有對話在使用」，代表那個資料夾正在對話中（通常包含現在這段對話），對話結束後常駐程式會自動接上；在那之前，`doctor` 對這個資料夾的連結顯示 ✗ 是正常的。

原始記憶檔一律保留，不會刪除。只有一台電腦的新使用者、或第二台電腦沒有舊記憶時，可以略過這一步。

## 步驟 10：完成與交接

用下面的格式回報：

```text
✓ Engram 已安裝在「<電腦名稱>」
· 記憶庫：<GitHub repo 網址，或「只在這台電腦」>
· 匯入：<N 筆記憶，還原點 …> 或「尚未匯入」
· 接下來：
  1. 開一個新的 Claude Code 對話，問「你有看到 Engram 的狀態嗎？」
     應該會回答類似「<電腦名稱> · 專案：… · 已綁定」
  2. 管理介面：在終端機輸入 engram ui（建議用 Edge 開啟，從選單「應用程式 › 將此網站安裝為應用程式」）
  3. 第二台電腦：把同一段話貼給那台的 Claude Code，取一個不同的名字即可
  4. 請保留 <Engram 資料夾>，之後更新會用到
```

並提醒：已經開著的 Claude Code 對話，執行 `/reload-plugins` 或開新對話，才會出現 `/engram:inbox` 等指令。

## 已經安裝過（更新、修復或移除）

步驟 1 發現已經安裝時，先問使用者想做什麼：

| 想做的事 | 做法 |
| --- | --- |
| 更新到最新版 | 確認 Engram 資料夾位置後執行 `git -C "<Engram 資料夾>" pull`，再執行 `engram update`。用 ZIP 安裝的，請使用者下載新版本的 ZIP 覆蓋原資料夾後再執行 `engram update`（ZIP 以版本號區分，同一版本重複解壓不會更新） |
| 檢查是否正常 | `engram doctor`，依結果對照疑難排解 |
| 新增這台電腦的舊記憶 | 步驟 9 |
| 移除 | 先執行 `engram uninstall --dry-run` 列出移除計畫並說明，使用者同意後執行 `engram uninstall --yes`。預設**保留記憶庫**；只有使用者明確要求連本機記憶庫一起刪除時才加 `--purge`，而且要再確認一次（GitHub 上的 repo 不受影響） |

## 疑難排解

| 狀況 | 處理方式 |
| --- | --- |
| 找不到 winget | 請使用者到 Microsoft Store 更新「應用程式安裝程式」；或手動從 git-scm.com、nodejs.org（LTS 版）、cli.github.com 安裝缺少的工具 |
| 工具裝好了卻說找不到 | 用[附錄 B](#附錄-b工具的完整路徑) 的完整路徑；仍不行就請使用者重開 Claude Code |
| 「需要已登入的 GitHub CLI」 | 回到步驟 4 |
| 「無法執行 Claude Code」 | Claude Code 不在 PATH 上，或是用 npm 安裝的（claude.cmd）。請使用者在 PowerShell 執行 `irm https://claude.ai/install.ps1 \| iex` 改用官方安裝程式，重新開啟 Claude Code 後再說「繼續安裝 Engram」 |
| 「無法查詢你 GitHub 上的記憶庫」 | 通常是網路或公司代理。確認 `gh auth status`、能開啟 github.com 後重試；仍失敗可改用 B（`--remote`）或 C（`--local`） |
| GitHub 連線出現憑證或 TLS 錯誤 | 公司網路有 TLS 檢查時常見。經使用者同意，可設定 `git config --global http.sslBackend schannel` 後重試 |
| 「連接埠 4777 已被其他程式占用」 | 請使用者關閉占用的程式，再執行 `engram ui`。管理介面固定使用連接埠 4777 |
| 「npm 全域已經有另一個 engram」 | 不影響使用。終端機改用 `node "$HOME/.engram/app/current/bin/engram.mjs"` |
| 新開的終端機找不到 `engram` | 再開一個新視窗；仍找不到就用上一列的完整寫法 |
| 其他不確定的錯誤 | 執行 `engram doctor`；詳細紀錄在 `$HOME/.engram/local/logs/`。把錯誤原文與 doctor 結果整理給使用者，建議到 GitHub Issues 回報 |

## 附錄 A：安裝會改動哪些地方

| 位置 | 做什麼 |
| --- | --- |
| `$HOME/.engram/` | 記憶庫、程式本體、本機狀態與備份 |
| `$HOME/.claude/CLAUDE.md` | 在檔案末尾加一段兩行的 Engram 區塊，原本的內容不動；修改前先備份 |
| Claude Code 外掛 `engram` | 對話開始與結束時的 hooks、`/engram` 指令 |
| npm 全域指令 `engram` | 讓一般終端機也能輸入 `engram`（安裝時加 `--no-cli` 可略過） |
| Windows 工作排程器 `\Engram\Agent` | 登入時在背景啟動 Engram，每 10 分鐘同步一次 |
| 匯入時綁定的專案資料夾 | `.claude\settings.local.json` 寫一行記憶位置；不是 git 的資料夾另寫一個 `.claude\engram.json` 標記 |
| `$HOME/.claude/settings.json` 與記憶資料夾 | 只在預設權限模式是 auto 或 bypassPermissions 時：原本的記憶資料夾備份後換成連結，並允許 Claude 讀取該連結 |

每一項都記在安裝紀錄裡，`engram uninstall` 會逐項還原。

## 附錄 B：工具的完整路徑

winget 預設的安裝位置：

| 工具 | 完整路徑 |
| --- | --- |
| Git | `C:/Program Files/Git/cmd/git.exe` |
| Node.js | `C:/Program Files/nodejs/node.exe` |
| GitHub CLI | `C:/Program Files/GitHub CLI/gh.exe` |

用法範例：`& "C:/Program Files/nodejs/node.exe" --version`（PowerShell）或 `"/c/Program Files/nodejs/node.exe" --version`（Git Bash）。
