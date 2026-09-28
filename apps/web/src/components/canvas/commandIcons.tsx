import type { IconComponent } from './icons';

/**
 * Icon set for CommandMenu.tsx's "/" command rows only — kept separate from
 * navIcons.tsx (chrome/nav) and icons.tsx (graph node categories/connectors)
 * so each command gets its own distinct glyph (no repeats). Same convention
 * as those files: monochrome inline SVG, `currentColor`, viewBox 24x24, 1.6
 * stroke, round caps/joins.
 */

/** map — two field lists connected by arrows, reads as "map fields across". */
export const MapFieldsIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="6" cy="7" r="1.3" fill="currentColor" />
    <circle cx="6" cy="12" r="1.3" fill="currentColor" />
    <circle cx="6" cy="17" r="1.3" fill="currentColor" />
    <circle cx="18" cy="7" r="1.3" fill="currentColor" />
    <circle cx="18" cy="12" r="1.3" fill="currentColor" />
    <circle cx="18" cy="17" r="1.3" fill="currentColor" />
    <path d="M7.5 7h9M7.5 12h9M7.5 17h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

/** filter — funnel outline. */
export const FilterIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M4 5.5h16l-6 7.5v5l-4-2v-3L4 5.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);

/** aggregate — sigma glyph. */
export const AggregateIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M17 5.5H7l5 6.5-5 6.5h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** clean — sparkle, for "clean up messy values". */
export const SparkleIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M12 3.5 13.3 9 18.5 10.3 13.3 11.6 12 17 10.7 11.6 5.5 10.3 10.7 9 12 3.5Z"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      fill="currentColor"
      fillOpacity="0.08"
    />
    <path
      d="M18.2 15 18.7 16.6 20.3 17.1 18.7 17.6 18.2 19.2 17.7 17.6 16.1 17.1 17.7 16.6 18.2 15Z"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinejoin="round"
      fill="currentColor"
      fillOpacity="0.08"
    />
  </svg>
);

/** status — pulse/heartbeat line, for "check the status of a run". */
export const PulseIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M3.5 12.5h3.5l2-5.5 3.5 11 2-8 1.5 2.5h4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** cancel — stop square. */
export const StopSquareIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="6" y="6" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);

/** preview — eye outline, for "preview sample rows". */
export const EyeIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);
