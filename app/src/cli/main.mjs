// engram 指令的分派：解析子指令與選項，交給 commands/ 裡對應的函式。
// 回傳結束碼；回傳 null 表示程序要繼續執行（engram agent）。
import { parseCommandArgs } from './args.mjs';
import { cmdInbox } from './commands/inbox.mjs';
import { cmdCore, cmdMemory, cmdNotSecret, cmdRemember, cmdSearch, cmdUndo } from './commands/memory.mjs';
import { cmdAgent, cmdDoctor, cmdHook, cmdInstall, cmdMergeDriver, cmdSchedule, cmdUi, cmdUninstall, cmdUpdate, cmdVersion } from './commands/system.mjs';
import { cmdTidy } from './commands/tidy.mjs';
import { cmdDream } from './commands/dream.mjs';
import { cmdAutopilot, cmdSecret } from './commands/autopilot.mjs';
import { cmdBind, cmdCollisions, cmdImport, cmdProjects, cmdStatus, cmdSync, cmdUnbind } from './commands/vault.mjs';
import { loadEngine } from './engine.mjs';
import { CliError } from './errors.mjs';
import { createOutput } from './output.mjs';

const str = { type: 'string' };
const bool = { type: 'boolean' };

// neverFail：給 Claude Code 與 git 呼叫的指令，任何情況都 exit 0
// args：位置參數的上限（數字）；有子指令的用 { 子指令: 上限 }（'' 是不加子指令），上限不含子指令本身。
// 多出來的參數一律回 E_USAGE（1.4.1）：原本各指令只取第一個，例如 inbox dismiss a b、memory remove a b 會默默只處理 a。
export const COMMANDS = {
  status: { run: cmdStatus, args: 0, usage: 'status', summary: '這台電腦、目前資料夾的綁定與同步狀態' },
  sync: { run: cmdSync, args: 0, options: { local: bool, debounce: str, quiet: bool }, usage: 'sync [--local] [--debounce 30s] [--quiet]', summary: '立即同步；--local 只做本機存檔' },
  bind: { run: cmdBind, args: 1, options: { pid: str, create: str }, usage: 'bind [資料夾] [--pid <pid> | --create <名稱>]', summary: '把資料夾綁定到專案' },
  unbind: { run: cmdUnbind, args: 1, usage: 'unbind [資料夾]', summary: '解除綁定，記憶複製回 Claude Code 原本的資料夾' },
  projects: { run: cmdProjects, args: 0, usage: 'projects', summary: '列出所有專案' },
  search: { run: cmdSearch, args: Infinity, options: { limit: str }, usage: 'search <關鍵字> [--limit 10]', summary: '搜尋所有範圍的記憶' },
  remember: {
    run: cmdRemember,
    args: 0,
    options: { scope: str, name: str, description: str, type: str, body: str, project: str, file: str, reviewed: bool },
    usage: 'remember --scope global|machine|project --name <名稱> --type user|feedback|project|reference --description <說明> [--project <pid>] [--body <內文> | --file <檔案>] [--reviewed]',
    summary: '寫入一筆記憶（內文可從標準輸入或 --file 傳入）；--reviewed：使用者已經看過並同意這段內容',
  },
  inbox: {
    run: cmdInbox,
    args: { '': 0, show: Infinity, apply: 1, dismiss: Infinity, resolve: 1 },
    options: { all: bool, fix: str, yes: bool, days: str, choice: str, file: str },
    usage: 'inbox [--all] | show <id>... | apply <id> [--fix <n>] [--yes] | dismiss <id>... [--days <n>] | resolve <衝突 id> --choice ours|theirs|both|manual [--file <檔案>]',
    summary: '收件匣：列出衝突與健康檢查、看完整內容、套用修正、忽略或延後、處理衝突（manual 的內容從標準輸入或 --file 傳入）',
  },
  memory: {
    run: cmdMemory,
    args: { list: 0, show: Infinity, write: 1, move: 1, remove: 1, merge: Infinity },
    options: { scope: str, project: str, type: str, base: str, to: str, into: str, file: str, reviewed: bool },
    usage: 'memory list [--project <pid> | --scope global|machine|project] [--type <類型>] | show <ref>... | write <ref> [--base <版本>] [--file <檔案>] [--reviewed] | move <ref> --to global|machine[:<mid>]|project:<pid> | remove <ref> | merge <ref> <ref>... [--into <ref>] [--base <版本,...>] [--file <檔案>]',
    summary: '列出、讀取（遮蔽金鑰）、改寫、移動、封存、合併記憶；write 與 merge 的內容從標準輸入或 --file 傳入（~/.engram/local/drafts/ 底下的草稿用完即刪）',
  },
  tidy: {
    run: cmdTidy,
    args: { create: 0, list: 0, show: 1, apply: 1, done: 2 },
    options: { file: str, undo: str, skip: bool, message: str },
    usage: 'tidy create --file <計畫.json> | list | show <id> | apply <id> | done <id> <項目> [--undo <版本,...>] [--skip] [--message <說明>]',
    summary: '記憶整理：把 Claude 的整理計畫存成整理記錄，使用者在管理介面逐項決定後照決定執行（/engram:tidy、/engram:tidy-apply 技能使用）',
  },
  dream: {
    run: cmdDream,
    args: { status: 1, prepare: 1, done: 1, reset: 1, list: 0 },
    options: { sessions: str, since: str, skip: str },
    usage: 'dream status [project:<pid>] | prepare [project:<pid>] [--sessions 20] [--since YYYY-MM-DD] | done <回顧編號> [--skip <session,...>] | reset <回顧編號> | list',
    summary: '對話回顧：把這台電腦還沒回顧的對話轉成精簡文字（只在本機），讓 Claude 拿來驗證記憶、補上漏記的事（/engram:dream 技能使用）',
  },
  autopilot: {
    run: cmdAutopilot,
    args: { '': 0, status: 0, on: 0, off: 0, run: 0, runs: 0, show: 1, undo: 2, budget: 1, resume: 1 },
    options: { force: bool, wait: bool },
    usage: 'autopilot [status] | on | off | run [--wait] [--force] | runs | show <執行編號> | undo <執行編號> [<項目編號>] | resume <類別> | budget <美元>',
    summary: '自動駕駛：AI 自主判斷並處理收件匣、記憶整理與對話回顧（不需要你逐項確認，每一項都可以復原）',
  },
  secret: { run: cmdSecret, args: { '': 0, list: 0, get: 1 }, usage: 'secret list | get <名稱>', summary: '本機保管區：自動駕駛從記憶移出來的金鑰（只在這台電腦、加密保存）' },
  core: { run: cmdCore, args: { '': 0, write: 0 }, options: { base: str, file: str }, usage: 'core | core write [--base <版本>] [--file <檔案>]', summary: '讀取核心準則 CORE.md；write 從標準輸入或 --file 寫入' },
  undo: { run: cmdUndo, args: 1, usage: 'undo <版本>', summary: '復原一次寫入、移動、封存、合併或衝突處理' },
  'not-secret': {
    run: cmdNotSecret,
    args: 1,
    options: { value: str, line: str, list: bool, remove: str },
    usage: 'not-secret --value <值> | not-secret <ref> --line <行號> | not-secret --list | not-secret --remove <雜湊>',
    summary: '確認被判定為疑似金鑰的值其實不是金鑰：記入會同步到所有電腦的「不是金鑰」清單（只存雜湊）。新增只能由你在自己的終端機執行，不能在 Claude Code 裡執行；--remove 撤銷',
  },
  doctor: { run: cmdDoctor, args: 0, options: { probe: bool }, usage: 'doctor [--probe]', summary: '檢查環境；--probe 另外執行 Claude Code 相容性探測' },
  ui: { run: cmdUi, args: 0, usage: 'ui', summary: '開啟管理介面（常駐程式沒在跑就先啟動）' },
  agent: { run: cmdAgent, args: 0, options: { port: str }, usage: 'agent [--port 4777]', summary: '在前景執行常駐程式' },
  import: { run: cmdImport, args: { plan: 0, apply: 0, undo: 1 }, options: { yes: bool }, usage: 'import plan | apply --yes | undo <tag>', summary: '匯入舊的 Claude Code 記憶' },
  collisions: { run: cmdCollisions, args: { '': 0, apply: 0, undo: 1 }, usage: 'collisions [apply | undo <id>]', summary: '撞名的資料夾：列出建議的新名稱；apply 依命名規則改名；undo 整批還原' },
  schedule: { run: cmdSchedule, args: { install: 0, remove: 0, status: 0 }, options: { launcher: str }, usage: 'schedule install|remove|status [--launcher wscript|conhost|direct]', summary: '管理登入工作 \\Engram\\Agent' },
  install: {
    run: cmdInstall,
    args: 0,
    options: { remote: str, 'create-remote': bool, local: bool, label: str, launcher: str, yes: bool, 'dry-run': bool, 'no-schedule': bool, 'no-plugin': bool, 'no-cli': bool, dev: bool },
    usage: 'install [--remote <url> | --create-remote | --local] [--label <電腦名稱>] [--launcher wscript|conhost|direct] [--yes] [--dry-run] [--no-schedule] [--no-plugin] [--no-cli] [--dev]',
    summary: '在這台電腦安裝 Engram（先列出計畫並取得同意）；不指定記憶庫時，用 gh 找你 GitHub 上的 engram-vault，沒有就建立',
  },
  uninstall: { run: cmdUninstall, args: 0, options: { purge: bool, 'keep-vault': bool, 'dry-run': bool, yes: bool }, usage: 'uninstall [--purge] [--dry-run] [--yes]', summary: '依安裝紀錄把這台電腦還原到安裝前（預設保留記憶庫；--purge 連記憶庫一起刪除）' },
  update: { run: cmdUpdate, args: 0, options: { rollback: bool, from: str }, usage: 'update [--rollback] [--from <資料夾>]', summary: '部署新版本的 Engram 程式；--rollback 切回上一版' },
  hook: { run: cmdHook, neverFail: true, usage: 'hook <事件>', summary: '給 Claude Code hooks 呼叫（從標準輸入讀 JSON）' },
  'merge-driver': { run: cmdMergeDriver, neverFail: true, usage: 'merge-driver %O %A %B %P', summary: '給 git 呼叫的記憶合併器' },
  version: { run: cmdVersion, args: 0, usage: 'version', summary: '顯示版本' },
  help: { run: cmdHelp, args: 1, usage: 'help [指令]', summary: '顯示說明' },
};

