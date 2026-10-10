import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { pingConsole } from '@/lib/api/consoleServer';
import { ApiError } from '@/lib/api/server';

// Staff-only, never indexable.
export const metadata: Metadata = { robots: { index: false, follow: false } };

// Per-staff-session gate (never prerenderable) — same reasoning as
// app/app/layout.tsx: there is no anonymous/static version of a /console/*
// page.
export const dynamic = 'force-dynamic';

/**
 * Console v1 (docs/plans/console-plan.md §5a, decisions 1-2), Slice 1.
 *
 * Visibility is decided server-side only by actually calling the API
 * (GET /console/ping), never by a NEXT_PUBLIC_* flag — a NEXT_PUBLIC_ value
 * would be baked into the image at build time (see docs/plans/
 * web-container.md's standalone-output rewrite gotcha), so it couldn't
 * reflect a flag flipped later on a running deployment. apiFetchServer
 * itself redirects unauthenticated requests to /login before this ever
 * runs; what's left to handle here is the staff gate.
 *
 * "CONSOLE_ENABLED=false" (router not mounted -> 404 from apps/api),
 * "authenticated but not staff" (403 NOT_STAFF), a 5xx from apps/api, and a
 * transport-level failure (apps/api unreachable — fetch() itself throws,
 * not an ApiError) all render as the exact same plain 404 here — the
 * console's existence is never revealed to a caller, staff or not, and an
 * outage must never leak as a 500 error page. Slice 1 review fix: a 5xx or
 * network failure is genuinely unexpected (unlike a 403/404, which are
 * normal, permission-shaped results), so those two cases are logged
 * server-side via console.error before falling through to notFound() —
 * this is the only place that distinguishes "expected access-control
 * result" from "apps/api is actually down," and there is no logger
 * abstraction elsewhere in this app to route through instead.
 */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  try {
    await pingConsole();
  } catch (err) {
    if (err instanceof ApiError) {
      // Console v1 Slice 4 (docs/plans/console-plan.md §4b): unlike every
      // other outcome here, these two are shown to the staff member as an
      // actionable next step rather than folded into the generic "console
      // doesn't exist" 404 — requireStaff.ts (apps/api) only ever throws
      // these once the caller is already confirmed staff, so redirecting
      // (instead of hiding the console's existence) doesn't leak anything
      // a non-staff caller couldn't already infer from a plain 403.
      if (err.code === 'STAFF_2FA_REQUIRED') {
        redirect('/console-enroll');
      }
      if (err.code === 'STAFF_SESSION_EXPIRED') {
        redirect('/login');
      }
      if (err.status >= 500) {
        console.error('[console] GET /console/ping failed with a 5xx', err);
      }
      notFound();
    }
    console.error('[console] GET /console/ping failed (network/transport error)', err);
    notFound();
  }

  return children;
}
