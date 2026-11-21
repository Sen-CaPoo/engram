// 正體中文展示資料：全部是合成內容（不讀任何真實記憶），和 demo-sample-en.mjs 同一組情境，用來產生中文版 README 與使用說明的截圖。
//   node build.mjs --demo   找不到開發者的記憶盤點時，用這份資料 → 23_介面原型_展示版.html
// 形狀與 demo-data.mjs 的 buildDemoData 相同：{ self, other, projects, memories, plan }
import { createHash } from 'node:crypto';

const B32 = '0123456789abcdefghjkmnpqrstvwxyz';
const hash = (s, n) => {
  const h = createHash('sha1').update(s).digest();
  let out = '';
  for (let i = 0; i < n; i++) out += B32[h[i] % 32];
  return out;
};

export function buildSampleDataZh(now = Date.now()) {
  const ago = (m) => new Date(now - m * 60000).toISOString();
  const H = 60, D = 24 * 60;
  const SELF = { id: 'office-pc-7k2q', label: '這台電腦', hostname: 'OFFICE-PC' };
  const OTHER = { id: 'home-pc-3m9x', label: '另一台電腦', hostname: 'HOME-PC' };

  const P = [
    { key: 'order-service', name: '訂單服務', remote: 'github.com/acme/order-service', home: true, last: 3 * H },
    { key: 'analytics-dashboard', name: '數據分析儀表板', remote: 'github.com/acme/analytics-dashboard', home: true, last: 26 * H },
    { key: 'mobile-app', name: '行動 App', remote: 'github.com/acme/mobile-app', home: false, last: 2 * D },
    { key: 'data-pipeline', name: '資料管線', remote: 'github.com/acme/data-pipeline', home: true, last: 4 * D },
    { key: 'marketing-site', name: '行銷網站', remote: '', home: false, last: 9 * D },
    { key: 'release-notes', name: '版本說明', remote: '', home: false, last: 17 * D },
  ];
  const pidOf = (key) => `${key}-${hash(key, 5)}`;
  const projects = P.map((p) => ({
    pid: pidOf(p.key), name: p.name, aliases: [], remotes: p.remote ? [p.remote] : [],
    paths: {
      [SELF.id]: { path: `C:\\Users\\you\\Projects\\${p.key}`, exists: true, lastOpenedAt: ago(p.last), method: 'junction', encoded: `C--Users-you-Projects-${p.key}` },
      ...(p.home ? { [OTHER.id]: { path: `D:\\Work\\${p.key}`, exists: true, lastOpenedAt: ago(p.last + 20 * H), method: 'junction', encoded: `D--Work-${p.key}` } } : {}),
    },
    counts: { memories: 0, findings: 0 }, lastActivityAt: ago(p.last), archived: false, index: { lines: 2, bytes: 60 },
  }));
  projects.push({
    pid: pidOf('legacy-crm'), name: '舊版 CRM', aliases: ['legacy-crm'], remotes: [], paths: {},
    counts: { memories: 0, findings: 0 }, lastActivityAt: ago(140 * D), archived: true, index: { lines: 2, bytes: 60 },
  });

  // [範圍, 專案 key, 名稱, 類型, 說明, 幾分鐘前, 內文]
  const M = [
    ['global', '', 'user-role', 'user', '使用者是全端工程師，主力 TypeScript 與 Python，負責三條產品線', 3 * D,
      '全端工程師，主要用 TypeScript（Node、React）與 Python。\n\n負責三條產品線：訂單、數據分析與行動 App。\n\n**How to apply:** 後端的取捨簡短說明就好，React 與 SQL 的基礎不用解釋。'],
    ['global', '', 'response-style', 'feedback', '回答先給結論再補細節，回覆要簡短', 6 * D,
      '先講答案或決定，再補充依據。\n\n**Why:** 都是在會議空檔看回覆。\n\n**How to apply:** 先寫一小段結論，需要時再列清單，不要寫冗長的開場白。'],
    ['global', '', 'git-conventions', 'feedback', '提交訊息用 conventional commits，不直接推到 main', 12 * D,
      '提交訊息用 conventional commits 格式（feat:、fix:、docs:）。\n\n**Why:** 版本說明是從提交歷史自動產生的。\n\n**How to apply:** 開分支再發 PR，不直接推到 main。'],
    ['global', '', 'review-checklist', 'reference', '送出程式碼審查之前要檢查的項目', 20 * D,
      '- 測試已新增或更新\n- 差異裡沒有金鑰或本機路徑\n- 資料庫遷移有退回的做法\n- 介面變更附上截圖'],
    ['global', '', 'date-format', 'feedback', '一律寫絕對日期（2026-10-22），不寫「昨天」', 25 * D,
      '日期寫成 2026-10-22 這種絕對日期。\n\n**Why:** 記憶會在幾週後、在另一台電腦上被讀到。'],
    ['global', '', 'secrets-policy', 'feedback', '不要記下金鑰的值，改記它存放在哪裡', 31 * D,
      '不要把權杖、密碼、連線字串寫進記憶，改記「存放在哪裡、怎麼取得」（例如 Windows 認證管理員裡的項目名稱）。'],
    ['project', 'order-service', 'order-status-rules', 'project', '訂單狀態的轉換規則，以及哪些轉換可以退回', 50,
      '狀態順序：已建立 → 已付款 → 已包裝 → 已出貨 → 已送達。\n\n- 已付款 → 已建立：只有 30 分鐘內可以（付款撤銷）\n- 已出貨之後不能退回\n\n**How to apply:** 修改 `OrderStatus` 之前先對照這張表。'],
    ['project', 'order-service', 'deploy-flow', 'project', '部署流程：main 合併後自動部署到 staging，正式環境要手動核准', 3 * H,
      '合併到 main 之後會自動部署到 staging。\n\n正式環境的部署要在流程裡手動核准（兩位審核者）。\n\n**How to apply:** 不要建議從筆電直接部署到正式環境。'],
    ['project', 'order-service', 'order-api-errors', 'reference', '訂單 API 回傳的錯誤碼與意思', 2 * D,
      '- ORD-001：找不到付款紀錄\n- ORD-002：不允許變更狀態\n- ORD-003：庫存已被另一張訂單保留'],
    ['project', 'order-service', 'order-api-pagination', 'project', '訂單 API 的分頁用游標，不用頁碼', 5 * D,
      '列表端點回傳 `next_cursor`。頁碼在 v3 已經移除。'],
    ['project', 'order-service', 'staging-db-access', 'reference', '怎麼連到 staging 資料庫（唯讀帳號的權杖）', 8 * D,
      'Staging 資料庫：`db-staging.internal`，連接埠 5432，唯讀帳號 `reporter`。'],
    ['project', 'order-service', 'test-data-reset', 'project', '跑整合測試之前，怎麼重設測試資料', 11 * D,
      '跑整合測試之前先執行 `npm run db:reset -- --seed small`，大約需要 40 秒。'],
    ['project', 'analytics-dashboard', 'kpi-definitions', 'reference', '儀表板使用的 KPI 定義（GMV、客單價、回購率、流失）', 26 * H,
      KPI_BODY()],
    ['project', 'analytics-dashboard', 'chart-color-rules', 'feedback', '圖表的主要數列用品牌藍，紅色只用在警示', 4 * D,
      '主要數列：#2563EB。紅色（#DC2626）只留給警示，不能當一般數列的顏色。'],
    ['project', 'analytics-dashboard', 'export-settings', 'project', '這台電腦的報表匯出路徑是 C:\\Reports\\exports', 9 * D,
      '排程匯出的檔案寫在 `C:\\Reports\\exports`，每晚 02:00 上傳。'],
    ['project', 'analytics-dashboard', 'timezone-handling', 'project', '時間一律存 UTC，顯示時換成檢視者的時區', 15 * D,
      '所有時間戳記都以 UTC 儲存，只在介面層轉換。'],
    ['project', 'mobile-app', 'release-checklist', 'project', 'App 上架檢查表（商店截圖、版本號、更新說明）', 2 * D,
      '1. 兩個平台的版本號都要更新\n2. 更新商店截圖\n3. 寫更新說明\n4. 打上發佈標籤'],
    ['project', 'mobile-app', 'push-notifications', 'project', '推播限制：行銷推播每週最多 2 則', 6 * D,
      '每位使用者每週最多收到 2 則行銷推播，交易通知不受限制。'],
    ['project', 'mobile-app', 'review-feedback', 'feedback', 'PR 控制在 400 行以內，審查才會快', 13 * D,
      '大型變更拆成幾個 400 行以內的 PR。\n\n**Why:** 大型 PR 的審查要花好幾天。'],
    ['project', 'data-pipeline', 'pipeline-schedule', 'project', '夜間管線 01:30 開始，必須在 06:00 前完成', 4 * D,
      '夜間作業 01:30 開始，下游報表在 06:00 讀取結果。'],
    ['project', 'data-pipeline', 'pipeline-retries', 'project', '失敗的步驟用指數退避重試三次', 18 * D,
      '每個步驟重試三次（間隔 1、4、16 分鐘）。'],
    ['project', 'data-pipeline', 'naming-feedback', 'feedback', '資料表名稱用來源系統當前綴', 22 * D,
      '資料表名稱以來源系統開頭，例如 `crm_customers`。'],
    ['project', 'marketing-site', 'seo-rules', 'project', 'SEO 規則：每頁一個 H1、圖片要有說明文字、設定 canonical 網址', 9 * D,
      '每頁只有一個 H1。每張圖片都要有描述性的替代文字。活動頁要設定 canonical 網址。'],
    ['project', 'marketing-site', 'cms-workflow', 'project', '內容要走 CMS 的草稿 → 審核 → 發佈流程', 30 * D,
      '編輯在 CMS 通過審核之後才能發佈。'],
    ['project', 'release-notes', 'release-notes-style', 'feedback', '版本說明：用使用者看得懂的話，新版在前', 17 * D,
      '版本說明是寫給使用者，不是寫給開發者。最新的版本放最前面。'],
    ['project', 'release-notes', 'old-template', 'reference', '舊的版本說明範本（2025 年已改版）', 120 * D,
      '2024 年的範本，最上面有「已知問題」一節。'],
    ['project', 'legacy-crm', 'crm-export-format', 'reference', '舊版 CRM 的匯出格式（CSV，分號分隔）', 140 * D,
      'CSV 以 `;` 分隔，編碼是 Windows-1252。'],
    ['machine', '', 'node-install-path', 'reference', 'Node.js 22 用 fnm 安裝，全域套件放在 fnm 資料夾', 7 * D,
      'Node.js 22 用 fnm 安裝。全域 npm 套件在 `%LOCALAPPDATA%\\fnm_multishells` 底下。'],
    ['machine', '', 'proxy-settings', 'reference', 'git 與 npm 使用的公司網路代理', 16 * D,
      'git 與 npm 透過公司代理 `http://proxy.acme.local:8080` 連線。'],
    ['machine', '', 'disk-layout', 'reference', 'C 槽是系統 SSD，大型專案與 Docker 資料放 D 槽', 40 * D,
      '大型專案與 Docker 資料放在 D 槽，節省 C 槽的空間。'],
  ];

  const memories = [];
  for (const [kind, key, name, type, description, minutes, body] of M) {
    const scope = kind === 'global' ? { kind } : kind === 'machine' ? { kind, mid: SELF.id } : { kind, pid: pidOf(key) };
    const dir = kind === 'global' ? 'global' : kind === 'machine' ? `machines/${SELF.id}` : `projects/${scope.pid}/memory`;
    const size = name === 'kpi-definitions' ? 46 * 1024 + 310 : 500 + (parseInt(hash(name, 2), 32) % 2200);
    memories.push({
      ref: `${dir}/${name}.md`, scope, name, description, type, size, updatedAt: ago(minutes),
      pinned: name === 'user-role', tags: [], indexed: true, findings: [], body,
    });
    if (kind === 'project') {
      const p = projects.find((x) => x.pid === scope.pid);
      p.counts.memories++;
      p.index.lines++;
      p.index.bytes += 90 + description.length;
    }
  }

  // 匯入計畫（合成）：三個來源，其中一個原資料夾已不存在
  const item = (file, type, action, scope, reason, dupOf) => ({ file, name: file.replace(/\.md$/, ''), type, action, scope, reason, ...(dupOf ? { dupOf } : {}) });
  const plan = {
    sources: [
      {
        encoded: 'C--Users-you-Projects-order-service', resolvedPath: 'C:\\Users\\you\\Projects\\order-service', how: 'transcript-cwd', exists: true,
        target: { pid: pidOf('order-service'), name: '訂單服務', isNew: true, archived: false },
        items: [
          item('order-status-rules.md', 'project', 'copy', 'project', ''),
          item('deploy-flow.md', 'project', 'copy', 'project', ''),
          item('response-style.md', 'feedback', 'copy', 'global', '適用所有專案'),
          item('order-api-errors.md', 'reference', 'copy', 'project', ''),
          item('staging-db-access.md', 'reference', 'copy', 'project', ''),
        ],
      },
      {
        encoded: 'C--Users-you-Projects-analytics-dashboard', resolvedPath: 'C:\\Users\\you\\Projects\\analytics-dashboard', how: 'origin-session', exists: true,
        target: { pid: pidOf('analytics-dashboard'), name: '數據分析儀表板', isNew: true, archived: false },
        items: [
          item('kpi-definitions.md', 'reference', 'copy', 'project', ''),
          item('chart-color-rules.md', 'feedback', 'copy', 'project', ''),
          item('response-style.md', 'feedback', 'skip-same', 'global', '這次匯入的另一個來源已有相同內容', 'global/response-style.md'),
          item('node-install-path.md', 'reference', 'copy', 'machine', '描述的是這台電腦本身'),
        ],
      },
      {
        encoded: 'C--Users-you-Projects-legacy-crm', resolvedPath: 'C:\\Users\\you\\Projects\\legacy-crm', how: 'decoded', exists: false,
        target: { pid: pidOf('legacy-crm'), name: '舊版 CRM', isNew: true, archived: true },
        items: [
          item('crm-export-format.md', 'reference', 'copy', 'project', ''),
          item('old-template.md', 'reference', 'superseded', 'project', '較舊的版本，內容留在原處', 'projects/release-notes/memory/old-template.md'),
        ],
      },
    ],
    totals: { sources: 3, memories: 11, copy: 9, skip: 2, global: 1, machine: 1, archived: 1, unknown: 1 },
  };

  return { generatedFrom: 'demo-sample-zh.mjs', now: new Date(now).toISOString(), self: SELF, other: OTHER, projects, memories, plan };
}

function KPI_BODY() {
  const rows = [
    ['GMV', '商品交易總額：已付款訂單金額加總，未扣除退款'],
    ['客單價', '平均每張訂單的金額：GMV 除以已付款訂單數'],
    ['回購率', '期間內下單兩次以上的顧客比例'],
    ['流失', '最近 180 天沒有下單的顧客'],
  ];
  const table = ['| KPI | 定義 |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
  const notes = Array.from({ length: 40 }, (_, i) => `- 備註 ${i + 1}：退款、分批出貨與幣別換算的例外情形，都在夜間作業裡處理。`).join('\n');
  return `${table}\n\n## 例外情形\n\n${notes}`;
}