const GROUPS = [
  ['記憶', ['search', 'remember']],
  ['自動駕駛', ['autopilot', 'secret']],
  ['整理（給 Claude Code 的 /engram 技能使用，也可以自己執行）', ['inbox', 'tidy', 'dream', 'memory', 'core', 'undo', 'not-secret']],
  ['專案與同步', ['status', 'sync', 'bind', 'unbind', 'projects', 'import', 'collisions']],
  ['管理', ['ui', 'agent', 'doctor', 'schedule', 'install', 'update', 'uninstall']],
  ['其他', ['hook', 'merge-driver', 'version', 'help']],
];

export function helpText(name) {
  const c = COMMANDS[name];
  if (c) return `用法：engram ${c.usage}\n${c.summary}\n\n加上 --json 輸出機器可讀的 JSON。\n`;
  const lines = ['Engram 憶跡：Claude Code 個人記憶的跨裝置同步與管理', '', '用法：engram <指令> [選項]', ''];
  for (const [title, names] of GROUPS) {
    lines.push(title);
    for (const n of names) lines.push(`  ${COMMANDS[n].usage}`, `      ${COMMANDS[n].summary}`);
    lines.push('');
  }
  lines.push('每個指令都支援 --json 輸出機器可讀的 JSON；engram <指令> --help 查看單一指令。');
  return `${lines.join('\n')}\n`;
}

