#!/usr/bin/env node
// engram 指令進入點：依子指令分派到 app/src/cli/。
import { main } from '../src/cli/main.mjs';

const code = await main(process.argv.slice(2));
if (code !== null) {
  // 等輸出寫完再結束；不等待其他殘留的計時器或連線
  process.stdout.write('', () => process.exit(code));
}
