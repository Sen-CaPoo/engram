import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSecrets, SECRET_KINDS } from '../../src/core/secrets.mjs';

// 測試用的假金鑰一律在執行時拼接，原始碼裡不出現完整格式，避免觸發 GitHub 推送保護
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const pick = (n, alphabet = B62) => Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
const j = (...parts) => parts.join('');

const kinds = (text) => scanSecrets(text).map((h) => h.kind);

test('SECRET_KINDS 列出所有種類且不重複', () => {
  const ks = SECRET_KINDS.map((k) => k.kind);
  assert.equal(new Set(ks).size, ks.length);
  for (const k of SECRET_KINDS) assert.ok(k.label);
});

const POSITIVES = {
  'anthropic-api-key': () => `key ${j('sk', '-ant-', 'api03-', pick(40))}`,
  'openai-api-key': () => `OPENAI_API_KEY=${j('sk', '-proj-', pick(48))}`,
  'github-token': () => `用 ${j('gh', 'p_', pick(36))} 呼叫`,
  'github-pat': () => j('github', '_pat_', pick(22), '_', pick(59)),
  'slack-token': () => j('xo', 'xb-', '1234567890-', pick(24)),
  'aws-access-key-id': () => `aws ${j('AK', 'IA', pick(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'))}`,
  'google-api-key': () => j('AI', 'za', pick(35)),
  'private-key': () => j('-----BEGIN ', 'RSA PRIVATE KEY-----\n', pick(64), '\n', pick(64), '\n-----END RSA PRIVATE KEY-----'),
  jwt: () => j('ey', 'J', pick(20), '.ey', 'J', pick(30), '.', pick(43)),
  'url-credentials': () => `postgres://demo:${pick(12)}@db.internal:5432/app`,
  'bearer-token': () => `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${pick(48)}`,
  'connection-string': () => `Server=sql01;Database=coupon;User ID=app;Password=${pick(10)}9;`,
  'credential-assignment': () => 'password: Acme@2026!x',
  'high-entropy': () => `blob ${pick(44)} end`,
};

for (const [kind, make] of Object.entries(POSITIVES)) {
  test(`偵測：${kind}`, () => {
    const text = make();
    const hits = scanSecrets(text);
    assert.ok(hits.some((h) => h.kind === kind), `預期 ${kind}，實際 ${JSON.stringify(hits.map((h) => h.kind))}`);
  });
}

test('預覽只露出前四個字元與長度，絕不含完整值', () => {
  const token = j('gh', 'p_', pick(36));
  const [hit] = scanSecrets(`token ${token}`);
  assert.equal(hit.preview, `${token.slice(0, 4)}…(${token.length})`);
  assert.ok(!hit.preview.includes(token.slice(4, 12)));
});

test('回報值所在的行與欄（從 1 開始）', () => {
  const token = j('gh', 'o_', pick(36));
  const [hit] = scanSecrets(`第一行\n  key=${token}\n`);
  assert.equal(hit.line, 2);
  assert.equal(hit.column, 7);
});

test('重疊時只回報最具體的種類', () => {
  assert.deepEqual(kinds(`token: ${j('gh', 'p_', pick(36))}`), ['github-token']);
  assert.deepEqual(kinds(`Authorization: Bearer ${j('ey', 'J', pick(20), '.ey', 'J', pick(30), '.', pick(43))}`), ['jwt']);
  assert.deepEqual(kinds(`Password=${pick(12)}x9`), ['connection-string']);
});

test('中文密碼指定式', () => {
  assert.deepEqual(kinds('資料庫密碼：Shop@Coupon2026，請勿外流'), ['credential-assignment']);
  assert.deepEqual(kinds('金鑰=Az9xQ7mK2p'), ['credential-assignment']);
});

test('排除：UUID、git SHA、雜湊', () => {
  assert.deepEqual(kinds('originSessionId: fdd5c578-1323-48c5-8a09-c9deccf342c9'), []);
  assert.deepEqual(kinds('commit 598911c 與 2068cdc1f4e0a9b7c3d5e6f708192a3b4c5d6e7f'), []);
  assert.deepEqual(kinds('sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'), []);
});

test('排除：不含帳密的網址、路徑、slug、Markdown 連結', () => {
  assert.deepEqual(kinds('https://github.com/anthropics/claude-code/issues/61349?tab=comments'), []);
  assert.deepEqual(kinds('C:\\Users\\Someone\\.claude\\projects\\C--Users-Someone-Desktop-Demo-Gateway\\memory\\MEMORY.md'), []);
  assert.deepEqual(kinds('/c/Users/Someone/AppData/Local/Temp/claude/C--Users-Someone-Desktop-Demo-77ad443c-331d-4c29-8ee5-08d43caa2532-scratchpad'), []);
  assert.deepEqual(kinds('pid: demo-gateway-3fa9k，檔名 demo-spendlogs-request-id-collision-v2-final-notes.md'), []);
  assert.deepEqual(kinds('- [LINE MCP install](line-desktop-mcp-install.md) — v3.3.8 paths'), []);
  assert.deepEqual(kinds('AcmeCoreMgrValueCouponServiceImplementation2'), []);
});

