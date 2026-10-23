// CodeMirror 6 包裝：Markdown＋YAML frontmatter 編輯器，以及衝突用的雙欄合併檢視。
// 選 CodeMirror 的原因：它不會重寫 Markdown，frontmatter 能逐字保留，避免同步時產生無意義的差異。
import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { MergeView } from '@codemirror/merge';
import { tags as t } from '@lezer/highlight';

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--panel)', color: 'var(--text)' },
  '.cm-content': { padding: '10px 0' },
  '.cm-line': { padding: '0 14px' },
  '.cm-cursor': { borderLeftColor: 'var(--brand)' },
  '.cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--brand) 18%, transparent)', outline: 'none' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 30%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--panel-2)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--border)' },
});

const highlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: '650', color: 'var(--text)' },
  { tag: t.strong, fontWeight: '650' },
  { tag: t.emphasis, fontStyle: 'normal', textDecoration: 'underline dotted' },
  { tag: [t.link, t.url], color: 'var(--brand)' },
  { tag: t.monospace, color: 'var(--t-feedback)' },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--brand-ink)' },
  { tag: [t.string, t.content], color: 'var(--text)' },
  { tag: [t.meta, t.processingInstruction, t.punctuation, t.separator], color: 'var(--text-3)' },
  { tag: t.quote, color: 'var(--text-2)' },
]);

// 精簡設定：只留編輯 Markdown 需要的功能（不含自動完成、lint、HTML／JS 語法），打包小一半
const baseExtensions = () => [
  lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(),
  highlightActiveLine(), highlightSelectionMatches(),
  keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
  EditorView.lineWrapping,
  yamlFrontmatter({ content: markdownLanguage }),
  theme,
  syntaxHighlighting(highlight),
  EditorView.contentAttributes.of({ spellcheck: 'false', lang: 'zh-Hant-TW' }),
];

export function Editor({ value, onChange, label = '編輯內容' }) {
  const host = useRef(null);
  const view = useRef(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    view.current = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          ...baseExtensions(),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of((u) => { if (u.docChanged) cb.current?.(u.state.doc.toString()); }),
        ],
      }),
    });
    return () => view.current?.destroy();
  }, []);
  // 外部值改變（例如切換到另一筆記憶）時同步內容
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);
  return <div class="editor" ref={host} />;
}

// 衝突合併：左邊是這台的版本（可編輯，成為結果），右邊是對方的版本；中間箭頭可把對方的區塊搬過來
// 內建的搬移鈕只是一個小字元箭頭，點不準也沒有中文說明；改成有按鈕外框的箭頭
function revertButton() {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'merge-take';
  b.title = '用右邊這段取代左邊';
  b.setAttribute('aria-label', '用右邊這段取代左邊');
  b.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M13 8H3m4-4L3 8l4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return b;
}

export function Merge({ ours, theirs, onChange }) {
  const host = useRef(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    const mv = new MergeView({
      parent: host.current,
      a: { doc: ours, extensions: [...baseExtensions(), EditorView.updateListener.of((u) => { if (u.docChanged) cb.current?.(u.state.doc.toString()); })] },
      b: { doc: theirs, extensions: [...baseExtensions(), EditorState.readOnly.of(true), EditorView.editable.of(false)] },
      revertControls: 'b-to-a',
      renderRevertControl: revertButton,
      highlightChanges: true,
      gutter: true,
    });
    return () => mv.destroy();
  }, []);
  return <div class="editor merge-wrap" ref={host} />;
}
