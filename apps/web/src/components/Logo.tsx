/**
 * Single shared brand mark (UI feedback item 3 — "keep the same logo
 * everywhere"). Replaces the placeholder `/logo.svg` wordmark with the real
 * brand asset (`/splash-icon.png`) across every surface that shows the Nia
 * logo. `--text` is used for the wordmark color (not a hardcoded hex) —
 * it's defined at bare `:root` in theme.css, so it resolves correctly in
 * every scope (landing/auth/app) without needing scope-specific tokens.
 */
export default function Logo({ size = 24, showWordmark = true }: { size?: number; showWordmark?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.35, minWidth: 0 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/splash-icon.png"
        alt="Nia Core"
        style={{ height: size, width: size, borderRadius: '50%', objectFit: 'cover', flex: 'none' }}
      />
      {showWordmark && (
        <span
          style={{
            fontSize: Math.round(size * 0.62),
            fontWeight: 600,
            color: 'var(--text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          Nia Core
        </span>
      )}
    </span>
  );
}
