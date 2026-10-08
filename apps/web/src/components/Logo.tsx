/**
 * Single shared brand mark (UI feedback item 3 — "keep the same logo
 * everywhere"). Renders the current brand asset (`/logo-mark.png`) across
 * every surface that shows the Nia logo. `--text` is used for the wordmark
 * color (not a hardcoded hex) — it's defined at bare `:root` in theme.css,
 * so it resolves correctly in every scope (landing/auth/app) without
 * needing scope-specific tokens.
 *
 * The "Nia AI" copilot assistant (CopilotSidebar/CommandBar/canvas toggle)
 * intentionally keeps the older `/splash-icon.png` mark as its avatar —
 * those call sites pass `src="/splash-icon.png"` explicitly so the brand
 * logo can change without touching the assistant's identity.
 */
export default function Logo({
  size = 24,
  showWordmark = true,
  wordmarkColor = 'var(--text)',
  src = '/logo-mark.png',
}: {
  size?: number;
  showWordmark?: boolean;
  /** Override for the wordmark color (e.g. a scoped custom property with a
   *  `var(--text)` fallback) — used by Nav to swap to a light wordmark while
   *  pinned over the dark hero island. */
  wordmarkColor?: string;
  /** Override for the mark image — used by the "Nia AI" assistant surfaces
   *  to keep the older mark instead of the current brand logo. */
  src?: string;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.35, minWidth: 0 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="Nia Core"
        style={{ height: size, width: size, borderRadius: '22%', objectFit: 'cover', flex: 'none' }}
      />
      {showWordmark && (
        <span
          style={{
            fontSize: Math.round(size * 0.62),
            fontWeight: 600,
            color: wordmarkColor,
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
