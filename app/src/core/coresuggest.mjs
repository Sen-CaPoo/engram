// 核心準則的建議更新（1.4.0，H24）。新安裝的範本已經包含這些內容；既有使用者的 CORE.md 屬於使用者，
// Engram 不自己改，只在找得到原本範本的位置、而且還沒加過時提出，使用者在介面按「加入」才寫入（可復原）。
// 內容依 Anthropic〈Components of agent memory〉：告訴 Claude 記憶是為了什麼（而不是規定怎麼記），並記下驗證方式。

export const SUGGESTIONS = [
  {
    id: 'memory-purpose',
    title: '說明記憶是為了什麼',
    titleEn: 'Explain what memory is for',
    reason: 'Anthropic 的記憶研究發現：告訴 Claude 記憶的用途、讓它自己判斷值得記什麼，比規定死規則（例如「只記失敗」）效果好。',
    reasonEn: "Anthropic's memory research found that telling Claude what memory is for, and letting it judge what is worth keeping, works better than fixed rules (such as \"record only failures\").",
    anchor: /^## 3\. 記憶寫入協定[^\n]*$/m,
    present: /記憶是寫給之後的對話用的/,
    insert: '\n\n記憶是寫給之後的對話用的：記下之後用得到、而且不寫下來就會遺失的事，例如使用者的偏好與糾正、做過的決定與原因、驗證過的做法、踩過的坑。值不值得記由你判斷，不必每次對話都寫。',
  },
  {
    id: 'verify-note',
    title: '寫下規則時註明怎麼確認的',
    titleEn: 'Note how a rule was confirmed',
    reason: '記下驗證方式（實測、查文件或推測），之後的對話才知道能信任到什麼程度；說法不對時直接更新，避免錯誤的記憶一直被讀到。',
    reasonEn: 'Recording how something was confirmed (tested, from docs, or a guess) tells later conversations how far to trust it; fixing a wrong note right away keeps it from being read again and again.',
    anchor: /^- 一律寫絕對日期[^\n]*$/m,
    present: /註明怎麼確認的/,
    insert: '\n- 寫下規則或做法時，註明怎麼確認的（實測、查文件或推測）；之後發現說法不對，直接更新那一筆。',
  },
];

/** 目前的 CORE.md 可以加入的建議（找不到原本的位置、或已經加過的不列） */
export function suggestionsFor(text) {
  const t = String(text ?? '').replace(/\r\n/g, '\n');
  return SUGGESTIONS.filter((s) => s.anchor.test(t) && !s.present.test(t)).map((s) => ({
    id: s.id, title: s.title, reason: s.reason, text: s.insert.trim(),
    en: { title: s.titleEn, reason: s.reasonEn },
  }));
}

/** 把選定的建議插入（各自接在錨點那一行之後）；回傳新內容。沒有任何一項可加時回傳 null。 */
export function applySuggestions(text, ids) {
  let t = String(text ?? '').replace(/\r\n/g, '\n');
  let n = 0;
  for (const s of SUGGESTIONS) {
    if (!ids.includes(s.id) || !s.anchor.test(t) || s.present.test(t)) continue;
    const m = s.anchor.exec(t);
    const at = m.index + m[0].length;
    t = `${t.slice(0, at)}${s.insert}${t.slice(at)}`;
    n++;
  }
  return n ? t : null;
}
