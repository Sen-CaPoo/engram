// 英文對照表：每個介面原始檔一份，這裡合併。新增檔案時記得加進來（i18n 測試會檢查沒有漏掉）。
import common from './common.js';
import overview from './overview.js';
import library from './library.js';
import inbox from './inbox.js';
import projects from './projects.js';
import devices from './devices.js';
import core from './core.js';
import schedule from './schedule.js';
import importView from './import.js';
import settings from './settings.js';
import askclaude from './askclaude.js';
import editor from './editor.js';
import tidy from './tidy.js';

export const PARTS = { common, overview, library, inbox, projects, devices, core, schedule, import: importView, settings, askclaude, editor, tidy };

export default Object.assign({}, ...Object.values(PARTS));
