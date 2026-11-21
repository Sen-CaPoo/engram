// 情境召回的校準語料：虛構的團隊、工具與題材（烘焙坊訂單系統、圖書館借閱、氣象站與幾樣嗜好），
// 產品名、主機名、路徑、連接埠與數字都是編的，彼此不相關，不對應任何真實的人、公司或環境。
// 分布模擬一個用了幾個月的 Engram：全域 23 筆（規則 4、參考 19）、單機 5 筆（其中 1 筆只與專案有關）、兩個專案各 6 筆，共 40 筆。
// 門檻與加權（plugin/hooks/lens/recall.mjs 的 MIN_SCORE 等常數）用這組語料與 QUERIES 校準：該帶的要帶、閒聊與泛用的開發請求不帶。

const G = (file, name, desc, type, body, extra = {}) => ({ ref: `global/${file}.md`, path: `~/.engram/vault/global/${file}.md`, name, desc, type, body, pid: null, loaded: '*', ...extra });
const M = (file, name, desc, type, body, extra = {}) => ({ ref: `machines/m-test/${file}.md`, path: `~/.engram/vault/machines/m-test/${file}.md`, name, desc, type, body, pid: null, loaded: '*', ...extra });
const P = (pid, file, name, desc, type, body, extra = {}) => ({ ref: `projects/${pid}/memory/${file}.md`, path: `~/.engram/vault/projects/${pid}/memory/${file}.md`, name, desc, type, body, pid, loaded: pid, ...extra });
const REF = { loaded: null };

