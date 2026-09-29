import Logo from '@/components/Logo';

/**
 * Console v1 Slice 3b, Addition 3 (docs/plans/console-plan.md): rendered by
 * app/app/layout.tsx INSTEAD of the normal AppShell/Sidebar/TopBar/children
 * tree whenever the caller's resolved org is suspended — no nav, no "broken
 * buttons" whose writes would just 403/RLS-deny underneath. /console/* is a
 * fully separate route tree (see console/layout.tsx) and never renders this.
 *
 * Same `[data-app-theme][data-om-theme='light']` token scope as AppShell
 * (theme.css) so it looks like the rest of the post-login app, not the
 * auth screens' distinct light-indigo palette.
 */
export default function SuspendedOrgPage({ orgName, reason }: { orgName: string; reason: string | null }) {
  return (
    <div
      data-app-theme=""
      data-om-theme="light"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 28,
        background: 'var(--bg)',
        color: 'var(--text)',
        fontFamily: 'var(--font-ui)',
        WebkitFontSmoothing: 'antialiased',
        padding: 24,
      }}
    >
      <Logo size={28} />

      <div
        style={{
          width: 440,
          maxWidth: '100%',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: '28px 28px 26px',
          borderRadius: 14,
          background: 'var(--bad-bg)',
          border: '1px solid var(--bad-bd)',
          textAlign: 'center',
          alignItems: 'center',
        }}
      >
        <span style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', fontWeight: 700, color: 'var(--text)' }}>
          This organization is suspended
        </span>
        <span style={{ fontSize: 14, color: 'var(--text-3)', lineHeight: 1.5 }}>
          {orgName} has been suspended and can no longer be accessed. Contact support to restore access.
        </span>
        {reason && (
          <span style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 4 }}>Reason: {reason}</span>
        )}
      </div>
    </div>
  );
}
