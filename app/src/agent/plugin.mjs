// Claude Code 外掛的安裝狀態與技能清單：管理介面「交給 Claude」的引導用。
// 只讀 Claude Code 的使用者設定與 Engram 自己的技能資料夾，不改任何檔案、不呼叫 claude 指令。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseMemoryFile } from '../core/frontmatter.mjs';
import { APP_DIR } from '../cli/paths.mjs';

export const PLUGIN_ID = 'engram@engram-local';

async function readJson(file) {
  try { return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; }
}

/** 外掛裡的技能：{ name, command, description, argumentHint } */
export async function listSkills(appDir = APP_DIR) {
  const dir = path.join(appDir, 'plugin', 'skills');
  const out = [];
  for (const d of (await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const text = await fsp.readFile(path.join(dir, d.name, 'SKILL.md'), 'utf8').catch(() => null);
    if (text === null) continue;
    const fm = parseMemoryFile(text).data ?? {};
    const name = String(fm.name || d.name);
    out.push({ name, command: `/engram:${name}`, description: String(fm.description ?? ''), argumentHint: fm['argument-hint'] ? String(fm['argument-hint']) : null });
  }
  return out;
}

/**
 * state：ready（已安裝並啟用）、disabled（安裝了但被停用）、missing（沒有安裝）
 * commands：讓使用者在終端機執行就能修好的指令
 */
export async function claudePluginStatus({ claudeHome, installFile, appDir = APP_DIR }) {
  const settings = await readJson(path.join(claudeHome, 'settings.json'));
  const installed = await readJson(path.join(claudeHome, 'plugins', 'installed_plugins.json'));
  const flag = settings?.enabledPlugins?.[PLUGIN_ID];
  const known = flag !== undefined || !!installed?.plugins?.[PLUGIN_ID];
  const state = flag === true ? 'ready' : known ? 'disabled' : 'missing';
  // 外掛來源要指向 ~/.engram/app/current（engram update 換版後自動跟上），不是這一版的資料夾
  const source = (await readJson(installFile))?.appDir ?? appDir;
  const commands = state === 'ready' ? [] : state === 'disabled' ? [`claude plugin enable ${PLUGIN_ID}`] : [`claude plugin marketplace add "${source}"`, `claude plugin install ${PLUGIN_ID} --scope user`];
  return { state, plugin: PLUGIN_ID, commands, skills: await listSkills(appDir) };
}