export const CORPUS = [
  // 全域：規則層（每場對話都載入）
  G('steps-first', 'steps-first', '回覆先列步驟，再補說明', 'feedback', '使用者偏好先看到步驟清單，背景說明放在後面。'),
  G('metric-units', 'metric-units', '數量一律用公制單位與攝氏溫度', 'user', '重量用公克、溫度用攝氏、長度用公分。'),
  G('preview-before-bulk', 'preview-before-bulk', '批次修改資料之前先給預覽，確認後才執行', 'feedback', '一次改很多筆時，先列出會改哪些、改成什麼，等確認再動手。'),
  G('dated-exports', 'dated-exports', '匯出的檔案名稱前面加上日期', 'feedback', '例如 20260315-訂單.csv，方便排序與找舊檔。'),
  // 全域：虛構的工具
  G('larkspur-dead-letter', 'larkspur-dead-letter', 'Larkspur 訊息佇列重試五次後進死信佇列，死信保留 72 小時', 'reference', 'Larkspur 的重試間隔是指數退避。超過五次就移到死信佇列，管理頁可以手動重送。', REF),
  G('ferrowind-ttl', 'ferrowind-ttl', 'Ferrowind cache servers default to a 90 second TTL; hot keys use 15 seconds', 'reference', 'Set the TTL per key prefix in ferrowind.toml. Hot keys such as the menu snapshot use 15 seconds so price changes show up quickly.', REF),
  G('quillmate-pdf-fonts', 'quillmate-pdf-fonts', 'Quillmate 匯出 PDF 時要勾選「嵌入字型」，不然中文會變方框', 'reference', 'Quillmate 預設只嵌入拉丁字型。匯出設定裡勾選嵌入全部字型，檔案會變大但中文正常。', REF),
  G('brambleci-lint', 'brambleci-lint', 'Brambleci 流水線先跑 lint 再跑單元測試，失敗的紀錄保留 7 天', 'reference', 'lint 沒過就不會跑測試。失敗的工作紀錄在 Brambleci 介面保留 7 天，之後自動刪除。', REF),
  G('tidewater-bundle', 'tidewater-bundle', 'Tidewater 部署工具把整個資料夾打包上傳，要在 .tideignore 排除大型檔案', 'reference', 'Tidewater 不看 .gitignore。影片與備份檔要寫進 .tideignore，不然上傳會逾時。', REF),
  G('locale-folders', 'locale-folders', '介面文字的翻譯放在 locales 資料夾，每個語言一個檔案', 'reference', '新增文字時先寫進 zh-TW 檔，再補 en。鍵名用點分隔的英文。', REF),
  G('nettle-hooks', 'nettle-hooks', 'Nettle 管理專案的提交前檢查，訊息格式不對會被擋下', 'reference', '提交訊息要以類別開頭（修正、新增、文件）。Nettle 的設定在 nettle.yml。', REF),
  G('kestrel-log-rotation', 'kestrel-log-rotation', 'Kestrelog 日誌每天輪替，壓縮後保留 30 份', 'reference', '輪替時間是凌晨三點。磁碟剩不到一成時會提早刪最舊的。', REF),
  G('marlin-backup', 'marlin-backup', 'Marlin 備份每晚增量、每週日完整，還原要先停寫入', 'reference', '還原前先把服務切成唯讀，避免還原途中又有新資料寫進來。', REF),
  // 全域：嗜好與生活
  G('oven-thermometer', 'oven-thermometer', '烤箱溫度計每季用沸水校正一次，誤差超過 3 度就換', 'reference', '把探針放進沸水，讀數應該接近 100 度。誤差大時先調整再測一次。', REF),
  G('sourdough-feeding', 'sourdough-feeding', '酸種每 12 小時餵一次，麵粉與水一比一', 'reference', '冷藏時可以改成一週餵一次。表面出現灰色液體代表餓了。', REF),
  G('wind-sensor-cleaning', 'wind-sensor-cleaning', '風速計的杯子每月清潔一次，軸承卡住讀數會偏低', 'reference', '用軟刷清掉灰塵與蛛網，不要上油。讀數長時間是零就檢查軸承。', REF),
  G('rain-gauge-check', 'rain-gauge-check', '雨量筒的漏斗容易被落葉堵住，颱風前後都要檢查', 'reference', '堵住時讀數會突然變少。清完後倒一杯水確認翻斗有動。', REF),
  G('beehive-inspection', 'beehive-inspection', '蜂箱春夏每週檢查一次，看王台與蜂蜜存量', 'reference', '檢查時動作要慢，避開下雨天。發現王台要決定是否分蜂。', REF),
  G('oolong-ratio', 'oolong-ratio', '烏龍茶一公克配五十毫升熱水，第一泡五十秒', 'reference', '之後每泡多加十秒。水溫保持在九十度上下。', REF),
  G('telescope-collimation', 'telescope-collimation', '反射式望遠鏡搬動之後要重新準直', 'reference', '用準直目鏡對齊主鏡與副鏡。星點變成彗星狀就是偏了。', REF),
  G('ferry-timetable', 'ferry-timetable', '渡輪時刻表的資料每天清晨更新，假日班次另外一份', 'reference', '假日班次放在另一個檔案，合併時以日期判斷。', REF),
  G('choir-room-booking', 'choir-room-booking', '合唱團排練室要提前一週預約，鋼琴調音每半年一次', 'reference', '預約表在社區中心的櫃台，週末時段最搶手。', REF),
  G('library-barcode', 'library-barcode', '館藏條碼 13 碼，前 3 碼是分館代號', 'reference', '條碼印在書背內側。分館代號 101 是總館。', REF),
  // 單機（m-test 是虛構的電腦）
  M('label-printer', 'label-printer', '這台接的標籤印表機叫 oven-tag-01，驅動要選 ZPL 模式', 'reference', '換紙之後要按一次校正鍵，不然標籤會錯位。', REF),
  M('scanner-serial', 'scanner-serial', '條碼掃描器接在 COM7，鮑率 9600', 'reference', '拔插之後連接埠號可能會變，要到裝置管理員確認。', REF),
  M('fixture-folder', 'fixture-folder', '測試用的假資料放在 E:\\fixtures\\crumbs', 'reference', '每個情境一個子資料夾，檔名用情境代號。', REF),
  M('render-queue', 'render-queue', '這台的影像渲染佇列一次只跑兩個工作', 'reference', '同時跑三個會把記憶體用完。', REF),
  M('bakery-dev-port', 'bakery-dev-port', '烘焙坊訂單系統在這台的開發伺服器用 7311 port', 'reference', '預設的連接埠被別的工具占用，所以改成 7311。', { pid: 'p-bakery', loaded: 'p-bakery' }),
  // 專案：烘焙坊訂單系統
  P('p-bakery', 'order-cutoff', 'order-cutoff', '訂單截止：隔天取貨的訂單晚上八點截止，之後排到後天', 'project', '截止時間以門市時區計算。節日前一週提前到下午五點。'),
  P('p-bakery', 'cake-deposit', 'cake-deposit', '客製蛋糕先收三成訂金，取貨前兩天內不能退', 'project', '訂金在下單時付清。取貨前兩天以前取消可以全額退回訂金。', REF),
  P('p-bakery', 'bakery-release', 'bakery-release', '上線前檢查：資料庫遷移、功能旗標、快取清除、回滾腳本', 'project', '每次上線前照清單逐項確認。資料庫遷移先在預備環境跑過。', REF),
  P('p-bakery', 'courier-webhook', 'courier-webhook', '外送平台的 webhook 要驗簽章，重送時用訂單編號去重', 'project', '外送平台可能重送同一個事件。用訂單編號做冪等，簽章不對一律回 400。', REF),
  P('p-bakery', 'bakery-staging-db', 'bakery-staging-db', '預備環境的資料庫每週一凌晨從正式環境去識別化複製', 'reference', '顧客姓名與電話在複製時遮蔽。測試帳號另外建立。', REF),
  P('p-bakery', 'menu-search', 'menu-search', '品項搜尋改用中文雙字組，同義詞表放在設定檔', 'project', '原本用空白切詞，中文品項完全搜不到。改用雙字組加同義詞表之後好很多。', REF),
  // 專案：圖書館借閱系統
  P('p-library', 'loan-period', 'loan-period', '一般圖書借期 28 天，可以續借兩次', 'project', '有人預約的書不能續借。視聽資料借期 14 天。'),
  P('p-library', 'reader-card-api', 'reader-card-api', '讀者證 API 用 OAuth client credentials，權杖 30 分鐘過期', 'project', '每個分館系統一組 client id。權杖過期前 5 分鐘換新。', REF),
  P('p-library', 'stocktake-batch', 'stocktake-batch', '盤點用批次檔，每批最多 2,000 筆，失敗的另外重送', 'project', '批次檔上傳後非同步處理。結果檔列出失敗的列與原因。', REF),
  P('p-library', 'hold-queue', 'hold-queue', '預約排隊：書還回來後保留 3 天給第一順位', 'project', '3 天內沒來取就換下一位，並寄通知。', REF),
  P('p-library', 'branch-transfer', 'branch-transfer', '分館之間調撥圖書每週二、五各一趟', 'project', '調撥單要在前一天下午三點前送出。', REF),
  P('p-library', 'circulation-dashboard', 'circulation-dashboard', '借閱儀表板顯示每日借出、歸還與逾期量', 'project', '資料每小時更新。逾期率是逾期冊數除以借出冊數。', REF),
];

