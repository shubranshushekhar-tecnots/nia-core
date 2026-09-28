import type { IconComponent } from './icons';

/**
 * Chrome/nav icon set — separate from icons.tsx (which is explicitly scoped
 * to connector/category icons for graph nodes). Used by the shared
 * Sidebar.tsx's nav items and CanvasHeader.tsx/FlowCanvas.tsx's Copilot
 * panel toggle.
 * Same convention as icons.tsx: monochrome inline SVG, `currentColor`,
 * viewBox 24x24, 1.6 stroke, round caps/joins.
 */

export const HomeIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M4 11.5 12 4l8 7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M6 10v9.5h12V10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M10 19.5v-6h4v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const ChatIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H10l-4.5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5v-7Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
);

export const ProjectsIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M4 7.5c0-1.1.9-2 2-2h3.5l1.5 2H18c1.1 0 2 .9 2 2v6.5c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2v-6.5Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
);

export const ConnectionsIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M9 15 15 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <path
      d="M11 6.5 12.5 5A3 3 0 0 1 17 9.5L15.5 11M13 17.5 11.5 19A3 3 0 0 1 7 14.5L8.5 13"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Runs nav placeholder — a workflow run-history page doesn't exist yet
 * (no /app/runs route), so this renders only as a disabled "soon" item in
 * Sidebar.tsx, matching the existing Org dashboard/Members/Audit log gaps. */
export const RunsIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.6" />
    <path d="M10 8.5 15.5 12 10 15.5V8.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);

export const BillingIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="3.5" y="6" width="17" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
    <path d="M3.5 10h17" stroke="currentColor" strokeWidth="1.6" />
    <path d="M7 14.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const SettingsIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="12" cy="12" r="2.8" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M17.7 6.3l-1.55 1.55M7.85 16.15 6.3 17.7M17.7 17.7l-1.55-1.55M7.85 7.85 6.3 6.3"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);

export const PlusIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

export const ChevronLeftIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M15 5 8 12l7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const ChevronRightIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Neutral "toggle side panel" glyph — used for the Copilot toggle in
 * CanvasHeader/FlowCanvas so the panel-open action doesn't repeat the Nia
 * brand mark that CopilotSidebar itself already shows. */
export const PanelToggleIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
    <path d="M14.5 4.5v15" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

/** Voice-input glyph — replaces the 🎤 emoji in CommandBar.tsx's input bar
 * with a monochrome mic outline matching this file's icon convention. */
export const MicIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="9" y="3.5" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.6" />
    <path d="M6 11.5v1a6 6 0 0 0 12 0v-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <path d="M12 18.5v2.2M9 20.7h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

/** Replaces the viewport toolbar's old `\u2317` ("⌘"-like) fit-view glyph —
 * four corner brackets around a center dot read unambiguously as "fit all
 * content in view", matching this file's monochrome convention. */
export const FitViewIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M4 9V6.5A2.5 2.5 0 0 1 6.5 4H9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M15 4h2.5A2.5 2.5 0 0 1 20 6.5V9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M20 15v2.5a2.5 2.5 0 0 1-2.5 2.5H15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9 20H6.5A2.5 2.5 0 0 1 4 17.5V15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" />
  </svg>
);

/** Select/pointer-mode glyph for the toolbar's interaction-mode toggle —
 * a plain arrow cursor, distinct from PanHandIcon's open-hand glyph. */
export const SelectPointerIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M6 4.5 18 14l-5.2.6L15 20l-2.4 1L10 15.6 6.5 19V4.5Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      fill="currentColor"
      fillOpacity="0.06"
    />
  </svg>
);

/** Pan-mode glyph for the toolbar's interaction-mode toggle — an open hand
 * outline, distinct from SelectPointerIcon's arrow cursor. */
export const PanHandIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M8 12.5V6a1.5 1.5 0 0 1 3 0v5.2M11 11V4.8a1.5 1.5 0 0 1 3 0V11M14 11.2V6.3a1.5 1.5 0 0 1 3 0v7.4M17 12.5v-1a1.5 1.5 0 0 1 3 0v5.2c0 3.1-2.2 5.8-5.5 5.8h-2c-2 0-3-.6-4.2-2l-3.1-3.7a1.6 1.6 0 0 1 2.3-2.2l1.5 1.3"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Undo glyph — curved arrow pointing left, for the toolbar's (currently
 * disabled, no history stack yet) undo button. */
export const UndoIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M7 8H16a4.5 4.5 0 0 1 0 9h-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M10 4.5 6.5 8 10 11.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Redo glyph — mirror of UndoIcon, for the toolbar's (currently disabled,
 * no history stack yet) redo button. */
export const RedoIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M17 8H8a4.5 4.5 0 0 0 0 9h3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M14 4.5 17.5 8 14 11.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Small pencil glyph next to the workflow name in CanvasHeader — currently
 * always disabled (no rename endpoint exists yet), so this only signals
 * "renaming will live here" rather than being a working affordance today. */
export const EditIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M15 5.5 18.5 9 8 19.5H4.5V16L15 5.5Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
