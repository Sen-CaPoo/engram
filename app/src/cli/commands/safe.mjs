// 給 Claude 讀寫記憶時共用的安全措施：輸出前在本機遮蔽疑似金鑰（M5）、
// 以「版本」（內容雜湊）防止覆蓋掉讀取之後別人做的修改、寫入前檢查 frontmatter。
import { createHash } from 'node:crypto';
import { parseMemoryFile } from '../../core/frontmatter.mjs';
import { scopeOfRef } from '../../core/memories.mjs';
import { redactSecrets } from '../../core/secrets.mjs';
import { CliError } from '../errors.mjs';

/** 內容的版本：sha1 前 10 碼。engram memory show 印出，write／merge 的 --base 用來比對 */
export const revOf = (text) => createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 10);

/** 是記憶檔（不是索引、綁定或其他檔案） */
export function isMemoryRef(ref) {
  return !!scopeOfRef(ref) && !/(^|\/)(MEMORY|INDEX)\.md$/i.test(String(ref));
}

/** 讀一筆記憶給 Claude 看：疑似金鑰一律遮蔽（使用者標記「不是金鑰」的除外） */
export async function readSafe(eg, ref) {
  try {
    const p = await eg.secrets.preview(ref);
    return { ref, exists: true, rev: revOf(p.before), text: p.after, redacted: p.matches.length };
  } catch (err) {
    if (err?.code === 'E_NOT_FOUND') return { ref, exists: false };
    throw err;
  }
}

/** 不是記憶檔的文字（衝突的兩邊版本、卡片說明、摘要）：同樣遮蔽疑似金鑰。allowed：該檔案的「不是金鑰」清單 */
export function redactText(text, allowed = []) {
  return text == null ? null : redactSecrets(String(text), allowed).text;
}

export function undoHint(r) {
  const sha = r?.undo?.sha ?? r?.commit?.sha;
  return sha ? `需要復原時執行：engram undo ${String(sha).slice(0, 10)}` : null;
}

/** 讀取之後內容有變（另一台電腦同步過來、使用者在介面改過）就拒絕寫入 */
export async function assertUnchanged(eg, refs, base) {
  if (base == null) return;
  const revs = String(base).split(',').map((s) => s.trim());
  if (revs.length !== refs.length) throw new CliError('E_USAGE', `--base 要依序給 ${refs.length} 個版本（逗號分隔），收到 ${revs.length} 個`);
  for (let i = 0; i < refs.length; i++) {
    const cur = await readSafe(eg, refs[i]);
    if (!cur.exists) throw new CliError('E_NOT_FOUND', `找不到記憶：${refs[i]}`, '它可能已被移走或刪除；重新讀取後再決定');
    if (cur.rev !== revs[i]) throw new CliError('E_CONFLICT', `${refs[i]} 在你讀取之後被修改過（版本 ${revs[i]} → ${cur.rev}）`, '重新用 engram memory show 讀取最新內容，再寫一次');
  }
}

const MARKER = /‹已遮蔽：[^›\n]*›/g;
const markers = (t) => (String(t ?? '').match(MARKER) ?? []).length;

/**
 * Claude 讀到的是遮蔽後的內容；把它寫回去會讓原本的金鑰被換成標記（等於沒經過使用者同意就遮蔽，
 * 而且若其實不是金鑰，值就永久不見了）。新內容的標記比原本的檔案多，就拒絕。originals 是原本未遮蔽的內容。
 */
export function assertNoNewRedaction(text, originals) {
  const before = originals.reduce((n, t) => n + markers(t), 0);
  if (markers(text) > before) {
    throw new CliError('E_INVALID', '內容含有「‹已遮蔽›」標記，寫入會把原本的疑似金鑰換掉', '疑似金鑰要先經使用者同意，在本機遮蔽：engram inbox apply <H13 卡片 id> --yes；遮蔽完重新讀取，再改寫。');
  }
}

/** 寫入後內容仍疑似含有金鑰：Engram 不會 commit 或同步它，提醒使用者 */
export async function heldNote(eg, ref, text) {
  const { loadAllow, scanWithAllow } = await import('../../core/secretallow.mjs');
  const hits = scanWithAllow(String(text ?? ''), ref, await loadAllow(eg.paths.local));
  return hits.length ? `注意：${ref} 疑似含有金鑰（${[...new Set(hits.map((h) => h.kind))].join('、')}），只會留在這台電腦、不會同步，也不會列在索引裡（之後的對話看不到它）；收件匣會出現 H13。` : null;
}

/** 整份記憶檔要有可解析的 frontmatter，含 name、description、metadata.type */
export function checkMemoryText(text) {
  const p = parseMemoryFile(text);
  const missing = ['name', 'description'].filter((k) => !String(p.data?.[k] ?? '').trim());
  if (!String(p.data?.metadata?.type ?? '').trim()) missing.push('metadata.type');
  if (!p.hasFrontmatter) throw new CliError('E_INVALID', `內容沒有 frontmatter${p.errors?.length ? `（${p.errors[0]}）` : ''}`, '整份內容要以 --- 開頭、以 --- 結尾的 frontmatter 起始，含 name、description、metadata.type');
  if (p.errors?.length) throw new CliError('E_INVALID', `frontmatter 格式有誤：${p.errors.slice(0, 2).join('；')}`, '修正 YAML 格式後再寫入');
  if (missing.length) throw new CliError('E_INVALID', `frontmatter 缺少 ${missing.join('、')}`, '補上後再寫入');
}
