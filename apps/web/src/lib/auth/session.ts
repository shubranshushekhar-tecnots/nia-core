import { cache } from "react";
import { redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { withActingUser } from "@nia/db";
import { getAuth } from "@/lib/auth/auth";
import { getPool } from "@/lib/db/pool";
import type { ActorRole, OrgRole } from "@nia/schemas";
import { pickActiveMembership, type MembershipRow } from "@/lib/auth/pickActiveMembership";

/**
 * Cookie set by switchOrg() (lib/auth/actions.ts) when a multi-org user
 * picks which org to act in. Same name/shape duplicated in apps/api's
 * middleware/actor.ts (separate package, no shared runtime module — see
 * that file's header comment) since both sides need to read it.
 */
export const ACTIVE_ORG_COOKIE = "nia_active_org";

export type UserContext = {
  userId: string;
  email: string;
  fullName: string | null;
  org:
    | {
        id: string;
        name: string;
        slug: string;
        /** 0046_org_suspension.sql — null unless staff have suspended this org. */
        suspendedAt: string | null;
        suspendedReason: string | null;
      }
    | null;
  /** "individual" when the user has no organization membership at all. */
  role: ActorRole;
  /** Every org this user belongs to, oldest first — for the TopBar switcher. */
  orgs: { id: string; name: string; slug: string; role: OrgRole }[];
};

export type UserWithOrg = {
  userId: string;
  email: string;
  fullName: string | null;
  org: { id: string; name: string; slug: string; suspendedAt: string | null; suspendedReason: string | null };
  role: OrgRole;
};

/**
 * Returns the current session's user id/email, or null if signed out. Thin
 * wrapper over auth.api.getSession so every Server Action/Component shares
 * one code path for "who is asking" — a real DB round-trip against the
 * `session` table (packages/auth/src/config.ts), never a locally-decoded
 * token.
 */
export async function getSessionUser(): Promise<{ id: string; email: string } | null> {
  // headers() must be called (and awaited) before getAuth() — it's what
  // signals Next's dynamic-rendering bailout during static generation.
  // Calling getAuth() first would construct the DB pool (see lib/db/pool.ts)
  // before that bailout has a chance to fire, turning a normal "this route
  // is dynamic" signal into a hard build failure when DATABASE_URL isn't set.
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  return session ? { id: session.user.id, email: session.user.email } : null;
}

/**
 * Server Component / Server Action guard for every authenticated route.
 *
 * Only requires an authenticated session (middleware already redirects
 * unauthenticated requests to /login, but a Server Component checks again
 * rather than trusting that as its only boundary) — it does NOT require an
 * organization. A user with no membership row is a valid "individual"
 * actor operating in their own personal workspace (see
 * 0005_individual_workspace.sql).
 *
 * Org switcher (Subscription Phase 2): a user can belong to multiple orgs,
 * so this fetches every membership (oldest first) and picks whichever
 * matches the ACTIVE_ORG_COOKIE if present and valid, else falls back to
 * the oldest membership — identical fallback to pre-switcher behaviour for
 * users who have never switched or whose cookie no longer points to a real
 * membership. Mirrors apps/api's attachActor middleware exactly (see that
 * file's header comment) — including that this is what makes the
 * suspension check below correctly follow the *active* org, not any other
 * org the user happens to belong to. All queries are plain RLS-scoped
 * reads: no service role, no bypassing the same policies a real client
 * hits.
 *
 * Wrapped in React's cache() so that app/app/layout.tsx's own suspension
 * check and each page's independent requireUser() call within the same
 * request dedupe into a single DB round trip instead of two.
 */
export const requireUser = cache(async function requireUser(): Promise<UserContext> {
  const user = await getSessionUser();

  if (!user) {
    redirect("/login");
  }

  const cookieStore = await cookies();
  const activeOrgId = cookieStore.get(ACTIVE_ORG_COOKIE)?.value ?? null;

  const [profileResult, membershipResult] = await Promise.all([
    withActingUser(getPool(), user.id, (db) =>
      db.query<{ full_name: string | null }>("select full_name from public.profiles where id = $1", [user.id]),
    ),
    withActingUser(getPool(), user.id, (db) =>
      db.query<MembershipRow>(
        `select m.role, m.created_at, o.id as org_id, o.name as org_name, o.slug as org_slug,
                o.suspended_at, o.suspended_reason
         from public.organization_members m
         join public.organizations o on o.id = m.org_id
         where m.user_id = $1
         order by m.created_at asc`,
        [user.id],
      ),
    ),
  ]);

  const profile = profileResult.rows[0] ?? null;
  const memberships = membershipResult.rows;
  const membership = pickActiveMembership(memberships, activeOrgId);
  const org = membership
    ? {
        id: membership.org_id,
        name: membership.org_name,
        slug: membership.org_slug,
        suspendedAt: membership.suspended_at,
        suspendedReason: membership.suspended_reason,
      }
    : null;

  return {
    userId: user.id,
    email: user.email ?? "",
    fullName: profile?.full_name ?? null,
    org: membership && org ? org : null,
    role: membership && org ? (membership.role as OrgRole) : "individual",
    orgs: memberships.map((m) => ({ id: m.org_id, name: m.org_name, slug: m.org_slug, role: m.role as OrgRole })),
  };
});

/**
 * Thin wrapper over requireUser() for routes that genuinely require an
 * organization (currently none outside /onboarding itself — /app renders
 * for individual users too once its UI supports a null org). Redirects
 * org-less users to onboarding rather than returning a nullable org, so
 * existing call sites keep their non-null `org`/`role: OrgRole` contract.
 */
export async function requireUserWithOrg(): Promise<UserWithOrg> {
  const ctx = await requireUser();

  if (!ctx.org || ctx.role === "individual") {
    redirect("/onboarding");
  }

  return {
    userId: ctx.userId,
    email: ctx.email,
    fullName: ctx.fullName,
    org: ctx.org,
    role: ctx.role,
  };
}
