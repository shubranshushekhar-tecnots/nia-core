import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { acceptInvite } from '@/lib/invites/actions';
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

// /invite/<token> requires sign-in — enforced by middleware.ts's
// PUBLIC_PATHS (any non-public path with no session cookie redirects to
// /login?next=<pathname>, and LoginForm/SignupForm forward that `next`
// through sign-in/sign-up and back here — see lib/auth/actions.ts). By the
// time this Server Component runs, the caller is always authenticated;
// acceptInvite() still re-checks defensively.
//
// Not wrapped in AuthShell (shared login/signup chrome, a centered
// light-indigo card) — MembersStates.dc.html's accept-invite states are
// full-bleed Precision Dark panels, a structurally different, feature-
// specific treatment. AuthShell itself stays untouched.
export default async function AcceptInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await acceptInvite(token);

  if ('redirected' in result) {
    redirect('/app');
  }

  if ('alreadyMember' in result) {
    return (
      <div data-app-theme="" data-om-theme="light" style={nxAcceptInvitePageStyle}>
        <div style={nxAcceptInvitePanelStyle('success')}>
          <span style={nxAcceptInviteEyebrowStyle('success')}>Members &amp; roles</span>
          <h1 style={nxAcceptInviteHeadingStyle}>You&apos;re already a member</h1>
          <p style={nxAcceptInviteBodyStyle}>
            You&apos;re already part of {result.orgName}. Your role hasn&apos;t changed.
          </p>
          <Link href="/app" style={nxAcceptInviteCtaStyle('success')}>
            Go to {result.orgName} <span>{'\u2192'}</span>
          </Link>
        </div>
      </div>
    );
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
