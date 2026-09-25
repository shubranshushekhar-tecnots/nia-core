import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { withActingUser } from "@nia/db";
import { auth } from "@/lib/auth/auth";
import { dbPool } from "@/lib/db/pool";
import type { ActorRole, OrgRole } from "@nia/schemas";

export type UserContext = {
  userId: string;
  email: string;
  fullName: string | null;
  org: { id: string; name: string; slug: string } | null;
  /** "individual" when the user has no organization membership at all. */
  role: ActorRole;
};

export type UserWithOrg = {
  userId: string;
  email: string;
  fullName: string | null;
  org: { id: string; name: string; slug: string };
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
  const session = await auth.api.getSession({ headers: await headers() });
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
 * A user can belong to multiple orgs later (switcher is a stub for now),
 * so this picks the oldest membership — first org created/joined — as the
 * default. All queries are plain RLS-scoped reads: no service role, no
 * bypassing the same policies a real client hits.
 */
export async function requireUser(): Promise<UserContext> {
  const user = await getSessionUser();

  if (!user) {
    redirect("/login");
  }

  const [profileResult, membershipResult] = await Promise.all([
    withActingUser(dbPool, user.id, (db) =>
      db.query<{ full_name: string | null }>("select full_name from public.profiles where id = $1", [user.id]),
    ),
    withActingUser(dbPool, user.id, (db) =>
      db.query<{ role: string; created_at: string; org_id: string; org_name: string; org_slug: string }>(
        `select m.role, m.created_at, o.id as org_id, o.name as org_name, o.slug as org_slug
         from public.organization_members m
         join public.organizations o on o.id = m.org_id
         where m.user_id = $1
         order by m.created_at asc
         limit 1`,
        [user.id],
      ),
    ),
  ]);

  const profile = profileResult.rows[0] ?? null;
  const membership = membershipResult.rows[0];
  const org = membership ? { id: membership.org_id, name: membership.org_name, slug: membership.org_slug } : null;

  return {
    userId: user.id,
    email: user.email ?? "",
    fullName: profile?.full_name ?? null,
    org: membership && org ? org : null,
    role: membership && org ? (membership.role as OrgRole) : "individual",
  };
}

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
