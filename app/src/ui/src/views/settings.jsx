// 設定：介面語言、這台電腦的名稱、同步、自動綁定、健康檢查時間、暫停與移除（M14）。
// 2.0.0：情境召回與索引分層、護欄、環境健檢與環境設定同步、自動更新。這幾項有些不在 GET /api/settings，
// 各自讀 /api/recall、/api/guardrails、/api/update（讀不到的區塊單獨顯示原因，不影響整頁）；修改一律走 PUT /api/settings。
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { useApp, useData, Skeleton, Section, ErrorBanner, useAction, ConfirmDialog, Banner } from '../components.jsx';
import { relTime, fmtBytes } from '../util.js';
import { IconChevronRight, IconSync } from '../icons.jsx';
import { t, N_, LANGS, local } from '../i18n.js';
import { AutopilotSwitch, useAutopilotToggle } from './autopilot.jsx';

const BIND = {
  confident: { label: N_('有把握時自動綁定（建議）'), help: N_('資料夾已有綁定，或 git remote 與已知專案相同時自動綁定；其他情況在收件匣詢問你。') },
  ask: { label: N_('每次都詢問'), help: N_('開啟新的資料夾時不做任何事，只在收件匣列出建議，由你決定。') },
  off: { label: N_('off::關閉'), help: N_('不自動綁定，也不提出建議；需要時用 engram bind 或專案頁手動綁定。') },
};
// 撞名資料夾依命名規則改名（SW-4，40 號 §08）
const RENAME = {
  auto: { label: N_('自動改名'), help: N_('常駐程式每小時檢查一次，依規則在原名後加 4 碼代號（例如「照片優化-66ca」），並重新綁定、更新記憶裡的舊路徑。30 分鐘內有對話或檔案修改、裡面有其他專案、Python 虛擬環境、git worktree，或 Claude Code 為它記了 MCP／工具設定的資料夾不會自動改。改完會通知你，可在「裝置與同步」的變更紀錄整批還原。') },
  ask: { label: N_('在收件匣詢問（預設）'), help: N_('偵測到撞名時只在收件匣列出建議的新名稱，按「依命名規則改名」才會改。') },
  off: { label: N_('off::關閉'), help: N_('不改名，也不提出建議；撞名的資料夾繼續用設定檔分開記憶，對話紀錄仍會混在一起。') },
};