async function cmdHelp(ctx) {
  const name = ctx.args[0];
  if (name && !COMMANDS[name]) throw new CliError('E_USAGE', `沒有這個指令：${name}`);
  if (ctx.out.json) ctx.out.result({ commands: Object.fromEntries(Object.entries(COMMANDS).map(([k, c]) => [k, { usage: c.usage, summary: c.summary }])) });
  else ctx.io.stdout.write(helpText(name));
}

const ALIASES = { '--help': 'help', '-h': 'help', '--version': 'version', '-v': 'version' };

/**
 * 超出指令宣告上限的位置參數（沒有宣告、或子指令不認得時回傳空陣列，交給指令本身處理）。
 * @param {number|Record<string, number>|undefined} spec
 * @param {string[]} args
 */
export function extraArgs(spec, args) {
  if (spec === undefined) return [];
  if (typeof spec === 'number') return args.slice(spec);
  const [sub, ...rest] = args;
  const max = Object.hasOwn(spec, sub ?? '') ? spec[sub ?? ''] : undefined;
  return max === undefined ? [] : rest.slice(max);
}

/**
 * @param {string[]} argv  子指令與選項（不含 node 與腳本路徑）
 * @param {{ loadEngine?, stdout?, stderr?, stdin?, cwd?, scheduler?, runProbe?, spawnNode?, openUrl? }} [deps]  測試時注入
 * @returns {Promise<number|null>}
 */
export async function main(argv, deps = {}) {
  const io = { stdout: deps.stdout ?? process.stdout, stderr: deps.stderr ?? process.stderr, stdin: deps.stdin ?? process.stdin };
  const [first = 'help', ...rest] = argv;
  const name = ALIASES[first] ?? first;
  const cmd = COMMANDS[name];
  const out = createOutput({ json: rest.includes('--json'), ...io });
  if (!cmd) {
    out.error(new CliError('E_USAGE', `沒有這個指令：${first}`));
    return 2;
  }
  try {
    const { opts, args } = parseCommandArgs(rest, cmd.options);
    if (opts.help) {
      io.stdout.write(helpText(name));
      return 0;
    }
    if (!cmd.neverFail) {
      const extra = extraArgs(cmd.args, args);
      if (extra.length) throw new CliError('E_USAGE', `多了用不到的參數：${extra.join(' ')}`, `用法：engram ${cmd.usage}`).withEn(`Unexpected extra arguments: ${extra.join(' ')}`, `Usage: engram ${cmd.usage}`);
    }
    let engine;
    const ctx = {
      opts,
      args,
      out,
      io,
      deps,
      cwd: deps.cwd ?? process.cwd(),
      engine: () => (engine ??= (deps.loadEngine ?? loadEngine)()),
    };
    const code = await cmd.run(ctx);
    return code === undefined ? 0 : code;
  } catch (err) {
    if (cmd.neverFail) return 0;
    out.error(err);
    return err?.code === 'E_USAGE' ? 2 : 1;
  }
}
