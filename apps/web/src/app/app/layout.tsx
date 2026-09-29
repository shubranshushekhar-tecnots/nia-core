import { requireUser } from "@/lib/auth/session";
import SuspendedOrgPage from "@/components/app/SuspendedOrgPage";

// Every page under app/app/* is per-user (requireUser()/getSessionUser()
// reads the caller's session + org membership from the DB), so none of
// them may ever be prerendered at build time — there is no "anonymous"
// version of these pages to serve statically, and DATABASE_URL is only
// present at runtime, not at build time (see lib/db/pool.ts, lib/auth/auth.ts).
export const dynamic = "force-dynamic";

/**
 * Console v1 Slice 3b, Addition 3 (docs/plans/console-plan.md): a suspended
 * org's members get a clear "This organization is suspended. Contact
 * support." page here instead of the normal AppShell/Sidebar/TopBar tree —
 * no nav, no buttons that would just 403/RLS-deny underneath. Every page
 * under app/app/* calls requireUser() itself too (unchanged); requireUser()
 * is wrapped in React's cache() (session.ts) so that second call dedupes
 * into the same DB round trip instead of doubling it.
 *
 * /console/* is a completely separate route tree (see
 * app/console/layout.tsx, which never calls requireUser()) and staff are
 * never routed through this layout, so Console access is structurally
 * unaffected by this check — same guarantee apps/api's attachActor
 * middleware has (it's never run for /console/* either; see actor.ts's
 * header comment).
 */
export default async function AppSectionLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  if (user.org?.suspendedAt) {
    return <SuspendedOrgPage orgName={user.org.name} reason={user.org.suspendedReason} />;
  }

  return children;
}
