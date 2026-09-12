import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
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
 * Server Component / Server Action guard for every authenticated route.
 *
 * Only requires an authenticated Supabase user (middleware already
 * redirects unauthenticated requests to /login, but a Server Component
 * checks again rather than trusting that as its only boundary) — it does
 * NOT require an organization. A user with no membership row is a valid
 * "individual" actor operating in their own personal workspace (see
 * 0005_individual_workspace.sql).
 *
 * A user can belong to multiple orgs later (switcher is a stub for now),
 * so this picks the oldest membership — first org created/joined — as the
 * default. All queries are plain RLS-scoped reads: no service role, no
 * bypassing the same policies a real client hits.
 */
export async function requireUser(): Promise<UserContext> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [{ data: profile }, { data: memberships }] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user.id).single(),
    supabase
      .from("organization_members")
      .select("role, created_at, organizations ( id, name, slug )")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(1),
  ]);

  const membership = memberships?.[0];
  const org = membership?.organizations as unknown as { id: string; name: string; slug: string } | null;

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
