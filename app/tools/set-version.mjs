// 版本號單一來源：app/package.json 的 version。其他位置（外掛設定、市集設定、問題回報範本、兩份 README 的版本徽章、安全政策）都靠這支工具一次改完。
// 用法：node app/tools/set-version.mjs <版本>   例：node app/tools/set-version.mjs 2.0.0
// 只做文字取代（不重新序列化 JSON），沒改到的位元組原樣保留；每個位置都必須剛好比對到預期的次數，否則整批不寫入並說明哪裡對不上。
// 引擎的 ENGINE_VERSION 讀 app/package.json（core/vault.mjs），所以不需要在這裡改。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * 每個位置：檔案（相對於 repo 根目錄）、要取代的正規表示式、預期的比對次數、取代成什麼。
 * 取代用的正規表示式都把「不變的前後文」放在群組裡，只換版本。
 */
const TARGETS = [
  { file: 'app/package.json', re: /("version"\s*:\s*")\d+\.\d+\.\d+(")/g, count: 1, to: (v) => `$1${v}$2` },
  { file: 'app/plugin/.claude-plugin/plugin.json', re: /("version"\s*:\s*")\d+\.\d+\.\d+(")/g, count: 1, to: (v) => `$1${v}$2` },
  { file: 'app/.claude-plugin/marketplace.json', re: /("version"\s*:\s*")\d+\.\d+\.\d+(")/g, count: 1, to: (v) => `$1${v}$2` },
  { file: '.github/ISSUE_TEMPLATE/bug_report.yml', re: /(placeholder:\s*engram )\d+\.\d+\.\d+/g, count: 1, to: (v) => `$1${v}` },
  // README 的版本徽章：替代文字（版本／Version X.Y.Z）與徽章網址（badge/version-X.Y.Z-色碼）各一處
  { file: 'README.md', re: /(alt="版本 )\d+\.\d+\.\d+/g, count: 1, to: (v) => `$1${v}` },
  { file: 'README.md', re: /(img\.shields\.io\/badge\/version-)\d+\.\d+\.\d+/g, count: 1, to: (v) => `$1${v}` },
  { file: 'README.en.md', re: /(alt="Version )\d+\.\d+\.\d+/g, count: 1, to: (v) => `$1${v}` },
  { file: 'README.en.md', re: /(img\.shields\.io\/badge\/version-)\d+\.\d+\.\d+/g, count: 1, to: (v) => `$1${v}` },
  // 安全政策的支援版本表（中英各一張）：目前的次版本線「X.Y.x 支援」，更舊的「< X.Y 不支援」
  { file: 'SECURITY.md', re: /(\| )\d+\.\d+(\.x \| (?:支援|Supported) \|)/g, count: 2, to: (v) => `$1${v.split('.').slice(0, 2).join('.')}$2` },
  { file: 'SECURITY.md', re: /(\| < )\d+\.\d+( \| (?:不支援|Not supported))/g, count: 2, to: (v) => `$1${v.split('.').slice(0, 2).join('.')}$2` },
];

/** 讀出目前各位置記錄的版本（給一致性檢查與測試用）。 */
export function readVersions(rootDir) {
  const found = {};
  const take = (file, re) => {
    const text = fs.readFileSync(path.join(rootDir, file), 'utf8');
    return [...text.matchAll(re)].map((m) => m[1]);
  };
  found['app/package.json'] = take('app/package.json', /"version"\s*:\s*"(\d+\.\d+\.\d+)"/g);
  found['app/plugin/.claude-plugin/plugin.json'] = take('app/plugin/.claude-plugin/plugin.json', /"version"\s*:\s*"(\d+\.\d+\.\d+)"/g);
  found['app/.claude-plugin/marketplace.json'] = take('app/.claude-plugin/marketplace.json', /"version"\s*:\s*"(\d+\.\d+\.\d+)"/g);
  found['.github/ISSUE_TEMPLATE/bug_report.yml'] = take('.github/ISSUE_TEMPLATE/bug_report.yml', /placeholder:\s*engram (\d+\.\d+\.\d+)/g);
  for (const f of ['README.md', 'README.en.md']) found[f] = take(f, /(?:alt="(?:版本|Version) |img\.shields\.io\/badge\/version-)(\d+\.\d+\.\d+)/g);
  found['SECURITY.md'] = take('SECURITY.md', /\| (\d+\.\d+)\.x \| (?:支援|Supported) \|/g);
  return found;
}

/**
 * 把 rootDir（repo 根目錄）底下所有位置改成指定版本。
 * @returns {string[]} 有改動的檔案（相對路徑）
 */
export function setVersion(rootDir, version) {
  if (!SEMVER.test(String(version))) throw new Error(`版本必須是 X.Y.Z 的格式（例如 2.0.0）：${version}`);
  const texts = new Map();
  for (const t of TARGETS) {
    const file = path.join(rootDir, t.file);
    if (!texts.has(t.file)) texts.set(t.file, { before: fs.readFileSync(file, 'utf8') });
    const cur = texts.get(t.file);
    cur.after ??= cur.before;
    const n = [...cur.after.matchAll(t.re)].length;
    if (n !== t.count) throw new Error(`${t.file}：預期找到 ${t.count} 處版本號，實際 ${n} 處；請先檢查檔案內容有沒有被改動`);
    cur.after = cur.after.replace(t.re, t.to(version));
  }
  const changed = [];
  for (const [file, { before, after }] of texts) {
    if (after === before) continue;
    fs.writeFileSync(path.join(rootDir, file), after);
    changed.push(file);
  }
  return changed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  const rootDir = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  try {
    const changed = setVersion(rootDir, version);
    console.log(changed.length ? `已改成 ${version}：\n${changed.map((f) => `  ${f}`).join('\n')}` : `所有位置已經是 ${version}，沒有改動`);
  } catch (err) {
    console.error(`錯誤：${err.message}`);
    console.error('用法：node app/tools/set-version.mjs <版本>   例：node app/tools/set-version.mjs 2.0.0');
    process.exit(1);
  }
}
