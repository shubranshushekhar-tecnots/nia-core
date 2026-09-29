import { notFound } from 'next/navigation';
import { getSessionUser } from '@/lib/auth/session';
import { getConsoleUser } from '@/lib/api/consoleServer';
import { ApiError } from '@/lib/api/server';
import ConsoleShell from '@/components/console/ConsoleShell';
import ConsoleUserDetailClient from '@/components/console/ConsoleUserDetailClient';

// Slice 3e (docs/plans/console-plan.md build order step 12): User Detail,
// reached via a link from the Users list or an org detail Members row —
// no dedicated sidebar nav entry (see ConsoleShell's own doc comment on the
// 'users' NAV item), same as Org Detail's own precedent in
// app/console/orgs/[orgId]/page.tsx (including its identical 404-on-any-
// failure posture — see that file's own doc comment for the reasoning).
export default async function ConsoleUserDetailPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;

  const [sessionUser, user] = await Promise.all([
    getSessionUser(),
    getConsoleUser(userId).catch((err) => {
      if (err instanceof ApiError) {
        if (err.status >= 500) {
          console.error('[console] GET /console/users/:userId failed with a 5xx', err);
        }
        notFound();
      }
      console.error('[console] GET /console/users/:userId failed (network/transport error)', err);
      notFound();
    }),
  ]);

  return (
    <ConsoleShell activeNavId="users" email={sessionUser?.email ?? ''}>
      <ConsoleUserDetailClient user={user} currentStaffUserId={sessionUser?.id ?? ''} />
    </ConsoleShell>
  );
}
