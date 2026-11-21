// 每週摘要（2.0.0）：自動駕駛每週整理一次成果——這週學到的、畢業的記憶、保留區、護欄、情境召回、環境健檢、自動駕駛的用量。
// 資料來自 GET /api/digest（可帶 ?week=週一的日期）；端點還沒有或這週沒有摘要時，api.digest 回傳 null，顯示「還沒有摘要」。
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.js';
import { Empty, ErrorBanner, Section, Skeleton, useData, When } from '../components.jsx';
import { t, N_, locale } from '../i18n.js';
import { IconChevronRight, IconDigest } from '../icons.jsx';

const GRADUATE = {
  core: { label: N_('成為核心準則的一行'), short: N_('核心準則') },
  guardrail: { label: N_('成為一條護欄規則'), short: N_('護欄') },
  env: { label: N_('成為環境設定'), short: N_('環境設定') },
  archive: { label: N_('一次性的進度，已封存'), short: N_('已封存') },
};
const STOP = { limit: N_('用量上限'), auth: N_('登入到期'), budget: N_('本月預算用完'), busy: N_('Claude 暫時忙碌') };
const usd = (n) => Number(n || 0).toFixed(2);
/** 這一週的週一（本地時間，YYYY-MM-DD）：後端的週也是本地時間的週一 */
function thisMonday(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function Digest({ params, go }) {
  const [week, setWeek] = useState(params.week || '');
  const [weeks, setWeeks] = useState([]);
  const d = useData(() => api.digest(week || undefined), [week]);
  const x = d.data;
  // 切到較早的週時，那一週的 previous 只有更早的週：選單保留看過的所有週
  useEffect(() => { if (x) setWeeks((ws) => [...new Set([...ws, x.week, ...(x.previous || [])])].sort().reverse()); }, [x]);

  if (d.data === undefined) return <div class="page"><ErrorBanner error={d.error} onRetry={d.reload} /><div class="panel"><Skeleton rows={6} /></div></div>;
  if (x === null) {
    return (
      <div class="page">
        <ErrorBanner error={d.error} onRetry={d.reload} />
        <div class="panel">
          <Empty icon={IconDigest} title={week ? t('這一週沒有摘要') : t('還沒有摘要')}
            action={<button class="btn" onClick={() => (week ? setWeek('') : go('autopilot'))}>{week ? t('回到最新一週') : t('前往自動駕駛')}<IconChevronRight /></button>}>
            {t('開啟自動駕駛後，每週會整理一次摘要：這週學到了什麼、哪些記憶畢業、保留區與護欄的狀況、自動駕駛用了多少額度。產生之後會通知你，摘要也會出現在這裡。')}
          </Empty>
        </div>
      </div>
    );
  }
  const created = x.learned?.created || [];
  const updated = x.learned?.updated || [];
  const ratio = x.recall?.surfaced ? Math.round((x.recall.opened / x.recall.surfaced) * 100) : null;
  const openMem = (ref) => go('library', { ref });
  // 以前存下來的週沒有 graduation 與 preferences.candidates：當成 0，不顯示
  const needsConfirm = Number(x.graduation?.needsConfirm) || 0;
  const candidates = Number(x.preferences?.candidates) || 0;

  return (
    <div class="page">
      <ErrorBanner error={d.error} onRetry={d.reload} />
      <section class="panel dg-head">
        <div class="panel-body">
          <div class="dg-title">
            <h2>{t('{date} 起的一週', { date: x.week })}</h2>
            {weeks.length > 1 && (
              <select class="select" value={x.week} onChange={(e) => setWeek(e.currentTarget.value)} aria-label={t('選擇週次')}>
                {weeks.map((w) => <option key={w} value={w}>{t('{date} 起的一週', { date: w })}</option>)}
              </select>
            )}
          </div>
          <p class="faint">{x.week === thisMonday()
            ? t('這一週還沒結束，數字是到目前為止的（{when}）。週一會產生整週的摘要。', { when: x.generatedAt ? new Date(x.generatedAt).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—' })
            : t('產生於 {when}。自動駕駛每週整理一次，數字只算這一週。', { when: x.generatedAt ? new Date(x.generatedAt).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—' })}</p>
        </div>
      </section>

      <div class="grid cols-3 dg-tiles">
        <Tile label={t('新增的記憶')} value={created.length} foot={t('更新 {n} 筆', { n: updated.length })} />
        <Tile label={t('畢業的記憶')} value={(x.graduated || []).length} foot={t('換成核心準則、護欄或環境設定')} />
        <Tile label={t('保留區')} value={x.holding?.held ?? 0} foot={x.holding?.withCore ? t('其中 {n} 項核心事實有依據', { n: x.holding.withCore }) : t('等你決定的項目')} onClick={() => go('holding')} />
        {x.preferences && <Tile label={t('還沒採用的偏好')} value={x.preferences.pending ?? 0} foot={candidates > 0 ? t('已經遵守 {n} 筆；另有 {c} 筆常用的記憶等你確認', { n: x.preferences.used ?? 0, c: candidates }) : t('已經遵守 {n} 筆；按一下去確認', { n: x.preferences.used ?? 0 })} onClick={() => go('autopilot', { focus: 'prefs' })} />}
        <Tile label={t('護欄擋下')} value={x.guardrails?.blocked ?? 0} foot={t('提醒 {a} 次、誤擋 {b} 次', { a: x.guardrails?.hinted ?? 0, b: x.guardrails?.falseBlocks ?? 0 })} onClick={() => go('env', { tab: 'guard' })} />
        <Tile label={t('情境召回帶出')} value={x.recall?.surfaced ?? 0} foot={ratio === null ? t('這週沒有帶出') : t('其中 {n} 次被打開（{p}%）', { n: x.recall.opened, p: ratio })} />
      </div>

      <div class="grid cols-2 dg-cols">
        <Section title={t('這週學到的')} sub={t('新增 {a} 筆、更新 {b} 筆', { a: created.length, b: updated.length })}>
          {created.length + updated.length === 0 ? <div class="panel-body"><p class="faint">{t('這週沒有新增或更新記憶。')}</p></div> : (
            <ul class="dg-list">
              {created.map((m) => <li key={`c${m.ref}`}><span class="act-chip create">{t('digest::新增')}</span><button class="linkish" onClick={() => openMem(m.ref)}>{m.title}</button></li>)}
              {updated.map((m) => <li key={`u${m.ref}`}><span class="act-chip update">{t('digest::更新')}</span><button class="linkish" onClick={() => openMem(m.ref)}>{m.title}</button></li>)}
            </ul>
          )}
        </Section>

        <Section title={t('畢業的記憶')} sub={t('items::{n} 筆', { n: (x.graduated || []).length })}>
          <div class="panel-body"><p class="faint dg-note">{t('「畢業」是把常用、已經穩定的記憶換成更適合的形式：寫成核心準則的一行、變成護欄規則或環境設定；一次性的進度則封存。原本的記憶內文不動。')}</p></div>
          {needsConfirm > 0 && (
            <div class="panel-body dg-confirm">
              <p>{t('有 {n} 筆常用的記憶要你確認之後，才能寫進核心準則或成為護欄規則。', { n: needsConfirm })}</p>
              <button class="btn sm" onClick={() => go('autopilot', { focus: 'prefs' })}>{t('去確認')}<IconChevronRight /></button>
            </div>
          )}
          {(x.graduated || []).length === 0 ? <div class="panel-body"><p class="faint">{t('這週沒有記憶畢業。')}</p></div> : (
            <ul class="dg-list">
              {x.graduated.map((m) => (
                <li key={m.ref}>
                  <span class={`act-chip ${m.to === 'archive' ? 'archive' : 'promote'}`} title={GRADUATE[m.to] ? t(GRADUATE[m.to].label) : ''}>{GRADUATE[m.to] ? t(GRADUATE[m.to].short) : m.to}</span>
                  <button class="linkish" onClick={() => openMem(m.ref)}>{m.title}</button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <div class="grid cols-2 dg-cols">
        <Section title={t('環境健檢的新發現')} end={<button class="btn sm ghost" onClick={() => go('env')}>{t('環境')}<IconChevronRight /></button>}>
          {(x.env?.findings || []).length === 0 ? <div class="panel-body"><p class="faint">{t('這週沒有新的發現。')}</p></div> : (
            <ul class="dg-list">{x.env.findings.map((f, i) => <li key={`${f.code}${i}`}><span>{f.title}</span><span class="code faint">{f.code}</span></li>)}</ul>
          )}
        </Section>

        <Section title={t('自動駕駛')} end={<button class="btn sm ghost" onClick={() => go('autopilot')}>{t('執行紀錄')}<IconChevronRight /></button>}>
          <div class="panel-body">
            <p>{t('這週執行 {n} 輪，用量約當 US$ {cost}。', { n: x.autopilot?.runs ?? 0, cost: usd(x.autopilot?.costUsd) })}</p>
            {(x.autopilot?.stopped || []).length > 0 && (
              <ul class="dg-list plain">
                {x.autopilot.stopped.map((s, i) => <li key={i}><span class="chip warn">{STOP[s.reason] ? t(STOP[s.reason]) : s.reason}</span><span>{t('有一輪提前停止')}</span><When at={s.at} />{s.reason === 'busy' && <span class="faint dg-note">{t('Claude 的額度或服務忙碌，先停下來，之後會自動再試。')}</span>}</li>)}
              </ul>
            )}
          </div>
        </Section>
      </div>
    </div>
  );
}

function Tile({ label, value, foot, onClick }) {
  const body = <><span class="label">{label}</span><span class="value">{value}</span><span class="foot">{foot}</span></>;
  return onClick ? <button type="button" class="panel stat dg-tile" onClick={onClick}>{body}</button> : <div class="panel stat">{body}</div>;
}
