import { redirect } from 'next/navigation';
import Link from 'next/link';
import AuthShell from '@/components/auth/AuthShell';
import { titleStyle, subtitleStyle, errorTextStyle } from '@/components/auth/styles';
import { acceptInvite } from '@/lib/invites/actions';

export const dynamic = 'force-dynamic';

// /invite/<token> requires sign-in — enforced by middleware.ts's
// PUBLIC_PATHS (any non-public path with no session cookie redirects to
// /login?next=<pathname>, and LoginForm/SignupForm forward that `next`
// through sign-in/sign-up and back here — see lib/auth/actions.ts). By the
// time this Server Component runs, the caller is always authenticated;
// acceptInvite() still re-checks defensively.
export default async function AcceptInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await acceptInvite(token);

  if ('redirected' in result) {
    redirect('/app');
  }

  if ('alreadyMember' in result) {
    return (
      <AuthShell>
        <h1 style={titleStyle}>You&apos;re already a member</h1>
        <p style={subtitleStyle}>
          You&apos;re already part of {result.orgName}. Your role hasn&apos;t changed.
        </p>
        <Link href="/app" style={{ fontSize: 14, color: 'var(--accent)' }}>
          Go to {result.orgName}
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 style={titleStyle}>Invite link problem</h1>
      <p style={errorTextStyle}>{result.error}</p>
      <Link href="/app" style={{ fontSize: 14, color: 'var(--accent)' }}>
        Go to your account
      </Link>
    </AuthShell>
  );
}
