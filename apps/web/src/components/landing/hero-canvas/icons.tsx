import { useId } from 'react';
import type { NodeGlyph } from './config';

// Real brand logomarks (Supabase, Slack, Power BI, Anthropic/Claude),
// reproduced verbatim from each vendor's official artwork, for the nodes
// that represent actual third-party tools. `clock` (Schedule) and `branch`
// (Route by Type) stay as neutral stroke glyphs — they're generic workflow
// primitives, not third-party tools, so there's no brand mark to reproduce.
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
    case 'branch':
      return (
        <svg {...common} aria-hidden="true">
          <path d="M6 4v9c0 2 1.5 3.5 3.5 3.5H14" />
          <path d="M11.5 14 15 16.5l-3.5 2.5" />
          <circle cx="6" cy="4" r="1.8" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'claude':
      // Anthropic's official symbol mark (source: Wikimedia Commons,
      // "Claude AI symbol.svg"), reproduced verbatim in its brand color.
      return (
        <svg width={size} height={size} viewBox="0 0 100 100" fill="hsl(14.8, 63.1%, 59.6%)" aria-hidden="true">
          <path d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z" />
        </svg>
      );
    case 'powerbi': {
      // Microsoft Power BI's official mark (source: Wikimedia Commons,
      // "New Power BI Logo.svg"), reproduced verbatim minus its drop shadow
      // (not meaningful at 28px tile size).
      const gid = `${gradId}-pbi`;
      return (
        <svg width={size} height={size} viewBox="0 0 630 630" aria-hidden="true">
          <defs>
            <linearGradient id={`${gid}-1`} x1="50%" y1="0%" x2="50%" y2="100%">
              <stop stopColor="#EBBB14" offset="0%" />
              <stop stopColor="#B25400" offset="100%" />
            </linearGradient>
            <linearGradient id={`${gid}-2`} x1="50%" y1="0%" x2="50%" y2="100%">
              <stop stopColor="#F9E583" offset="0%" />
              <stop stopColor="#DE9800" offset="100%" />
            </linearGradient>
            <linearGradient id={`${gid}-3`} x1="50%" y1="0%" x2="50%" y2="100%">
              <stop stopColor="#F9E68B" offset="0%" />
              <stop stopColor="#F3CD32" offset="100%" />
            </linearGradient>
          </defs>
          <g transform="translate(77.5, 0)">
            <rect fill={`url(#${gid}-1)`} x="256" y="0" width="219" height="630" rx="26" />
            <path
              fill={`url(#${gid}-2)`}
              d="M346,604 L346,630 L320,630 L153,630 C138.640597,630 127,618.359403 127,604 L127,183 C127,168.640597 138.640597,157 153,157 L320,157 C334.359403,157 346,168.640597 346,183 L346,604 Z"
            />
            <path
              fill={`url(#${gid}-3)`}
              d="M219,604 L219,630 L193,630 L26,630 C11.6405965,630 1.75851975e-15,618.359403 0,604 L0,341 C-1.75851975e-15,326.640597 11.6405965,315 26,315 L193,315 C207.359403,315 219,326.640597 219,341 L219,604 Z"
            />
          </g>
        </svg>
      );
    }
    case 'slack':
      // Slack's official 2019 icon mark (source: Wikimedia Commons,
      // "Slack icon 2019.svg"), reproduced verbatim in its 4 brand colors.
      return (
        <svg width={size} height={size} viewBox="0 0 127 127" aria-hidden="true">
          <path
            d="M27.2 80c0 7.3-5.9 13.2-13.2 13.2C6.7 93.2.8 87.3.8 80c0-7.3 5.9-13.2 13.2-13.2h13.2V80zm6.6 0c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2v33c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V80z"
            fill="#E01E5A"
          />
          <path
            d="M47 27c-7.3 0-13.2-5.9-13.2-13.2C33.8 6.5 39.7.6 47 .6c7.3 0 13.2 5.9 13.2 13.2V27H47zm0 6.7c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H13.9C6.6 60.1.7 54.2.7 46.9c0-7.3 5.9-13.2 13.2-13.2H47z"
            fill="#36C5F0"
          />
          <path
            d="M99.9 46.9c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H99.9V46.9zm-6.6 0c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V13.8C66.9 6.5 72.8.6 80.1.6c7.3 0 13.2 5.9 13.2 13.2v33.1z"
            fill="#2EB67D"
          />
          <path
            d="M80.1 99.8c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V99.8h13.2zm0-6.6c-7.3 0-13.2-5.9-13.2-13.2 0-7.3 5.9-13.2 13.2-13.2h33.1c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H80.1z"
            fill="#ECB22E"
          />
        </svg>
      );
    default:
      return null;
  }
}
