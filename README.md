<p align="center"><b>繁體中文</b> · <a href="README.en.md">English</a></p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img src="docs/assets/wordmark.svg" alt="Engram 憶跡" height="64">
  </picture>
</p>

<h3 align="center">Claude Code 的記憶與環境管家</h3>

<p align="center">
  讓 Claude 在每一台電腦都記得你，也把你教過的事做到。<br>
  記憶的跨裝置同步、整理與復原，加上護欄、環境健檢與設定同步。記憶存在你自己的 GitHub 私人 repo，公司、家裡、筆電打開同一個專案，Claude 都記得你教過的事，也不再重複踩同樣的坑。
</p>

<p align="center">
  <img alt="版本 2.0.0" src="https://img.shields.io/badge/version-2.0.0-0072CE">
  <img alt="Windows 11" src="https://img.shields.io/badge/platform-Windows%2011-0072CE">
  <img alt="Claude Code 外掛" src="https://img.shields.io/badge/Claude%20Code-plugin-13202F">
  <img alt="MIT 授權" src="https://img.shields.io/badge/license-MIT-2E8B87">
</p>

<p align="center">
  <a href="AI%20幫你快速安裝.md"><b>交給 AI 安裝</b></a> ·
  <a href="docs/快速開始.md">自己安裝</a> ·
  <a href="docs/使用說明.md">使用說明</a> ·
  <a href="docs/常見問題.md">常見問題</a>
</p>

<p align="center">
  <img src="docs/assets/hero.webp" alt="Engram 管理介面總覽：待處理事項、裝置同步軌跡與記憶分布，周圍是多台裝置透過同步連在一起" width="960">
</p>

## 最新功能

<!-- 維護方式：這一節只放最近三個版本。新版本寫在最上面的大區塊；原本的大區塊縮成下面兩欄表格的第一格，表格原本的第二格移除（完整內容仍在 CHANGELOG.md）。 -->

### 2.0.0　從記得到做到：記憶與環境管家

Engram 不只讓 Claude 記得你，現在也幫你把事情做到：重要的記憶在對的時候出現，踩過的坑變成護欄，整個 Claude Code 環境也有人照顧。2.0 有四條主線：

| | 你得到什麼 |
| --- | --- |
| **記憶活化** | 你的糾正與偏好永遠留在索引裡（所有電腦都更新到 2.0.0 之後生效）；送出訊息時，情境召回帶出最多 3 筆相關的記憶；護欄在 Claude 送出指令前擋下已知會出錯的寫法；記憶可以「畢業」成核心準則的一行、護欄提醒或環境設定 |
| **自動駕駛 2.0** | 只遵守你本人確認過的偏好；沒有執行的建議存進保留區，不再消失；撞到用量上限或登入到期會停下來並通知你；每週一份成果摘要 |
| **環境管家** | 每天檢查這台電腦的 Claude Code 環境、比較兩台電腦的差異，並讓幾台電腦共用同一份設定（同步來的設定要在這台核可才會套用）；一台更新新版，其他台（用 git 安裝的）自動跟上 |
| **更安靜、更穩** | 背景存檔沒有變動就不動作；同步連續失敗會自我診斷並通知你；記憶庫每週自動打包；久沒用的專案自動休眠，疑似同一個專案會建議合併 |

<p align="center">
  <img src="docs/assets/screenshots/v2-holding.png" alt="保留區：自動駕駛沒有執行的建議，每一項附原因與證據，可以採用或標成不需要" width="960">
</p>

<p align="center">
  <img src="docs/assets/screenshots/v2-environment.png" alt="環境頁的設定同步：共用的環境設定檔、這台套用後會改什麼，以及等待這台核可的項目" width="960">
</p>

<p align="center">
  <img src="docs/assets/screenshots/v2-digest.png" alt="每週摘要：這週學到的、畢業的記憶、保留區、護欄、情境召回、環境健檢與自動駕駛用量" width="960">
</p>

