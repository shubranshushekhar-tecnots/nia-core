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
// CONNECTOR_CATALOG_META and always render the monogram-tile fallback below.
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
 * Precision Dark redesign (Step 4, Connections). Real vendor brand marks
 * (fixed brand hex, never recolored — a recolored trademarked logo isn't
 * recognizable, same rationale as components/canvas/icons.tsx's
 * CONNECTOR_ICONS) render on a `--nx-logo-tile` (white, both themes) tile
 * with a 1px `--nx-line` border so the true brand color always reads,
 * regardless of theme. The 4 catalog ids with no simple-icons mark
 * (redshift, lookerstudio, pinecone, s3) render the PDF's solid monogram
 * tile instead: `--nx-ink` background, `--nx-bg` condensed-weight initials.
 *
 * `giant` is the catalog card's bottom-left mark: a bigger 64px tile +
 * 40px logo for real brand marks, or — for the 4 fallback ids — a bare
 * 128px condensed monogram (no tile) in `--nx-raised`, matching the PDF's
 * quiet oversized watermark treatment.
 */
export default function ConnectorLogo({
  id,
  tile = 22,
  giant = false,
  giantColor = 'var(--nx-raised)',
}: {
  id: string;
  /** Tile size in px for the normal (non-giant) render. Logo draws at ~60% of this. */
  tile?: number;
  /** Catalog card's giant bottom-left mark. */
  giant?: boolean;
  /** Monogram-fallback color override for `giant` mode — install/connection-state-aware per the design source's glyph display rule (item 7). Ignored when a real brand mark renders. */
  giantColor?: string;
}) {
  const meta = CONNECTOR_CATALOG_META[id];
  const icon = meta?.iconSlug ? ICONS[meta.iconSlug] : undefined;
  const initials = (meta?.name ?? id).slice(0, 2).toUpperCase();

  if (giant) {
    if (!icon) {
      return (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 16,
            bottom: -12,
            fontFamily: 'var(--nx-font-condensed)',
            fontStretch: '62.5%',
            fontWeight: 800,
            fontSize: 128,
            lineHeight: '112px',
            color: giantColor,
          }}
        >
          {initials}
        </span>
      );
    }
    return (
      <span
        style={{
          position: 'absolute',
          left: 20,
          bottom: 16,
          width: 64,
          height: 64,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--nx-logo-tile)',
          border: '1px solid var(--nx-line)',
        }}
      >
        <svg width={40} height={40} viewBox="0 0 24 24" fill={`#${icon.hex}`} role="img" aria-label={icon.title}>
          <path d={icon.path} />
        </svg>
      </span>
    );
  }

  if (!icon) {
    return (
      <span
        aria-hidden="true"
        style={{
          width: tile,
          height: tile,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--nx-ink)',
          color: 'var(--nx-bg)',
          fontFamily: 'var(--nx-font-condensed)',
          fontStretch: '62.5%',
          fontWeight: 800,
          fontSize: Math.round(tile * 0.4),
        }}
      >
        {initials}
      </span>
    );
  }

  return (
    <span
      style={{
        width: tile,
        height: tile,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--nx-logo-tile)',
        border: '1px solid var(--nx-line)',
      }}
    >
      <svg width={Math.round(tile * 0.6)} height={Math.round(tile * 0.6)} viewBox="0 0 24 24" fill={`#${icon.hex}`} role="img" aria-label={icon.title}>
        <path d={icon.path} />
      </svg>
    </span>
  );
}
