// R-51：綁定還原的自我測試（合成資料）。全部檢查都要通過，而且不能碰到這台電腦真實的 ~/.claude。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as engine from '../../src/core/index.mjs';
import { bindingSelfTest } from '../../src/migrate/selftest.mjs';
import { mkTmp, rmTmp } from '../core/helpers.mjs';

const realClaude = path.join(os.homedir(), '.claude');
const snapshot = () => ({
  settings: fs.existsSync(path.join(realClaude, 'settings.json')) ? fs.readFileSync(path.join(realClaude, 'settings.json'), 'utf8') : null,
  projects: fs.existsSync(path.join(realClaude, 'projects')) ? fs.readdirSync(path.join(realClaude, 'projects')).sort() : [],
});

test('綁定還原自我測試：全部通過，只寫入沙盒', async (t) => {
  const sandbox = mkTmp('engram-selftest-');
  t.after(() => rmTmp(sandbox));
  const before = snapshot();
  const r = await bindingSelfTest({ engine, sandbox });
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok), null, 2));
  assert.ok(r.checks.length >= 12);
  // 每項檢查都附英文名稱與說明（管理介面切到英文時顯示）
  for (const c of r.checks) {
    assert.deepEqual(Object.keys(c), ['name', 'ok', 'detail', 'en']);
    assert.deepEqual(Object.keys(c.en), ['name', 'detail']);
    assert.ok(c.en.name && !/[一-鿿]/.test(c.en.name), c.name);
    assert.doesNotMatch(c.en.detail, /[一-鿿]/, c.name);
  }
  assert.deepEqual(snapshot(), before, '真實的 ~/.claude 不能被改動');
});
