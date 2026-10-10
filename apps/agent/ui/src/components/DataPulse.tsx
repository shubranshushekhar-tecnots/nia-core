/**
 * The in-app "data pulse" from designs/nia-agent-icons/SPEC.md's "In-app pulse" section: a
 * continuous 2400ms loop drawn live as SVG (not frames) over the Nia logo glyph -- a halo blooms
 * on the block, then a soft dot runs along each connecting line into the next square, lighting it
 * up, before a brief rest makes the loop seamless. Geometry is taken directly from
 * designs/nia-agent-icons/svg/nia-logo-master.svg's 235x235 viewBox.
 *
 * Shown only while `active` (i.e. status.isSyncing); otherwise renders the plain static glyph.
 * Respects `prefers-reduced-motion` (see ui.css) by swapping to a slow breathe on the squares
 * instead of the full animation, per the spec's reduced-motion fallback.
 */
export function DataPulse({ active, className }: { active: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 235 235"
      className={`nia-pulse${active ? " nia-pulse--active" : ""}${className ? ` ${className}` : ""}`}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="nia-pulse-bg" cx="0.96" cy="0.96" r="1.28" gradientUnits="objectBoundingBox">
          <stop offset="0" stopColor="#C9C3D9" />
          <stop offset=".15" stopColor="#BFB8D8" />
          <stop offset=".4" stopColor="#988FE5" />
          <stop offset=".68" stopColor="#746CDE" />
          <stop offset="1" stopColor="#655DDA" />
        </radialGradient>
        <filter id="nia-pulse-blur" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
      </defs>

      <rect width="235" height="235" rx="56" fill="url(#nia-pulse-bg)" />

      {/* Static glyph -- always visible. */}
      <path
        d="M70 58 H114 A9 9 0 0 1 123 67 V92 H74 A8.5 8.5 0 0 0 74 109 H115 A8 8 0 0 1 123 117 V142 H70 A8 8 0 0 1 62 134 V66 A8 8 0 0 1 70 58 Z"
        fill="#fff"
      />
      <line x1="120.3" y1="89.6" x2="140.3" y2="109.6" stroke="#fff" strokeWidth="4.3" />
      <line x1="120.3" y1="139.9" x2="140.6" y2="160.2" stroke="#fff" strokeWidth="4.3" />
      <rect className="nia-pulse-sq1" x="140" y="58" width="33" height="34" rx="8" fill="#fff" />
      <rect className="nia-pulse-sq2" x="140" y="109" width="33" height="33" rx="8" fill="#fff" />
      <rect className="nia-pulse-sq3" x="140" y="161" width="33" height="34" rx="8" fill="#fff" />

      {/* Blurred halo duplicates -- transparent until animated. */}
      <path
        className="nia-pulse-halo nia-pulse-halo--block"
        filter="url(#nia-pulse-blur)"
        fill="#fff"
        d="M70 58 H114 A9 9 0 0 1 123 67 V92 H74 A8.5 8.5 0 0 0 74 109 H115 A8 8 0 0 1 123 117 V142 H70 A8 8 0 0 1 62 134 V66 A8 8 0 0 1 70 58 Z"
      />
      <rect className="nia-pulse-halo nia-pulse-halo--sq1" filter="url(#nia-pulse-blur)" fill="#fff" x="140" y="58" width="33" height="34" rx="8" />
      <rect className="nia-pulse-halo nia-pulse-halo--sq2" filter="url(#nia-pulse-blur)" fill="#fff" x="140" y="109" width="33" height="33" rx="8" />
      <rect className="nia-pulse-halo nia-pulse-halo--sq3" filter="url(#nia-pulse-blur)" fill="#fff" x="140" y="161" width="33" height="34" rx="8" />

      {/* Traveling dots along line 1 / line 2 -- invisible except mid-travel. */}
      <circle className="nia-pulse-dot nia-pulse-dot--line1" r="3.2" fill="#fff" cx="120.3" cy="89.6" />
      <circle className="nia-pulse-dot nia-pulse-dot--line2" r="3.2" fill="#fff" cx="120.3" cy="139.9" />
    </svg>
  );
}
