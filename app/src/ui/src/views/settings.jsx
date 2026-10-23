// 設定：這台電腦的名稱、同步、自動綁定、健康檢查時間、暫停與移除（M14）。
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { useApp, useData, Skeleton, Section, ErrorBanner, useAction, ConfirmDialog } from '../components.jsx';
import { relTime } from '../util.js';
import { IconSync } from '../icons.jsx';

const BIND = {
  confident: { label: '有把握時自動綁定（建議）', help: '資料夾已有綁定，或 git remote 與已知專案相同時自動綁定；其他情況在收件匣詢問你。' },
  ask: { label: '每次都詢問', help: '開啟新的資料夾時不做任何事，只在收件匣列出建議，由你決定。' },
  off: { label: '關閉', help: '不自動綁定，也不提出建議；需要時用 engram bind 或專案頁手動綁定。' },
};
// 撞名資料夾依命名規則改名（SW-4，40 號 §08）
const RENAME = {
  auto: { label: '自動改名', help: '常駐程式每小時檢查一次，依規則在原名後加 4 碼代號（例如「照片優化-66ca」），並重新綁定、更新記憶裡的舊路徑。30 分鐘內有對話或檔案修改、裡面有其他專案、Python 虛擬環境、git worktree，或 Claude Code 為它記了 MCP／工具設定的資料夾不會自動改。改完會通知你，可在「裝置與同步」的變更紀錄整批還原。' },
  ask: { label: '在收件匣詢問（預設）', help: '偵測到撞名時只在收件匣列出建議的新名稱，按「依命名規則改名」才會改。' },
  off: { label: '關閉', help: '不改名，也不提出建議；撞名的資料夾繼續用設定檔分開記憶，對話紀錄仍會混在一起。' },
};

