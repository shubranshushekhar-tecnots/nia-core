import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { acceptPlatformInvite } from '@/lib/platformInvites/actions';
import {
  nxAcceptInvitePageStyle,
  nxAcceptInvitePanelStyle,
  nxAcceptInviteEyebrowStyle,
  nxAcceptInviteHeadingStyle,
  nxAcceptInviteBodyStyle,
  nxAcceptInviteCtaStyle,
} from '@/components/members/styles';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Accept invite', robots: { index: false, follow: false } };

// /accept-invite/<token> — staff-initiated platform invites (Email Phase 3),
// distinct from the org-scoped /invite/<token> (invite_links, 0058). Not in
// middleware.ts's PUBLIC_PATHS, so sign-in is required first: an
// unauthenticated visitor is redirected to /login?next=/accept-invite/<token>,
// and signup()/the signup gate (lib/auth/signupGate.ts, lib/auth/actions.ts)
// already use that same `next` value to bridge a brand-new account through
// the gate before this page ever runs. By the time this Server Component
// runs, the caller is always authenticated; acceptPlatformInvite() still
// re-checks defensively (including the email match, since platform invites
// are email-bound unlike org invites' advisory-only email_domain).
//
// Same structural treatment as app/invite/[token]/page.tsx (full-bleed
// Precision Dark panel, not AuthShell) — mirrored 1:1 rather than sharing a
// component, since the two flows' result shapes differ (no "already a
// member" case here).
export default async function AcceptPlatformInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await acceptPlatformInvite(token);

  if ('redirected' in result) {
    redirect('/app');
  }

  return (
    <div data-app-theme="" data-om-theme="light" style={nxAcceptInvitePageStyle}>
      <div style={nxAcceptInvitePanelStyle('error')}>
        <span style={nxAcceptInviteEyebrowStyle('error')}>Invite link problem</span>
        <h1 style={nxAcceptInviteHeadingStyle}>Invite link problem</h1>
        <p style={nxAcceptInviteBodyStyle}>{result.error}</p>
        <Link href="/app" style={nxAcceptInviteCtaStyle('error')}>
          Go to your account <span>{'\u2192'}</span>
        </Link>
      </div>
    </div>
  );
}
