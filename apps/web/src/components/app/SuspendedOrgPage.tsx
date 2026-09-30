/**
 * Console v1 Slice 3b, Addition 3 (docs/plans/console-plan.md): rendered by
 * app/app/layout.tsx INSTEAD of the normal AppShell/Sidebar/TopBar/children
 * tree whenever the caller's resolved org is suspended — no nav, no "broken
 * buttons" whose writes would just 403/RLS-deny underneath. /console/* is a
 * fully separate route tree (see console/layout.tsx) and never renders this.
 *
 * Precision Dark redesign (Step 3): rebuilt as the full-page two-column
 * takeover from designs/nia-design-source/HomeStates.dc.html's SUSPENDED
 * section, rather than the earlier centered card. No "Contact support"
 * destination exists anywhere in the app yet, so the footer bar stays
 * plain text (no href/button) rather than a dead-end link.
 */
export default function SuspendedOrgPage({ orgName, reason }: { orgName: string; reason: string | null }) {
  return (
    <div
      data-app-theme=""
      data-om-theme="light"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
        background: 'var(--nx-bg)',
        color: 'var(--nx-ink)',
        fontFamily: 'var(--nx-font-ui)',
        WebkitFontSmoothing: 'antialiased',
      }}
    >
      <div
        style={{
          padding: 40,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          borderRight: '1px solid var(--nx-line)',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--nx-font-condensed)',
            fontStretch: '62.5%',
            fontWeight: 700,
            fontSize: 16,
            letterSpacing: '0.04em',
            color: 'var(--nx-danger-text)',
          }}
        >
          ACCESS PAUSED
        </span>
        <h2
          style={{
            margin: 0,
            fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
            fontSize: 72,
            lineHeight: '70px',
            fontWeight: 500,
            letterSpacing: '-0.05em',
          }}
        >
          This organization is suspended
        </h2>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <p style={{ margin: 0, padding: '40px 32px 24px', fontSize: 18, lineHeight: '28px' }}>
          {orgName} has been suspended and can no longer be accessed. Contact support to restore access.
        </p>
        {reason && (
          <p
            style={{
              margin: 0,
              padding: '0 32px 32px',
              fontFamily: 'var(--nx-font-mono)',
              fontSize: 13,
              lineHeight: '20px',
              color: 'var(--nx-ink-3)',
            }}
          >
            REASON: {reason}
          </p>
        )}
        <div
          style={{
            marginTop: 'auto',
            height: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 32px',
            borderTop: '1px solid var(--nx-line)',
            color: 'var(--nx-ink)',
            fontFamily: 'var(--nx-font-mono)',
            fontSize: 13,
            fontWeight: 500,
            letterSpacing: '0.06em',
          }}
        >
          CONTACT SUPPORT
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
            <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" />
          </svg>
        </div>
      </div>
    </div>
  );
}