升級是免費的。2.0 起，自動駕駛不再拆分或精簡記憶；從其他電腦同步來的環境設定、技能與護欄的擋下規則，要在每台電腦核可一次才會生效。請讓所有電腦都更新到 2.0.0：新的索引規則要等全部更新之後才啟用（只更新一台時，共用的索引暫時照舊的排法，不會遺失資料）；1.x 沒有自動更新，從 1.x 升級的第一次要手動 `git pull`、`engram update`。詳見[使用說明](docs/使用說明.md)與[更新紀錄](CHANGELOG.md)。

<table>
  <tr>
    <td width="50%" valign="top">
      <b>1.6.0　多台電腦平等、預算更寬裕</b><br><br>
      <img src="docs/assets/screenshots/autopilot-peers.png" alt="自動駕駛頁上方：開啟自動駕駛的電腦清單（兩台平等），右邊是本月用量與可以自訂金額的每月上限"><br>
      自動駕駛不再只讓一台電腦處理共用記憶：每台開啟的電腦都平等，一台整理過的版本其他台不會重複處理。每月上限預設約當 US$200，拿掉每輪的金額上限，也可以自訂（1～1000）；審核員的「不同意」會記住，<a href="docs/使用說明.md#自動駕駛整理工作全部交給-ai">使用說明</a>
    </td>
    <td width="50%" valign="top">
      <b>1.5.0　自動駕駛：整理工作全部交給 AI</b><br><br>
      <img src="docs/assets/screenshots/autopilot.png" alt="自動駕駛頁：上方是開關、開啟的電腦與本月用量，下方列出每一輪做了什麼、理由與復原按鈕"><br>
      開啟後，收件匣的卡片、重複與過時的記憶、對話回顧、同步衝突、Claude 寫入內容的把關，甚至記憶裡的金鑰，都由 AI 每天在電腦閒置時自主處理；每一項附理由、經過第二次 AI 審核，事後可以一鍵復原，<a href="docs/使用說明.md#自動駕駛整理工作全部交給-ai">使用說明</a>
    </td>
  </tr>
</table>

更早的版本見[更新紀錄](CHANGELOG.md)。

## 為什麼需要 Engram

Claude Code 會自動記下你的習慣、專案慣例與踩過的坑。但這些記憶只存在**一台電腦的一個資料夾**裡：

<p align="center">
  <img src="docs/assets/illustrations/problem.webp" alt="公司電腦：教過的都記得；家裡電腦：又要重教一次" width="880">
</p>

| 你遇到的狀況 | 結果 |
| --- | --- |
| 在公司教過 Claude 的事，回家開同一個專案 | 全部要重教一次 |
| 專案資料夾搬家、改名，或用了字數相同的中文名稱 | 記憶消失，或和別的專案混在一起 |
| 用了幾個月，記憶越來越多 | 重複、過時、放錯專案的內容沒人整理；索引超過 200 行，後面的 Claude 根本讀不到 |
| 教過的糾正，Claude 還是一再踩同一種坑 | 記憶躺在索引裡沒被讀到，或同一種指令寫法一再出錯 |
| 幾台電腦的 Claude Code 設定慢慢對不上 | 一台好好的，另一台卻變慢、失效，卻不知道差在哪裡 |

Engram 把記憶變成**跟著你走、跟著專案走、隨時能復原**的資產，也幫你把整個 Claude Code 環境管好。

## 功能