export function Settings() {
  const { status, syncNow, lang, changeLang, go } = useApp();
  const st = useData(() => api.settings(), []);
  const act = useAction();
  const autopilot = useAutopilotToggle(st.data?.autopilot === 'on', st.data?.autopilotBudget);
  const [label, setLabel] = useState('');
  const [ask, setAsk] = useState(false);
  useEffect(() => { if (st.data) setLabel(st.data.machineLabel); }, [st.data]);
  if (!st.data) return <div class="page"><ErrorBanner error={st.error} onRetry={st.reload} /><div class="panel"><Skeleton rows={6} /></div></div>;
  const s = st.data;
  const save = (patch, text) => act(() => api.saveSettings(patch), text);

  return (
    <div class="page">
      <div class="settings">
        <Section title={t('介面語言')}>
          <div class="setting">
            <label for="st-lang"><b>{t('語言')}</b></label>
            <select id="st-lang" class="select" value={lang} onChange={(e) => changeLang(e.currentTarget.value)}>
              {LANGS.map((l) => <option key={l.id} value={l.id} lang={l.id}>{l.label}</option>)}
            </select>
            <span class="help">{t('只影響這個瀏覽器的管理介面；記憶內容、命令列與 Claude 的回覆不受影響。')}</span>
          </div>
        </Section>

        <Section title={t('這台電腦')}>
          <div class="setting">
            <label for="st-label"><b>{t('顯示名稱')}</b></label>
            <div class="btn-row">
              <input id="st-label" class="input" value={label} onInput={(e) => setLabel(e.currentTarget.value)} style={{ width: 220 }} />
              <button class="btn sm primary" disabled={!label.trim() || label === s.machineLabel} onClick={() => save({ machineLabel: label.trim() }, t('已改名，會同步到其他電腦'))}>{t('儲存')}</button>
            </div>
            <span class="help">{t('其他電腦的記憶庫、單機記憶與變更紀錄都用這個名稱顯示，例如「公司電腦」「家裡電腦」。')}</span>
          </div>
        </Section>

        <Section title={t('同步')}>
          <div class="setting">
            <b>{t('GitHub 遠端')}</b>
            <span class="mono" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{s.remote || t('尚未設定')}</span>
            <span class="help">{s.remote ? t('私人 repo，只有你的 GitHub 帳號能存取。要換遠端，請在終端機執行 engram install --remote <網址>。') : t('還沒有遠端時，記憶只存在這台。在終端機執行 engram install --create-remote，會用 gh 在你的 GitHub 建立私人 repo「engram-vault」。')}</span>
          </div>
          <div class="setting">
            <label for="st-interval"><b>{t('背景同步間隔')}</b></label>
            <select id="st-interval" class="select" value={s.syncIntervalMin} onChange={(e) => save({ syncIntervalMin: Number(e.currentTarget.value) }, t('已更新同步間隔'))}>
              {[5, 10, 15, 30].map((m) => <option key={m} value={m}>{t('每 {n} 分鐘', { n: m })}</option>)}
            </select>
            <span class="help">{t('另外在電腦醒來、對話結束、vault 有變更後也會同步，所以通常不需要調短。')}</span>
          </div>
          <div class="setting">
            <b>{t('立即同步')}</b>
            <button class="btn sm" onClick={syncNow}><IconSync />{t('立即同步')}</button>
            <span class="help">{t('上次成功：{when}。GitHub 登入過期時，執行 gh auth login 重新登入 GitHub；如果 git 的認證沒有交給 GitHub CLI，改在 PowerShell 或 Git Bash 執行 git -C "$HOME/.engram/vault" fetch，依提示在瀏覽器登入。', { when: relTime(status?.sync?.lastSuccessAt) })}</span>
          </div>
        </Section>

        <Section title={t('自動綁定專案資料夾')}>
          {Object.entries(BIND).map(([k, v]) => (
            <label key={k} class="setting" style={{ cursor: 'pointer' }}>
              <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <input type="radio" name="bind-auto" id={`st-bind-${k}`} checked={s.bindAuto === k} onChange={() => save({ bindAuto: k }, t('已更新自動綁定方式'))} />
                <b>{t(v.label)}</b>
              </span>
              <span />
              <span class="help">{t(v.help)}</span>
            </label>
          ))}
        </Section>

        <Section title={t('撞名的資料夾')}>
          {Object.entries(RENAME).map(([k, v]) => (
            <label key={k} class="setting" style={{ cursor: 'pointer' }}>
              <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <input type="radio" name="collision-rename" id={`st-rename-${k}`} checked={(s.collisionRename ?? 'ask') === k} onChange={() => save({ collisionRename: k }, t('已更新撞名資料夾的處理方式'))} />
                <b>{t(v.label)}</b>
              </span>
              <span />
              <span class="help">{t(v.help)}</span>
            </label>
          ))}
        </Section>

        <Section title={t('健康檢查')}>
          <div class="setting">
            <label for="st-health"><b>{t('每天執行的時間')}</b></label>
            <input id="st-health" class="input" type="time" value={s.healthTime} onChange={(e) => save({ healthTime: e.currentTarget.value }, t('已更新健康檢查時間'))} style={{ width: 130 }} />
            <span class="help">{t('錯過時（例如電腦關機）會在下次啟動後補跑。只有高等級的發現才會發 Windows 通知。')}</span>
          </div>
          <label class="setting" style={{ cursor: 'pointer' }}>
            <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <input type="checkbox" id="st-review" checked={(s.reviewWrites ?? 'on') !== 'off'} onChange={(e) => save({ reviewWrites: e.currentTarget.checked ? 'on' : 'off' }, t('已更新確認設定'))} />
              <b>{t('Claude 寫入每次都會載入的內容時請我確認')}</b>
            </span>
            <span />
            <span class="help">{t('全域記憶、這台電腦的單機記憶與核心準則會在每個專案的每次對話被讀到。Claude 自己寫入這些內容時，收件匣會列出「待你確認」，看過差異後確認、編輯或退回；你在介面、記憶整理或 /engram:save 同意過的不會再問。只是提醒，不會擋住寫入。')}</span>
          </label>
        </Section>

        <Section title={t('自動駕駛')}>
          <div class="setting">
            <label for="st-autopilot"><b>{t('讓 AI 每天自動整理記憶')}</b></label>
            <AutopilotSwitch tog={autopilot} id="st-autopilot" />
            <span class="help">{t('開啟後，Engram 會在電腦閒置時，每天讓 AI 自動整理記憶、處理收件匣、回顧對話，不會逐項問你。每一項變更都有備份，可以在「自動駕駛」頁復原。')}</span>
          </div>
          <div class="setting">
            <b>{t('做了什麼、怎麼復原')}</b>
            <button class="btn sm" onClick={() => go('autopilot')}>{t('前往自動駕駛')}<IconChevronRight /></button>
            <span class="help">{t('看每一輪處理了哪些事、為什麼這樣做，並逐項或整輪復原；也可以在那裡調整每月用量上限。')}</span>
          </div>
        </Section>

        <RecallSettings />
        <GuardSettings go={go} />
        <EnvSettings s={s} go={go} />
        <UpdateSettings />

        <Section title={t('暫停與移除')}>
          <div class="setting">
            <b>{t('暫停 Engram')}</b>
            <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" id="st-paused" checked={s.paused} onChange={(e) => save({ paused: e.currentTarget.checked }, e.currentTarget.checked ? t('已暫停：不同步、不綁定、不整理') : t('已恢復'))} />
              {s.paused ? t('已暫停') : t('執行中')}
            </label>
            <span class="help">{t('暫停期間 Claude Code 照常讀寫記憶，只是不會同步到其他電腦、也不會自動綁定或整理。恢復後會一次補上。')}</span>
          </div>
          <div class="setting">
            <b>{t('從這台電腦移除 Engram')}</b>
            <button class="btn sm danger" onClick={() => setAsk(true)}>{t('查看移除方式')}</button>
            <span class="help">{t('移除會依安裝紀錄逐項還原，預設保留你的記憶庫。')}</span>
          </div>
        </Section>
      </div>
      {autopilot.dialog}
      {ask && (
        <ConfirmDialog title={t('從這台電腦移除 Engram')} desc={t('移除需要在終端機執行，才能停止常駐程式並還原 Claude Code 的設定。')} confirmLabel={t('知道了')} onConfirm={() => setAsk(false)} onClose={() => setAsk(false)}>
          <pre class="frontmatter">{t('engram uninstall --dry-run   # 先看會還原哪些東西')}{'\n'}{t('engram uninstall             # 逐項還原，保留記憶庫')}</pre>
          <p class="muted" style={{ fontSize: 13 }}>{t('會做的事：停止常駐程式並刪除登入工作、移除 Claude Code 外掛、把 junction 換回一般資料夾並放回記憶檔、撤銷 Engram 加入的權限設定、從 ~/.claude/CLAUDE.md 移除 Engram 區塊。加上 --purge 才會刪除記憶庫（GitHub 上的 repo 不受影響）。')}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

// ───────── 2.0.0 ─────────

/** 開關（role="switch"）：on 由呼叫端的資料決定，按下時呼叫 onChange(!on) */
function Toggle({ id, on, label, disabled, onChange }) {
  return (
    <button type="button" role="switch" id={id} class="switch" aria-checked={on ? 'true' : 'false'} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}>
      <span class="knob" />
    </button>
  );
}

/** 一組單選：失敗時 key 換掉，讓瀏覽器的選取狀態回到伺服器的值 */
function Choices({ name, value, options, onPick, disabledOf }) {
  return Object.entries(options).map(([k, v]) => {
    const why = disabledOf?.(k);
    return (
      <label key={k} class={`setting${why ? ' disabled' : ''}`} style={{ cursor: why ? 'not-allowed' : 'pointer' }}>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input type="radio" name={name} id={`st-${name}-${k}`} checked={value === k} disabled={!!why} onChange={() => onPick(k)} />
          <b>{t(v.label)}</b>
        </span>
        <span />
        <span class="help">{t(v.help)}{why && <span class="st-why">{why}</span>}</span>
      </label>
    );
  });
}

/** 讀不到某個區塊的資料（例如舊版引擎回 501）時，只在那一區說明 */
function SectionError({ error, onRetry }) {
  return <div class="setting"><span class="help">{local(error, 'message')}{local(error, 'hint') ? ` ${local(error, 'hint')}` : ''}</span>{onRetry && <button class="btn sm" onClick={onRetry}>{t('重試')}</button>}</div>;
}

/** 存設定；失敗時把錯誤留在那一區（例如「還有電腦沒有升級」），並讓選項回到原本的值 */
function useInlineSave() {
  const act = useAction();
  const [err, setErr] = useState(null);
  const [nonce, setNonce] = useState(0);
  const save = async (patch, text) => {
    setErr(null);
    try { await act(() => api.saveSettings(patch), text, { rethrow: true }); } catch (e) { setErr(e); setNonce((n) => n + 1); }
  };
  const banner = err && <div class="setting"><Banner tone="bad" title={local(err, 'message')} actions={<button class="btn sm ghost" onClick={() => setErr(null)}>{t('關閉')}</button>}>{local(err, 'hint')}</Banner></div>;
  return { save, banner, nonce };
}

const LAYERS = {
  observe: { label: N_('並行觀察（預設）'), help: N_('索引照舊完整列出，同時在背景算出「如果開啟分層」索引會小多少、情境召回帶出的記憶有沒有被用到。數字夠了再決定要不要開啟，不會自動切換。') },
  on: { label: N_('layers::開啟'), help: N_('全域與單機索引只列「規則層」（回饋、使用者偏好、釘選的記憶），其他參考類記憶不列在索引裡，相關時由情境召回帶出。所有電腦共用這個設定；之後如果有還沒升級的電腦重新同步，會自動改回並行觀察並通知你。') },
  off: { label: N_('layers::關閉'), help: N_('索引照舊完整列出，也不做並行觀察的統計。') },
};

function RecallSettings() {
  const r = useData(() => api.recall(), []);
  const { save, banner, nonce } = useInlineSave();
  if (!r.data) return <Section title={t('情境召回與索引')}>{r.error ? <SectionError error={r.error} onRetry={r.reload} /> : <div class="panel-body"><Skeleton rows={2} /></div>}</Section>;
  const d = r.data;
  const on = d.recall === 'on';
  const ob = d.observe || {};
  const pct = ob.recalled ? Math.round((ob.opened / ob.recalled) * 100) : null;
  // 索引相容模式（indexCompat.active）：還有舊版的電腦，共用的索引照舊版的方式產生；那幾台更新之後才能開啟索引分層
  const compat = d.indexCompat?.active ? d.indexCompat : null;
  const olderList = (compat?.machines || []).map((m) => m.label || m.mid).join(t('、'));
  const scope = (k, name) => {
    const x = ob.scopes?.[k];
    if (!x) return null;
    return <li key={k}>{t('{name}：{off} → 分層後 {on}（{n} 筆參考類記憶改由情境召回帶出）', { name, off: fmtBytes(x.bytes?.off), on: fmtBytes(x.bytes?.on), n: x.reference ?? 0 })}</li>;
  };
  return (
    <Section title={t('情境召回與索引')}>
      {compat && <div class="setting"><Banner tone="info" title={t('索引相容模式')}>{local(compat, 'message')}</Banner></div>}
      <div class="setting">
        <label for="st-recall"><b>{t('情境召回')}</b></label>
        <Toggle id="st-recall" on={on} label={t('情境召回')} disabled={d.recallForced} onChange={(v) => save({ recall: v ? 'on' : 'off' }, v ? t('已開啟情境召回') : t('已關閉情境召回'))} />
        <span class="help">
          {t('你送出訊息時，Engram 會從全域記憶、這台電腦的單機記憶與目前這個專案的記憶裡，找出最多 3 筆和這則訊息相關、但不在已載入索引裡的，附在訊息後面（只有 Claude 看得到）。不會帶出其他專案的記憶。關閉後只靠索引與 {cmd}。', { cmd: <code>engram search</code> })}
          {d.recallForced && <span class="st-why">{t('索引分層開著時，情境召回一定要開（參考類記憶只能靠它帶出），所以不能關閉。')}</span>}
        </span>
      </div>
      <div class="setting st-sub">
        <b>{t('索引分層')}</b>
        <span />
        <span class="help">{t('每次對話都會載入的全域與單機索引，可以只列最重要的「規則層」，讓索引更小、更好讀。')}</span>
      </div>
      <div key={`layers-${nonce}`}>
        <Choices name="layers" value={d.indexLayers} options={LAYERS} onPick={(k) => save({ indexLayers: k }, t('已更新索引分層'))}
          disabledOf={(k) => {
            if (k !== 'on' || d.indexLayers === 'on') return null;
            if (compat) return olderList ? t('還有電腦是舊版的 Engram（{list}）：那幾台更新之後才能開啟。', { list: olderList }) : t('還有電腦是舊版的 Engram：那幾台更新之後才能開啟。');
            return !on ? t('要先開啟情境召回：分層後參考類記憶只能靠它帶出。') : null;
          }} />
      </div>
      {banner}
      {d.indexLayers === 'observe' && (
        <div class="setting">
          <b>{t('並行觀察的數字（近 {n} 天）', { n: ob.days ?? 30 })}</b>
          <span />
          <div class="help">
            <ul class="st-obs">
              {scope('global', t('全域索引'))}
              {scope('machine', t('這台的單機索引'))}
              <li>{pct === null ? t('情境召回還沒有帶出過記憶。') : t('情境召回帶出 {n} 次，其中 {m} 次之後被打開（{p}%）。', { n: ob.recalled, m: ob.opened, p: pct })}</li>
            </ul>
            <span class="faint">{t('索引越小，每次對話佔用的上下文越少；被打開的比例越高，代表帶出的記憶越有用。「被打開」由每天的健康檢查統計，最近一天的數字可能偏低。')}</span>
          </div>
        </div>
      )}
    </Section>
  );
}

const GUARD = {
  block: { label: N_('擋下（預設）'), help: N_('把握高的規則直接擋下指令，並告訴 Claude 正確的寫法；把握低的只附提醒。') },
  hint: { label: N_('只提醒'), help: N_('所有規則都只在指令執行後附上提醒，不擋下任何指令。') },
  off: { label: N_('guard::關閉'), help: N_('不比對任何規則。') },
};

function GuardSettings({ go }) {
  const g = useData(() => api.guardrails(), []);
  const { save, banner, nonce } = useInlineSave();
  return (
    <Section title={t('護欄')} end={<button class="btn sm ghost" onClick={() => go('env', { tab: 'guard' })}>{t('看規則與試試看')}<IconChevronRight /></button>}>
      <div class="setting st-sub">
        <span class="help">{t('Claude 送出 Bash 或 PowerShell 指令之前，先和「踩過的坑」比對（例如某種寫法在這台電腦會出錯），避免同樣的錯誤一再發生。')}</span>
      </div>
      {!g.data ? (g.error ? <SectionError error={g.error} onRetry={g.reload} /> : <div class="panel-body"><Skeleton rows={2} /></div>) : (
        <div key={`guard-${nonce}`}>
          <Choices name="guardrails" value={g.data.mode} options={GUARD} onPick={(k) => save({ guardrails: k }, t('已更新護欄設定'))} />
        </div>
      )}
      {banner}
    </Section>
  );
}

const ENV_SYNC = {
  report: { label: N_('只報告（預設）'), help: N_('每天算出這台套用共用設定後會改什麼，放在「環境」頁給你看，不會自動寫入。') },
  auto: { label: N_('自動套用'), help: N_('沒有對話進行中時自動套用。只會套用你在這台核可過的項目，沒核可的仍然只列出來。') },
  off: { label: N_('envsync::關閉'), help: N_('不同步環境設定，也不計算要改什麼。') },
};

function EnvSettings({ s, go }) {
  const { save, banner, nonce } = useInlineSave();
  return (
    <Section title={t('環境')} end={<button class="btn sm ghost" onClick={() => go('env')}>{t('前往環境')}<IconChevronRight /></button>}>
      <div class="setting">
        <label for="st-envhealth"><b>{t('環境健檢')}</b></label>
        <Toggle id="st-envhealth" on={(s.envHealth ?? 'on') !== 'off'} label={t('環境健檢')} onChange={(v) => save({ envHealth: v ? 'on' : 'off' }, v ? t('已開啟環境健檢') : t('已關閉環境健檢'))} />
        <span class="help">{t('每天檢查一次這台電腦的 Claude Code 環境：拖慢每次操作的 hook、失效的設定、疑似明文金鑰、沒在用的外掛。只讀名稱、版本與耗時，不讀設定值或對話內容。')}</span>
      </div>
      <div class="setting st-sub">
        <b>{t('環境設定同步')}</b>
        <span />
        <span class="help">{t('讓每台電腦共用一份 Claude Code 設定（白名單內的設定、環境變數、自製技能、應該安裝的外掛清單）。從其他電腦同步來的值，要在這台核可之後才會套用。')}</span>
      </div>
      <div key={`envsync-${nonce}`}>
        <Choices name="envsync" value={s.envSync ?? 'report'} options={ENV_SYNC} onPick={(k) => save({ envSync: k }, t('已更新環境設定同步'))} />
      </div>
      {banner}
    </Section>
  );
}

const UPDATE_STATUS = {
  updated: N_('已更新'), failed: N_('更新失敗，已退回原本的版本'), refused: N_('條件不符，沒有更新'), deferred: N_('有對話進行中，稍後再試'),
  current: N_('已經是最新版'), off: N_('自動更新已關閉'), none: N_('記憶庫裡還沒有發佈資訊'),
};

function UpdateSettings() {
  const u = useData(() => api.update(), []);
  const { save, banner } = useInlineSave();
  if (!u.data) return <Section title={t('自動更新')}>{u.error ? <SectionError error={u.error} onRetry={u.reload} /> : <div class="panel-body"><Skeleton rows={2} /></div>}</Section>;
  const d = u.data;
  const last = d.last;
  // 最近一次檢查的原因附英文（last.en.reason）；英文對不到時顯示中文原文，沒有原因時用結果的種類
  const lastText = last ? local(last, 'reason') || t(UPDATE_STATUS[last.status] || UPDATE_STATUS.none) : null;
  return (
    <Section title={t('自動更新')}>
      <div class="setting">
        <label for="st-update"><b>{t('自動更新 Engram')}</b></label>
        <Toggle id="st-update" on={d.autoUpdate !== 'off'} label={t('自動更新 Engram')} onChange={(v) => save({ autoUpdate: v ? 'on' : 'off' }, v ? t('已開啟自動更新') : t('已關閉自動更新'))} />
        <span class="help">{t('任何一台電腦用 {cmd} 更新到新版之後，其他電腦每天檢查一次，沒有對話進行中時自動更新。更新前先備份，失敗會自動退回並通知你。', { cmd: <code>engram update</code> })}</span>
      </div>
      {banner}
      <div class="setting">
        <dl class="kv st-update">
          <dt>{t('這台的版本')}</dt><dd>{d.local || '—'}{d.dev && <span class="faint">　{t('（開發用的安裝，不會自動更新）')}</span>}</dd>
          <dt>{t('最新發佈')}</dt><dd>{d.release?.version ? t('{version}（{when}）', { version: d.release.version, when: relTime(d.release.at) }) : t('還沒有')}</dd>
          <dt>{t('上次檢查')}</dt><dd>{last ? t('{when}：{result}', { when: relTime(last.at), result: lastText }) : t('還沒有檢查過')}</dd>
        </dl>
      </div>
    </Section>
  );
}
