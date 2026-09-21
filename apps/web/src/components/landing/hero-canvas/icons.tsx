import { useId } from 'react';
import type { NodeGlyph } from './config';

// Neutral stroke glyphs for the 28px icon tile, plus the real Supabase
// logomark (brand asset, reproduced verbatim). The rest are intentionally
// generic (clock/sparkle/branch/bar-chart/chat-bubble) rather than the real
// Slack / Power BI / Anthropic marks — swap in licensed brand assets here
// later.
// TODO(brand-assets): replace with licensed Slack / Power BI / Anthropic
// marks once available; tiles are sized and ready for them.
export default function NodeGlyphIcon({ glyph, size = 14 }: { glyph: NodeGlyph; size?: number }) {
  const gradId = useId();
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  switch (glyph) {
    case 'clock':
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3.2 2" />
        </svg>
      );
    case 'supabase':
      return (
        <svg width={size} height={size} viewBox="0 0 109 113" fill="none" aria-hidden="true">
          <path
            d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z"
            fill={`url(#${gradId}-a)`}
          />
          <path
            d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z"
            fill={`url(#${gradId}-b)`}
            fillOpacity={0.2}
          />
          <path
            d="M45.317 2.07103C48.1765 -1.53037 53.9745 0.442937 54.0434 5.04075L54.4849 72.2922H9.87254C1.68189 72.2922 -2.88632 62.8321 2.2075 56.4175L45.317 2.07103Z"
            fill="#3ECF8E"
          />
          <defs>
            <linearGradient id={`${gradId}-a`} x1="53.9738" y1="54.974" x2="94.1635" y2="71.8295" gradientUnits="userSpaceOnUse">
              <stop stopColor="#249361" />
              <stop offset="1" stopColor="#3ECF8E" />
            </linearGradient>
            <linearGradient id={`${gradId}-b`} x1="36.1558" y1="30.578" x2="54.4844" y2="65.0806" gradientUnits="userSpaceOnUse">
              <stop />
              <stop offset="1" stopOpacity="0" />
            </linearGradient>
          </defs>
        </svg>
      );
    case 'sparkle':
      return (
        <svg {...common} aria-hidden="true">
          <path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8-1.8 5.2-1.8-5.2-5.2-1.8 5.2-1.8z" />
        </svg>
      );
    case 'branch':
      return (
        <svg {...common} aria-hidden="true">
          <path d="M6 4v9c0 2 1.5 3.5 3.5 3.5H14" />
          <path d="M11.5 14 15 16.5l-3.5 2.5" />
          <circle cx="6" cy="4" r="1.8" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'chart':
      return (
        <svg {...common} aria-hidden="true">
          <path d="M5 19V10" />
          <path d="M12 19V5" />
          <path d="M19 19v-6" />
          <path d="M3.5 19.5h17" strokeWidth={1.2} />
        </svg>
      );
    case 'chat':
      return (
        <svg {...common} aria-hidden="true">
          <path d="M4.5 6.5A2.5 2.5 0 0 1 7 4h10a2.5 2.5 0 0 1 2.5 2.5v6A2.5 2.5 0 0 1 17 15H9.5L5.5 18.5V15H7A2.5 2.5 0 0 1 4.5 12.5z" />
        </svg>
      );
    default:
      return null;
  }
}
