// 線條圖示：24×24、1.75 線寬、跟隨文字色。只收介面實際用到的。
import { h } from 'preact';

const make = (d) => (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" {...props}>{d}</svg>
);

export const IconOverview = make(<><path d="M4 13a8 8 0 0 1 16 0" /><path d="M12 13l4-4" /><circle cx="12" cy="13" r="1.2" /><path d="M4 17h16" /></>);
export const IconLibrary = make(<><path d="M5 4h4v16H5z" /><path d="M11 4h4v16h-4z" /><path d="m17 5 3 .8-3.6 14.2-3-.8" /></>);
export const IconInbox = make(<><path d="M4 13l2.5-7h11L20 13" /><path d="M4 13v5h16v-5h-5a3 3 0 0 1-6 0z" /></>);
export const IconProjects = make(<><path d="M3.5 7.5V18a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-8l-2-2.5h-5a1 1 0 0 0-1 1z" /></>);
export const IconDevices = make(<><rect x="3" y="4.5" width="13" height="9.5" rx="1.2" /><path d="M7 18h5M9.5 14v4" /><rect x="17.5" y="9" width="4" height="10" rx="1" /></>);
export const IconCore = make(<><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z" /><path d="M14 3.5V8h4" /><path d="M10 12.5h5M10 16h5" /><circle cx="4.5" cy="12" r="1.3" fill="currentColor" stroke="none" /></>);
export const IconSchedule = make(<><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></>);
export const IconImport = make(<><path d="M12 4v10" /><path d="m8 10 4 4 4-4" /><path d="M5 15v3.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V15" /></>);
export const IconSearch = make(<><circle cx="11" cy="11" r="6" /><path d="m20 20-4.2-4.2" /></>);
export const IconSync = make(<><path d="M20 12a8 8 0 0 1-13.7 5.6" /><path d="M4 12a8 8 0 0 1 13.7-5.6" /><path d="M18 3v3.6h-3.6" /><path d="M6 21v-3.6h3.6" /></>);
export const IconGlobe = make(<><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17" /><path d="M12 3.5c2.4 2.4 3.4 5.2 3.4 8.5S14.4 18.1 12 20.5C9.6 18.1 8.6 15.3 8.6 12S9.6 5.9 12 3.5z" /></>);
export const IconFolder = make(<><path d="M3.5 7.5V18a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-8l-2-2.5h-5a1 1 0 0 0-1 1z" /></>);
export const IconMonitor = make(<><rect x="3" y="4.5" width="18" height="12" rx="1.5" /><path d="M8.5 20h7M12 16.5V20" /></>);
export const IconCheck = make(<><path d="m5 12.5 4.5 4.5L19 7.5" /></>);
export const IconCheckCircle = make(<><circle cx="12" cy="12" r="8.5" /><path d="m8 12.3 2.8 2.8L16.2 9.6" /></>);
export const IconAlert = make(<><path d="M12 4 21 19.5H3z" /><path d="M12 10v4.2" /><circle cx="12" cy="17" r=".6" fill="currentColor" /></>);
export const IconOctagon = make(<><path d="M8.3 3.5h7.4l5.2 5.2v7.4l-5.2 5.2H8.3l-5.2-5.2V8.7z" /><path d="M12 8v5" /><circle cx="12" cy="16" r=".6" fill="currentColor" /></>);
export const IconInfo = make(<><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5" /><circle cx="12" cy="8" r=".6" fill="currentColor" /></>);
export const IconX = make(<><path d="M6 6l12 12M18 6 6 18" /></>);
export const IconPin = make(<><path d="M9 3.5h6l-1 5.5 3.5 3.5H6.5L10 9z" /><path d="M12 12.5V20" /></>);
export const IconEdit = make(<><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>);
export const IconMove = make(<><path d="M4 8h13" /><path d="m14 4.5 3.5 3.5L14 11.5" /><path d="M20 16H7" /><path d="M10 12.5 6.5 16l3.5 3.5" /></>);
export const IconMerge = make(<><circle cx="6.5" cy="5.5" r="2" /><circle cx="6.5" cy="18.5" r="2" /><circle cx="17.5" cy="12" r="2" /><path d="M6.5 7.5v9" /><path d="M6.5 7.5c0 3 3 4.5 9 4.5" /></>);
export const IconTrash = make(<><path d="M4.5 7h15" /><path d="M9.5 7V4.5h5V7" /><path d="M6.5 7l1 13h9l1-13" /><path d="M10.5 11v5.5M13.5 11v5.5" /></>);
export const IconHistory = make(<><path d="M4 12a8 8 0 1 0 2.4-5.7" /><path d="M4 4v3.5h3.5" /><path d="M12 8v4.3l2.8 1.7" /></>);
export const IconUndo = make(<><path d="M9 7 4.5 11.5 9 16" /><path d="M5 11.5h9a5 5 0 0 1 0 10h-2" /></>);
export const IconLink = make(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>);
export const IconPlus = make(<><path d="M12 5v14M5 12h14" /></>);
export const IconChevronRight = make(<><path d="m9 5 7 7-7 7" /></>);
export const IconChevronDown = make(<><path d="m5 9 7 7 7-7" /></>);
export const IconExternal = make(<><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>);
export const IconKey = make(<><circle cx="8" cy="15" r="4" /><path d="m11 12 8.5-8.5" /><path d="m16 7 2.5 2.5" /><path d="m18.5 4.5 2 2" /></>);
export const IconPlay = make(<><path d="M7 4.5v15l12-7.5z" /></>);
export const IconSparkle = make(<><path d="M12 3.5l1.8 5 5 1.8-5 1.8-1.8 5-1.8-5-5-1.8 5-1.8z" /><path d="M19 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></>);
export const IconShield = make(<><path d="M12 3.5 19 6v5.5c0 4.4-3 7.7-7 9-4-1.3-7-4.6-7-9V6z" /><path d="m9 12 2.2 2.2L15.5 10" /></>);
export const IconEye = make(<><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>);
export const IconFile = make(<><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z" /><path d="M14 3.5V8h4" /></>);
export const IconCloud = make(<><path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.7 4.7 0 0 0 7 18.5z" /></>);
export const IconPower = make(<><path d="M12 3.5V12" /><path d="M7 6.5a7 7 0 1 0 10 0" /></>);
export const IconSun = make(<><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" /></>);
export const IconMoon = make(<><path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z" /></>);
export const IconSettings = make(<><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2.1 1.2M17.7 15.3l2.1 1.2M4.2 16.5l2.1-1.2M17.7 8.7l2.1-1.2" /><circle cx="12" cy="12" r="6.6" /></>);
export const IconBack = make(<><path d="M15 5 8 12l7 7" /></>);
export const IconTidy = make(<><rect x="5" y="4.5" width="14" height="16" rx="1.5" /><path d="M9 4.5V3.5h6v1" /><path d="m8.5 12.5 2.2 2.2 4.8-4.8" /></>);
export const IconArchive = make(<><rect x="3.5" y="4.5" width="17" height="4" rx="1" /><path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5" /><path d="M10 12.5h4" /></>);

// Engram 標誌：一筆畫的 e 跟隨 currentColor，紅點固定使用 --dot
export function EngramLogo(props) {
  return (
    <svg viewBox="0 0 48 48" role="img" aria-label="Engram" {...props}>
      <path d="M11 24H37A13 13 0 1 0 21.74 36.8" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
      <circle cx="33.66" cy="34" r="4.6" fill="var(--dot)" />
    </svg>
  );
}