export function Settings() {
  const { status, syncNow } = useApp();
  const st = useData(() => api.settings(), []);
  const act = useAction();
  const [label, setLabel] = useState('');
  const [ask, setAsk] = useState(false);
  useEffect(() => { if (st.data) setLabel(st.data.machineLabel); }, [st.data]);
  if (!st.data) return <div class="page"><ErrorBanner error={st.error} onRetry={st.reload} /><div class="panel"><Skeleton rows={6} /></div></div>;
  const s = st.data;
  const save = (patch, text) => act(() => api.saveSettings(patch), text);

  return (
    <div class="page">
      <div class="settings">
        <Section title="這台電腦">
          <div class="setting">
            <label for="st-label"><b>顯示名稱</b></label>
            <div class="btn-row">
              <input id="st-label" class="input" value={label} onInput={(e) => setLabel(e.currentTarget.value)} style={{ width: 220 }} />
              <button class="btn sm primary" disabled={!label.trim() || label === s.machineLabel} onClick={() => save({ machineLabel: label.trim() }, '已改名，會同步到其他電腦')}>儲存</button>
            </div>
            <span class="help">其他電腦的記憶庫、單機記憶與變更紀錄都用這個名稱顯示，例如「公司電腦」「家裡電腦」。</span>
          </div>
        </Section>

        <Section title="同步">
          <div class="setting">
            <b>GitHub 遠端</b>
            <span class="mono" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{s.remote || '尚未設定'}</span>
            <span class="help">{s.remote ? '私人 repo，只有你的 GitHub 帳號能存取。要換遠端，請在終端機執行 engram install --remote <網址>。' : '還沒有遠端時，記憶只存在這台。在終端機執行 engram install --create-remote，會用 gh 在你的 GitHub 建立私人 repo「engram-vault」。'}</span>
          </div>
          <div class="setting">
            <label for="st-interval"><b>背景同步間隔</b></label>
            <select id="st-interval" class="select" value={s.syncIntervalMin} onChange={(e) => save({ syncIntervalMin: Number(e.currentTarget.value) }, '已更新同步間隔')}>
              {[5, 10, 15, 30].map((m) => <option key={m} value={m}>每 {m} 分鐘</option>)}
            </select>
            <span class="help">另外在電腦醒來、對話結束、vault 有變更後也會同步，所以通常不需要調短。</span>
          </div>
          <div class="setting">
            <b>立即同步</b>
            <button class="btn sm" onClick={syncNow}><IconSync />立即同步</button>
            <span class="help">上次成功：{relTime(status?.sync?.lastSuccessAt)}。GitHub 登入過期時，執行 gh auth login 重新登入 GitHub；如果 git 的認證沒有交給 GitHub CLI，改在 PowerShell 或 Git Bash 執行 git -C "$HOME/.engram/vault" fetch，依提示在瀏覽器登入。</span>
          </div>
        </Section>

        <Section title="自動綁定專案資料夾">
          {Object.entries(BIND).map(([k, v]) => (
            <label key={k} class="setting" style={{ cursor: 'pointer' }}>
              <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <input type="radio" name="bind-auto" id={`st-bind-${k}`} checked={s.bindAuto === k} onChange={() => save({ bindAuto: k }, '已更新自動綁定方式')} />
                <b>{v.label}</b>
              </span>
              <span />
              <span class="help">{v.help}</span>
            </label>
          ))}
        </Section>

        <Section title="撞名的資料夾">
          {Object.entries(RENAME).map(([k, v]) => (
            <label key={k} class="setting" style={{ cursor: 'pointer' }}>
              <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <input type="radio" name="collision-rename" id={`st-rename-${k}`} checked={(s.collisionRename ?? 'ask') === k} onChange={() => save({ collisionRename: k }, '已更新撞名資料夾的處理方式')} />
                <b>{v.label}</b>
              </span>
              <span />
              <span class="help">{v.help}</span>
            </label>
          ))}
        </Section>

        <Section title="健康檢查">
          <div class="setting">
            <label for="st-health"><b>每天執行的時間</b></label>
            <input id="st-health" class="input" type="time" value={s.healthTime} onChange={(e) => save({ healthTime: e.currentTarget.value }, '已更新健康檢查時間')} style={{ width: 130 }} />
            <span class="help">錯過時（例如電腦關機）會在下次啟動後補跑。只有高等級的發現才會發 Windows 通知。</span>
          </div>
        </Section>

        <Section title="暫停與移除">
          <div class="setting">
            <b>暫停 Engram</b>
            <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" id="st-paused" checked={s.paused} onChange={(e) => save({ paused: e.currentTarget.checked }, e.currentTarget.checked ? '已暫停：不同步、不綁定、不整理' : '已恢復')} />
              {s.paused ? '已暫停' : '執行中'}
            </label>
            <span class="help">暫停期間 Claude Code 照常讀寫記憶，只是不會同步到其他電腦、也不會自動綁定或整理。恢復後會一次補上。</span>
          </div>
          <div class="setting">
            <b>從這台電腦移除 Engram</b>
            <button class="btn sm danger" onClick={() => setAsk(true)}>查看移除方式</button>
            <span class="help">移除會依安裝紀錄逐項還原，預設保留你的記憶庫。</span>
          </div>
        </Section>
      </div>
      {ask && (
        <ConfirmDialog title="從這台電腦移除 Engram" desc="移除需要在終端機執行，才能停止常駐程式並還原 Claude Code 的設定。" confirmLabel="知道了" onConfirm={() => setAsk(false)} onClose={() => setAsk(false)}>
          <pre class="frontmatter">engram uninstall --dry-run   # 先看會還原哪些東西{'\n'}engram uninstall             # 逐項還原，保留記憶庫</pre>
          <p class="muted" style={{ fontSize: 13 }}>會做的事：停止常駐程式並刪除登入工作、移除 Claude Code 外掛、把 junction 換回一般資料夾並放回記憶檔、撤銷 Engram 加入的權限設定、從 ~/.claude/CLAUDE.md 移除 Engram 區塊。加上 --purge 才會刪除記憶庫（GitHub 上的 repo 不受影響）。</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