test('排除：佔位字串與環境變數參照', () => {
  for (const text of [
    'password: <your-password>',
    'password: ********',
    'api_key = ${OPENAI_API_KEY}',
    'token: $GITHUB_TOKEN',
    'secret: %CLIENT_SECRET%',
    'api-key: your-api-key-here',
    'password=example123',
    'token: xxxxxxxxxxxx',
    'Authorization: Bearer <token>',
    'Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'postgres://user:password@localhost/db',
    'Password=${DB_PASSWORD};',
    'api_key: LITELLM_MASTER_KEY',
    'token: process.env.GITHUB_TOKEN',
    'token: 2000',
    'secret: true',
    'token: required',
    '`{api_key:*}:demo`',
    'sk-this-is-not-a-real-key-name',
  ]) {
    assert.deepEqual(kinds(text), [], text);
  }
});

test('真實風格的記憶檔不應誤報', () => {
  const memory = `---
name: demo-desktop-tool-install
description: "Demo Desktop Tool (example v1.2.3) installed 2026-10-18 in C:\\\\Users\\\\Someone\\\\Desktop\\\\demo"
metadata:
  node_type: memory
  type: project
  originSessionId: 00000000-1111-4222-8333-444455556666
  modified: 2026-10-18T13:41:30.055Z
---

Installed v1.2.3 at C:\\Users\\Someone\\Desktop\\demo\\demo-desktop-tool (venv in \`.venv\`).
修復 commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0，PR #42 從 fork 分支 fix/sample-layout-wrap-textbox 開出。
金鑰存放位置：Azure Key Vault「demo-kv-prod」的 secret「demo-master-key」，不要寫入記憶。
**Why:** runtime 0.9.1 was chosen.
**How to apply:** If reads fail with \`LINE_BUILD_UNVERIFIED\`, upgrade.
`;
  assert.deepEqual(scanSecrets(memory), []);
});

test('空輸入', () => {
  assert.deepEqual(scanSecrets(''), []);
  assert.deepEqual(scanSecrets(undefined), []);
});

test('審查 M8：明確寫成金鑰的 32 位以上十六進位值（Azure OpenAI／APIM 的格式）照樣偵測；短的 commit 片段與沒有金鑰名稱的雜湊不算', () => {
  const hex32 = pick(32, '0123456789abcdef');
  assert.deepEqual(kinds(j('AZURE_OPENAI_API_KEY=', hex32)), ['credential-assignment']);
  assert.deepEqual(kinds(j('api_key: ', hex32)), ['credential-assignment']);
  assert.deepEqual(kinds(j('金鑰：', hex32)), ['credential-assignment']);
  assert.deepEqual(kinds(j('token: ', pick(7, '0123456789abcdef'))), []);
  assert.deepEqual(kinds(j('commit ', pick(40, '0123456789abcdef'))), []);
});

test('審查 N10：AZURE_OPENAI_KEY=、Ocp-Apim-Subscription-Key:、access_key 這類設定名稱也算金鑰', () => {
  const hex32 = pick(32, '0123456789abcdef');
  assert.deepEqual(kinds(j('AZURE_OPENAI_KEY=', hex32)), ['credential-assignment']);
  assert.deepEqual(kinds(j('Ocp-Apim-Subscription-Key: ', hex32)), ['credential-assignment']);
  assert.deepEqual(kinds(j('aws_secret_access_key = ', pick(24))), ['credential-assignment']);
  assert.deepEqual(kinds('primary_key: user_id'), [], '資料庫欄位說明不算');
});

test('審查 P1：資料庫與程式裡一般的 *_key 不算金鑰（會員、錢包系統常寫到）', () => {
  for (const t of ['primary_key: UserId', 'sort_key=CreatedAt', 'partition_key: TenantCode', 'cache_key = "user:123:profile"', 'foreign_key: OrderId',
    'blob_key: invoices/2026-10/A001.pdf', 's3_object_key: reports/2026/Q3.pdf', 'idempotency_key: Order-2026-1023']) {
    assert.deepEqual(kinds(t), [], t);
  }
  // 大寫設定名稱與明確種類的前綴，值是欄位名稱、路徑、快取鍵、識別名稱時也不算（第 4 輪 r40）
  for (const t of ['GROUP_BY_KEY=DeptCode', 'SORT_KEY=CreatedAt', 'PARTITION_KEY: TenantCode', 'PRIMARY_KEY=UserId', 'CACHE_KEY="user:123:profile"',
    'S3_OBJECT_KEY=reports/2026/Q3.pdf', 'I18N_KEY=Checkout.Title', 'app_key: AppTitle', 'client_key: CustomerNo', 'admin_key: AdminPortal', 'storage_key: Invoices2026']) {
    assert.deepEqual(kinds(t), [], t);
  }
  const v = j('Xk29aLpQ', '0zR7vB3n', 'T8wE1yUo');
  assert.deepEqual(kinds(j('openai_key: ', v)), ['credential-assignment']);
  assert.deepEqual(kinds(j('azure_openai_key=', v)), ['credential-assignment']);
  assert.deepEqual(kinds('password: Welcome2026'), ['credential-assignment'], '密碼類的規則不排除 PascalCase：弱密碼要抓得到');
  assert.deepEqual(kinds(j('client_key: ', v)), ['credential-assignment']);
  assert.deepEqual(kinds(j('STRIPE_KEY=', v)), ['credential-assignment']);
});

test('審查 N3：記錄「存放位置」的寫法不可以被當成金鑰（Engram 自己就建議這樣寫）', () => {
  for (const t of ['公司 VPN 密碼在 1Password 裡的「公司 VPN」項目', '密碼是 1Password 裡的項目', 'GitHub 權杖存在 KeyVault，名稱 github-ci', '密碼為 Windows 認證管理員的 LiteLLM 項目', '金鑰在 Bitwarden']) {
    assert.deepEqual(kinds(t), [], t);
  }
});
