import {
  siMysql,
  siMongodb,
  siSupabase,
  siPostgresql,
  siSnowflake,
  siGooglebigquery,
  siMetabase,
  siQdrant,
} from 'simple-icons';
import { CONNECTOR_CATALOG_META } from '@/lib/connections/catalogMeta';

// Only the 8 of the 12 catalog vendors simple-icons@16.31.0 actually ships
// a mark for (confirmed via `node -e` against the installed package —
// see catalogMeta.ts's header comment) are statically imported here; the
// other 4 ids (redshift, lookerstudio, pinecone, s3) have no `iconSlug` in
// CONNECTOR_CATALOG_META and always render the initials fallback below.
const ICONS: Record<string, { path: string; hex: string; title: string }> = {
  mysql: siMysql,
  mongodb: siMongodb,
  supabase: siSupabase,
  postgresql: siPostgresql,
  snowflake: siSnowflake,
  googlebigquery: siGooglebigquery,
  metabase: siMetabase,
  qdrant: siQdrant,
};

/**
 * Real vendor brand mark (fixed brand hex, never `currentColor` — a
 * recolored trademarked logo isn't recognizable, same rationale as
 * components/canvas/icons.tsx's CONNECTOR_ICONS) on a plain white tile so
 * the color reads true. Falls back to a 2-letter initials tile for
 * catalog ids with no simple-icons mark yet.
 *
 * `variant="onDark"` is for placement on the connector card's hover-view
 * near-black background (styles.ts's connectorCardShellStyle) — real
 * vendor marks keep their fixed brand hex either way (never recolor a
 * trademarked logo), only the initials-fallback tint switches to a
 * light-on-dark color.
 *
 * `fill` makes the mark size itself to 100% of its parent box instead of
 * `size` pixels, so it can be CSS-transitioned by an ancestor whose own
 * width/height animate (the card's connectorLogoBoxStyle) — table-row
 * callers that just want a fixed pixel icon leave this off.
 */
export default function ConnectorLogo({
  id,
  size = 22,
  variant = 'default',
  fill = false,
}: {
  id: string;
  size?: number;
  variant?: 'default' | 'onDark';
  fill?: boolean;
}) {
  const meta = CONNECTOR_CATALOG_META[id];
  const icon = meta?.iconSlug ? ICONS[meta.iconSlug] : undefined;

  if (!icon) {
    const initials = (meta?.name ?? id).slice(0, 2).toUpperCase();
    return (
      <span
        aria-hidden="true"
        style={{
          fontSize: fill ? '55%' : Math.round(size * 0.55),
          fontWeight: 700,
          color: variant === 'onDark' ? '#FFFFFF' : 'var(--text-3)',
        }}
      >
        {initials}
      </span>
    );
  }

  return (
    <svg
      width={fill ? '100%' : size}
      height={fill ? '100%' : size}
      viewBox="0 0 24 24"
      fill={`#${icon.hex}`}
      role="img"
      aria-label={icon.title}
    >
      <path d={icon.path} />
    </svg>
  );
}