| | 功能 | 你得到什麼 |
| :---: | --- | --- |
| <img src="docs/assets/icons/memory-pane.webp" width="48" alt=""> | **親眼看見 Claude 讀了什麼** | Claude Code 旁的記憶面板即時列出這次對話載入與讀取的記憶，每一列標出全文、標題或摘要，一眼看出回答根據什麼。 |
| <img src="docs/assets/icons/sync.webp" width="48" alt=""> | **多台電腦自動同步** | 背景自動同步（預設每 10 分鐘）。開 Claude Code 不用等網路，離線照常記憶，恢復連線後自動補上。 |
| <img src="docs/assets/icons/project-id.webp" width="48" alt=""> | **專案用 ID 認，不用路徑認** | 資料夾搬家、改名，或在另一台電腦 clone 同一個 git repo，都認得是同一個專案。 |
| <img src="docs/assets/icons/scopes.webp" width="48" alt=""> | **三種範圍各歸其位** | 個人偏好放「全域」，每個專案都看得到；安裝路徑、網路設定放「單機」，不會跑到別台電腦。 |
| <img src="docs/assets/icons/restore.webp" width="48" alt=""> | **什麼都能復原** | 每個變更都有歷史。匯入前先在複本上完整演練，套用後隨時一鍵還原；原始記憶檔一律保留。 |
| <img src="docs/assets/icons/merge.webp" width="48" alt=""> | **衝突不吵你** | 兩台改了不同段落就自動合併；改到同一段才請你並排比對，Claude 永遠不會讀到衝突標記。 |
| <img src="docs/assets/icons/secrets.webp" width="48" alt=""> | **金鑰不外流，寫入有把關** | 偵測到疑似密碼、權杖、連線字串的記憶，只留在本機、不會推送，並在收件匣提醒你遮蔽。Claude 自己寫進每次都會載入的記憶時，收件匣會請你看過差異後確認或退回。 |
| <img src="docs/assets/icons/ai-tidy.webp" width="48" alt=""> | **交給 Claude 整理與驗證** | 在管理介面選範圍，Claude 分析後提出建議與修改後的內容；`/engram:dream` 還會拿最近的對話紀錄當證據，找出已經過時或寫錯的記憶。你在網頁逐項看差異、做決定，Claude 才動手，每一項都能復原。不想逐項決定時開啟**自動駕駛**，整理、回顧與收件匣全部交給 AI：只遵守你確認過的偏好，沒有執行的建議存進保留區，事後再看、再復原。 |
| <img src="docs/assets/icons/dashboard.webp" width="48" alt=""> | **看得見的管理介面** | 總覽、記憶庫、收件匣、保留區、每週摘要、專案、環境、裝置與同步，一個介面全部看清楚；支援深色模式，可安裝成桌面應用程式。 |

### 2.0 新增：從記得到做到

| 功能 | 你得到什麼 |
| --- | --- |
| **重要的記憶不被擠掉** | 索引放不下時，釘選的與你的糾正、偏好永遠留在前面；專案索引快滿時自動縮短每一行。所有電腦都更新到 2.0.0 之後才生效；混版期間共用的索引暫時照舊的排法，不會遺失資料。 |
| **相關的記憶自己出現** | 情境召回：你送出訊息時，從全域、這台電腦與目前專案的記憶帶出最多 3 筆相關的，只有 Claude 看得到。在你的電腦上計算，不呼叫 AI。 |
| **護欄** | 把踩過的指令寫法問題編成規則，在 Claude 送出 Bash 或 PowerShell 指令前比對：把握高的擋下並告訴 Claude 正確寫法，其餘只提醒；擋錯時會暫時降成提醒。 |
| **記憶畢業** | 自動駕駛定期判斷哪些記憶其實是規則或設定，換成核心準則的一行、護欄提醒或環境設定；一次性的進度封存。 |
| **保留區與每週摘要** | 自動駕駛沒有執行的建議連同證據保存下來，由你採用或忽略；每週一份成果摘要。 |
| **環境健檢與兩台差異** | 每天檢查這台電腦的 Claude Code 環境（拖慢操作的 hook、失效的設定、沒在用的外掛…），並列出兩台電腦哪裡不一樣。只讀名稱、版本、雜湊與耗時，不讀設定值。 |
| **環境設定同步** | 幾台電腦共用一份設定、技能與外掛清單；從其他電腦同步來的內容要你在這台核可才會套用，先備份、可以還原。 |
| **自動更新** | 一台電腦更新新版後，其他用 git 安裝的電腦每天檢查並自己更新；失敗自動退回並通知你。 |

