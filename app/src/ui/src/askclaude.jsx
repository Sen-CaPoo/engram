// 「交給 Claude」：需要判斷內容的整理工作，交給使用者自己的 Claude Code 用 /engram 技能處理。
// Engram 本身不呼叫 AI（40 號 §13）；這裡只提供指令、使用步驟與外掛安裝引導。
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { api } from './api.js';
import { useData, Dialog, Banner, Skeleton } from './components.jsx';
import { IconSparkle, IconCheck } from './icons.jsx';
import { t, local, getLang } from './i18n.js';
import { SKILLS } from './locales/en/askclaude.js';

// 外掛技能的說明：中文模式取伺服器附的 SKILL.md 說明（第一句），英文模式依技能名稱查英文表，查不到就用伺服器的文字
function skillInfo(s) {
  const en = getLang() === 'en' ? SKILLS[s.name] : null;
  if (en) return en;
  return { description: s.description.split(/[：。]/)[0], argumentHint: s.argumentHint }; // i18n-ignore
}

export function CopyBox({ text, label = t('複製') }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  };
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
      <pre class="frontmatter" style={{ flex: 1, margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</pre>
      <button class="btn sm" style={{ alignSelf: 'center' }} onClick={copy} aria-label={t('{label}：{text}', { label, text })}>{copied ? <><IconCheck />{t('已複製')}</> : label}</button>
    </div>
  );
}

export function PluginState({ status }) {
  if (status.error) return <p class="faint" style={{ fontSize: 12.5 }}>{t('無法確認 Claude Code 外掛的狀態（{message}）。如果 Claude Code 說找不到指令，請執行 {cmd}。', { message: local(status.error, 'message'), cmd: <code>engram doctor</code> })}</p>;
  const s = status.data;
  if (!s) return <Skeleton rows={1} />;
  if (s.state === 'ready') {
    return <p class="faint" style={{ fontSize: 12.5 }}><span class="chip ok"><IconCheck />{t('Engram 外掛已啟用')}</span>　{t('已經開著的 Claude Code 對話要先執行 {cmd}（或開一個新對話）才看得到新指令。', { cmd: <code>/reload-plugins</code> })}</p>;
  }
  return (
    <Banner tone="warn" title={s.state === 'disabled' ? t('Claude Code 的 Engram 外掛被停用了') : t('這台電腦的 Claude Code 還沒有安裝 Engram 外掛')}>
      <span style={{ display: 'block', marginBottom: 8 }}>{t('在終端機依序執行下面的指令，然後開一個新的 Claude Code 對話：')}</span>
      <div style={{ display: 'grid', gap: 6 }}>{s.commands.map((c) => <CopyBox key={c} text={c} />)}</div>
    </Banner>
  );
}

/**
 * variants：同一件事的幾種做法（例如逐項確認、自動處理），使用者選一種再複製；省略時只有 command 一種。auto：不先問、直接處理有把握的項目。
 * @param {{ title: string, command?: string, intro?: string, variants?: { label: string, command: string, note?: string, auto?: boolean }[], onClose: () => void }} props
 */
export function AskClaudeDialog({ title, command: single, intro, variants, onClose }) {
  const status = useData(() => api.claudePlugin(), []);
  const [pick, setPick] = useState(0);
  const [copied, setCopied] = useState(false);
  const chosen = variants?.[pick];
  const command = chosen?.command ?? single;
  const copy = async () => { try { await navigator.clipboard.writeText(command); setCopied(true); } catch { setCopied(false); } };
  const others = (status.data?.skills || []).filter((s) => s.name !== 'engram' && !command.startsWith(s.command));
  return (
    <Dialog title={title} desc={chosen?.auto ? t('交給你自己的 Claude Code 處理：Claude 讀過內容、列出計畫後，直接處理有把握的項目；每一步都可以用 engram undo 復原。') : t('交給你自己的 Claude Code 處理：Claude 會先讀內容、提出計畫，你同意後才會改；每一步都可以用 engram undo 復原。')} onClose={onClose}
      footer={<><button class="btn" onClick={onClose}>{t('關閉')}</button><button class="btn primary" onClick={copy}>{copied ? <><IconCheck />{t('已複製')}</> : <><IconSparkle />{t('複製指令')}</>}</button></>}>
      {intro && <p class="muted" style={{ fontSize: 13 }}>{intro}</p>}
      {variants?.length > 1 && (
        <div style={{ display: 'grid', gap: 6 }}>
          <div class="seg" role="group" aria-label={t('處理方式')}>
            {variants.map((v, i) => <button key={v.command} aria-pressed={pick === i} onClick={() => { setPick(i); setCopied(false); }}>{v.label}</button>)}
          </div>
          {chosen?.note && <p class="faint" style={{ fontSize: 12.5, margin: 0 }}>{chosen.note}</p>}
        </div>
      )}
      <pre class="frontmatter" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 14 }}>{command}</pre>
      <ol class="muted" style={{ fontSize: 13, margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
        <li>{t('開啟 Claude Code（在任何資料夾都可以；整理某個專案時，在那個專案的資料夾開啟最好）。')}</li>
        <li>{t('貼上上面的指令並送出。')}</li>
        <li>{chosen?.auto ? t('Claude 會列出計畫表並處理有把握的項目，最後回報結果與復原指令；留給你決定的項目會另外列出。') : t('看 Claude 提出的計畫表，回覆要執行哪些項目；你沒有同意的不會動。')}</li>
      </ol>
      <PluginState status={status} />
      {others.length > 0 && (
        <details style={{ fontSize: 13 }}>
          <summary class="muted" style={{ cursor: 'pointer' }}>{t('其他可以在 Claude Code 使用的 Engram 指令')}</summary>
          <dl class="kv" style={{ marginTop: 8 }}>
            {others.map((s) => { const info = skillInfo(s); return [<dt key={`${s.name}-t`}><code>{s.command}</code></dt>, <dd key={`${s.name}-d`}>{info.description}{info.argumentHint ? <span class="faint">　{info.argumentHint}</span> : null}</dd>]; })}
          </dl>
        </details>
      )}
    </Dialog>
  );
}

/** 一顆「交給 Claude」按鈕，按下開啟對話框 */
export function AskClaudeButton({ title, command, intro, variants, label = t('交給 Claude'), cls = 'btn sm' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button class={cls} onClick={(e) => { e.stopPropagation(); setOpen(true); }} title={t('在 Claude Code 執行 {cmd}', { cmd: command ?? variants?.[0]?.command })}><IconSparkle />{label}</button>
      {open && <AskClaudeDialog title={title} command={command} intro={intro} variants={variants} onClose={() => setOpen(false)} />}
    </>
  );
}
