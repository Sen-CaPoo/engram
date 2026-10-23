// 編輯器延後載入：CodeMirror 只有在真的要編輯或比對時才下載，其他頁面不必載入這 400 KB。
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Skeleton } from './components.jsx';

let mod = null;
const load = () => (mod ??= import('./editor.jsx'));

function useEditorModule() {
  const [m, setM] = useState(null);
  useEffect(() => { let alive = true; load().then((x) => alive && setM(x)); return () => { alive = false; }; }, []);
  return m;
}

export function Editor(props) {
  const m = useEditorModule();
  return m ? <m.Editor {...props} /> : <div class="editor"><Skeleton rows={4} /></div>;
}

export function Merge(props) {
  const m = useEditorModule();
  return m ? <m.Merge {...props} /> : <div class="editor"><Skeleton rows={6} /></div>;
}