## 30 秒看懂運作方式

<p align="center">
  <img src="docs/assets/illustrations/how-it-works.webp" alt="公司電腦、家裡電腦、筆電都透過背景同步，連到你的 GitHub 私人 repo engram-vault" width="880">
</p>

- Engram **不修改 Claude Code**，只使用官方提供的機制：記憶資料夾、`CLAUDE.md` 匯入、hooks，以及外掛畫面（記憶面板）。
- 記憶庫是一個 git repo，放在 `%USERPROFILE%\.engram\vault`，同步到**你自己帳號**底下的私人 repo。Engram 沒有伺服器，不蒐集任何資料。
- 日常運作**不呼叫 AI**：健康檢查、情境召回、護欄與環境健檢都用規則在你的電腦上判斷，金鑰遮蔽在本機完成。只有你開啟自動駕駛時，才會每天在背景用你的 Claude 額度整理一次。

## 安裝

需要：**Windows 11**、已登入的 **Claude Code**（官方安裝程式版本）、一個 **GitHub 帳號**。Node.js、Git、GitHub CLI 缺少的話會自動補齊。

### 方法一：交給 AI 安裝（推薦，約 10 分鐘）

<p align="center">
  <img src="docs/assets/illustrations/install-with-ai.webp" alt="三個步驟：1 複製一段話、2 貼給 Claude Code、3 完成，記憶開始同步" width="880">
</p>

打開 Claude Code，把下面這段話整段貼上：

```text
請幫我安裝 Engram（Claude Code 的記憶與環境管家）。
安裝手冊：https://raw.githubusercontent.com/Sen-CaPoo/engram/main/AI%20%E5%B9%AB%E4%BD%A0%E5%BF%AB%E9%80%9F%E5%AE%89%E8%A3%9D.md
請先完整讀完手冊再開始，照步驟進行；任何會改動電腦的步驟，都先用白話跟我說明並取得我的同意。
```

Claude 會檢查環境、補齊工具、列出安裝計畫給你確認，再完成安裝與驗證。你只需要在登入 GitHub 時點幾下瀏覽器。詳見 [AI 幫你快速安裝.md](AI%20幫你快速安裝.md)。

### 方法二：一鍵安裝

1. 下載 Engram：點右上角 **Code → Download ZIP** 並解壓縮，或執行 `git clone https://github.com/Sen-CaPoo/engram.git`。
2. 雙擊資料夾裡的 **`setup.cmd`**。它會補齊工具、帶你登入 GitHub、列出安裝計畫，等你輸入 `y` 同意後才安裝。
3. 安裝完成後瀏覽器會開啟管理介面，到「匯入既有記憶」把舊記憶收進來。

完整步驟與畫面說明見 [快速開始](docs/快速開始.md)。

### 第二台電腦

步驟完全一樣。Engram 會發現你 GitHub 上已經有 `engram-vault`，自動接上並下載第一台的記憶。

> **安裝後請保留 Engram 資料夾**，之後更新版本會用到。更新只要兩步：取得新版程式（`git pull`，或下載新的 ZIP 覆蓋原資料夾），再執行 `engram update`。有好幾台電腦時，用 git 安裝的電腦在另一台更新後會自動跟上（用 ZIP 安裝的要自己更新）。

## 日常使用

**什麼都不用做。** Claude 照平常記憶事情，Engram 在背景處理其餘的事：

1. **對話開始**：Claude 知道自己在哪台電腦、哪個專案，也知道全域與單機記憶要寫到哪裡。
2. **送出訊息、執行指令時**：情境召回帶出相關的記憶；護欄在 Bash 或 PowerShell 指令送出前擋下已知會出錯的寫法。
3. **對話結束**：整理索引、檢查有沒有疑似金鑰，存進記憶庫。
4. **每 10 分鐘（預設）**：和其他電腦交換變更。
5. **每天一次**：健康檢查與環境健檢，有需要你決定的事就放進收件匣；另一台電腦發佈了新版時，自動更新。
6. **開啟自動駕駛時**：每天在電腦閒置時，AI 自主處理收件匣、整理記憶、回顧對話，連收件匣都不用看；做了什麼都在「自動駕駛」頁，可以復原；每週有一份摘要。

