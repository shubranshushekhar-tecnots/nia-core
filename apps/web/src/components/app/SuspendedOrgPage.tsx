import Logo from '@/components/Logo';

/**
 * Console v1 Slice 3b, Addition 3 (docs/plans/console-plan.md): rendered by
 * app/app/layout.tsx INSTEAD of the normal AppShell/Sidebar/TopBar/children
 * tree whenever the caller's resolved org is suspended — no nav, no "broken
 * buttons" whose writes would just 403/RLS-deny underneath. /console/* is a
 * fully separate route tree (see console/layout.tsx) and never renders this.
 *
 * Precision Dark redesign (Step 3): nx-token restyle, same dark/light scope
 * as AppShell. No "Contact support" destination exists anywhere in the app
 * yet, so this stays text-only rather than adding a dead-end button.
 */
export default function SuspendedOrgPage({ orgName, reason }: { orgName: string; reason: string | null }) {
  return (
    <div
      data-app-theme=""
      data-om-theme="light"
      className="nx-halftone"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 28,
        background: 'var(--nx-bg)',
        color: 'var(--nx-ink)',
        fontFamily: 'var(--nx-font-ui)',
        WebkitFontSmoothing: 'antialiased',
        padding: 24,
      }}
    >
      <Logo size={28} />

      <div
        className="nx-fade-up"
        style={{
          width: 440,
          maxWidth: '100%',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: '28px 28px 26px',
          borderRadius: 'var(--nx-radius)',
          background: 'var(--nx-danger-tint)',
          border: '1px solid var(--nx-line)',
          textAlign: 'center',
          alignItems: 'center',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--nx-font-condensed)',
            fontStretch: '62.5%',
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--nx-danger-text)',
          }}
        >
          Access paused
        </span>
        <span style={{ fontFamily: 'var(--nx-font-ui)', fontSize: '1.4rem', fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--nx-ink)' }}>
          This organization is suspended
        </span>
        <span style={{ fontSize: 14, color: 'var(--nx-ink-2)', lineHeight: 1.5 }}>
          {orgName} has been suspended and can no longer be accessed. Contact support to restore access.
        </span>
        {reason && (
          <span style={{ fontFamily: 'var(--nx-font-mono)', fontSize: 12.5, color: 'var(--nx-ink-3)', marginTop: 4 }}>
            Reason: {reason}
          </span>
        )}
      </div>
    </div>
  );
}