/** 校準用的訊息：want 是一定要帶出的 ref；none 代表什麼都不該帶 */
export const QUERIES = [
  { q: '烤箱溫度計好像不準，多久要校正一次？', want: 'global/oven-thermometer.md' },
  { q: 'Larkspur 的訊息一直重試，死信佇列要怎麼處理', want: 'global/larkspur-dead-letter.md' },
  { q: 'what TTL should I use for hot keys on the ferrowind cache servers', want: 'global/ferrowind-ttl.md' },
  { q: '酸種多久要餵一次？麵粉和水的比例是多少', want: 'global/sourdough-feeding.md' },
  { q: 'Quillmate 匯出 PDF 之後中文變成方框', want: 'global/quillmate-pdf-fonts.md' },
  { q: '風速計的讀數一直偏低，是不是要清潔', want: 'global/wind-sensor-cleaning.md' },
  { q: '客製蛋糕的訂金可以退嗎？', want: 'projects/p-bakery/memory/cake-deposit.md', pid: 'p-bakery' },
  { q: '外送平台的 webhook 重送了兩次，訂單重複建立', want: 'projects/p-bakery/memory/courier-webhook.md', pid: 'p-bakery' },
  { q: '讀者證 API 的權杖多久過期？', want: 'projects/p-library/memory/reader-card-api.md', pid: 'p-library' },
  { q: '蜂箱多久要檢查一次，要看哪些地方', want: 'global/beehive-inspection.md' },
  { q: '館藏條碼前三碼代表什麼', want: 'global/library-barcode.md' },
  { q: '好，繼續', none: true },
  { q: '謝謝，這樣就可以了', none: true },
  { q: '幫我看一下這個錯誤怎麼修', none: true },
  { q: 'ok please continue with the next step', none: true },
  { q: '今天天氣如何？要不要帶傘', none: true },
  // 要寫測試時帶出團隊的測試流程，算是相關（「跑一下測試」只碰到一個詞，不帶）
  { q: '把這個函式改成 async，並且補上單元測試', want: 'global/brambleci-lint.md' },
  {
    q: `這段程式跑不動，幫我看看：
function add(a, b) {
  const result = a + b;
  console.log('result', result);
  return result;
}
const items = [1, 2, 3].map((x) => add(x, 1));
for (const item of items) { if (item > 2) throw new Error('too big'); }`,
    none: true,
  },
  { q: '幫我 commit 這些變更，訊息用中文', none: true },
  { q: '跑一下測試，看看有沒有壞掉的', none: true },
  { q: 'npm install 失敗了，錯誤訊息在下面', none: true },
  { q: '這個 PR 幫我 review 一下，重點看錯誤處理', none: true },
  { q: '把 git log 最近十筆列出來', none: true },
  { q: '用 bash 寫一個迴圈把資料夾裡的檔案改名', none: true },
];