想主動整理時，在 Claude Code 裡輸入：

| 指令 | 用途 |
| --- | --- |
| `/engram:autopilot` | 自動駕駛：開啟、關閉、立即執行一輪、看做了什麼、復原 |
| `/engram:inbox` | 讓 Claude 逐張讀過收件匣，說明判斷依據與建議；你同意後才執行。加上「自動」直接處理有把握的項目 |
| `/engram:tidy` | 深度整理全域、單機、一個專案、核心準則或全部記憶：Claude 提出建議，你在管理介面「記憶整理」逐項決定（指令可以在那一頁產生） |
| `/engram:tidy-apply` | 照你在記憶整理頁的決定執行，結果回到同一頁 |
| `/engram:dream` | 對話回顧：拿這台電腦最近的對話紀錄驗證專案的記憶、補上漏記的事；建議同樣在記憶整理頁逐項決定 |
| `/engram:save` | 把這次對話值得長期記住的事存成記憶 |
| `/engram:recall` | 從其他專案、其他電腦的記憶找出相關經驗，只讀不寫 |
| `/engram-memories` | 開關記憶面板，看這次對話載入與讀取了哪些記憶（也可以點底部的「◆ 憶跡」） |

在終端機常用的指令：

| 指令 | 用途 |
| --- | --- |
| `engram ui` | 開啟管理介面 |
| `engram status` ／ `engram doctor` | 看這台電腦的狀態與同步；逐項檢查記憶連結、GitHub 連線與常駐程式 |
| `engram holding` | 保留區：自動駕駛沒有執行的建議（`adopt`、`dismiss`） |
| `engram guardrails` | 護欄的規則與近 30 天的命中（`test "<指令>"` 試一個指令） |
| `engram env` | 環境健檢（`diff` 兩台差異；`plan`、`approve`、`apply`、`undo` 環境設定同步，核可要在你自己的終端機做） |
| `engram autopilot` | 自動駕駛的狀態與開關（`preferences` 遵守的偏好、`digest` 每週摘要） |
| `engram update` | 部署新版本（`--rollback` 切回上一版） |

