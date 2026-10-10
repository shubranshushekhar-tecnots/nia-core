import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth/session';
import ConsoleEnrollClient from '@/components/console/ConsoleEnrollClient';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Console · Two-Factor Setup', robots: { index: false, follow: false } };

// Console v1 Slice 4 (docs/plans/console-plan.md §4b, build order step 14):
// deliberately a top-level route, NOT nested under /console — console/layout.tsx
// gates every route under app/console/* on requireStaff (which is exactly what
// redirects here on STAFF_2FA_REQUIRED), so nesting this screen there would
// loop against its own gate. Only requires a signed-in session (not staff
// membership) — a non-staff user landing here directly just sees an enroll
// screen with nowhere useful to go afterward, which is harmless.
export default async function Page() {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  return <ConsoleEnrollClient />;
}