完整的指令見[使用說明](docs/使用說明.md#16-指令速查)。

<table>
  <tr>
    <td width="50%"><img src="docs/assets/screenshots/inbox.png" alt="收件匣：衝突、疑似金鑰、資料夾撞名等需要你決定的事"><br><sub><b>收件匣</b>：每張卡片都有一鍵處理，或「交給 Claude」</sub></td>
    <td width="50%"><img src="docs/assets/screenshots/library.png" alt="記憶庫：依範圍與專案瀏覽、搜尋與編輯記憶"><br><sub><b>記憶庫</b>：搜尋、編輯、改變範圍、查看歷史</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/screenshots/import.png" alt="匯入既有記憶：產生計畫、檢查、沙盒演練、套用、驗證"><br><sub><b>匯入既有記憶</b>：先在複本演練，通過才能套用</sub></td>
    <td width="50%"><img src="docs/assets/screenshots/overview-dark.png" alt="深色模式的總覽頁"><br><sub><b>深色模式</b>：跟隨系統設定</sub></td>
  </tr>
</table>

## 隱私與安全

<p align="center">
  <img src="docs/assets/illustrations/privacy.webp" alt="資料只在你的電腦與你的 GitHub 私人 repo 之間流動；沒有第三方伺服器；疑似金鑰不推送" width="760">
</p>

- **你的資料只在兩個地方**：你的電腦，以及你自己 GitHub 帳號底下的私人 repo。對話紀錄（transcript）不會同步：讀取統計與對話回顧都在這台電腦讀，同步的只有每筆記憶的讀取次數。
- **2.0 新增的同步內容**：環境指紋（名稱、版本與雜湊，加上每個 hook 的指令開頭；沒有環境變數的值）、共用的環境設定檔與自製技能、護欄規則、沒有對話內容的保留區項目，以及自動更新用的發佈資訊。對話回顧產生的保留區項目、你糾正 Claude 的原話與各種命中紀錄只留在這台電腦。完整清單見[常見問題](docs/常見問題.md#哪些資料會同步到我的私人記憶庫哪些只留在這台電腦)。
- **不呼叫 AI**：只有三種情況會用到你的 Claude 額度：Claude Code 改版時的相容性探測（只用合成資料，可在介面關閉）、你主動輸入 `/engram:` 開頭的指令時（`/engram:dream` 會分析多個對話，用量比其他指令多），以及你開啟自動駕駛時（每天一輪，每月有上限，預設約當 US$200 的 API 牌價；用訂閱時不另外計費）。自動駕駛用你電腦上的 Claude Code 登入呼叫，送出的內容和你平常用 Claude Code 一樣，疑似金鑰先在本機遮蔽。記憶面板、讀取統計、情境召回、護欄與環境健檢只在本機計算，不會用到額度。
- **金鑰保護**：疑似金鑰的記憶不會推送；交給 Claude 整理前，偵測到的金鑰會先在本機遮蔽。
- **可完整移除**：安裝前列出所有會改動的位置，每一項都記錄下來；`engram uninstall` 依紀錄逐項還原，預設保留你的記憶庫。
- **公司資料**：如果公司不允許把工作資料放在個人 GitHub，可以改用公司組織底下的私人 repo，或只在單機使用。

詳見 [SECURITY.md](SECURITY.md)。

## 常見問題

**要付費嗎？** 不用。Engram 以 MIT 授權免費提供。

**支援 macOS 或 Linux 嗎？** 目前只支援 Windows 11（背景同步使用 Windows 工作排程器）。

**公司網路擋住 GitHub 怎麼辦？** 記憶照常存在本機，回到能連 GitHub 的網路後自動補同步。

**不想用了怎麼辦？** 執行 `engram uninstall`，電腦會還原到安裝前，記憶庫預設保留。

**會自己改我的 Claude Code 設定嗎？** 不會。環境設定同步預設只報告，從其他電腦同步來的設定要你在這台核可才會套用，套用前先備份、可以還原。

**升級到 2.0 要付費或重裝嗎？** 都不用。照平常的方式更新即可，見[使用說明](docs/使用說明.md#15-更新)。

更多問題見 [常見問題](docs/常見問題.md)。

## 文件

| 文件 | 給誰看 |
| --- | --- |
| [AI 幫你快速安裝.md](AI%20幫你快速安裝.md) | 想讓 Claude 代為安裝的人（也是給 AI 照做的手冊） |
| [快速開始](docs/快速開始.md) | 想自己一步步安裝的人 |
| [使用說明](docs/使用說明.md) | 完整功能：自動駕駛與保留區、情境召回、護欄、環境管家、收件匣、衝突、資料夾撞名、暫停與移除、指令速查 |
| [常見問題](docs/常見問題.md) | 常見疑問與疑難排解 |
| [更新紀錄](CHANGELOG.md) | 每個版本的變更 |

## 關於名稱

<img src="docs/assets/logo-3d.png" alt="Engram 標誌" width="96" align="right">

**Engram**（記憶痕跡）是神經科學用語，指一段記憶在大腦裡留下的實體痕跡；中文名「憶跡」取其意。Logo 是一筆寫成的 e：連續的軌跡代表記憶，環形代表同步，開口處的紅點代表「現在，這台電腦」。

## 授權

[MIT](LICENSE) © 2026 Sen-CaPoo

Claude 與 Claude Code 是 Anthropic 的商標。Engram 是獨立開發的第三方工具，與 Anthropic 沒有隸屬或合作關係。
