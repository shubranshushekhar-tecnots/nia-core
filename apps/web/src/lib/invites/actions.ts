"use server";

import { randomBytes, createHash } from "node:crypto";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withActingUser } from "@nia/db";
import { OrgRole, assertCan } from "@nia/schemas";
import { ACTIVE_ORG_COOKIE, getSessionUser, requireUserWithOrg } from "@/lib/auth/session";
import { getPool } from "@/lib/db/pool";

export type InviteActionState = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  success?: boolean;
  token?: string;
  link?: string;
} | null;

export type InviteLink = {
  id: string;
  role: OrgRole;
  tokenHash: string;
  expiresAt: string;
  maxUses: number | null;
  uses: number;
  emailDomain: string | null;
  revokedAt: string | null;
  createdAt: string;
};

const createInviteSchema = z.object({
  role: OrgRole,
  expiresInDays: z.coerce.number().int().min(1).max(365).default(7),
  maxUses: z.coerce.number().int().min(1).optional(),
  emailDomain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Enter a valid domain, e.g. example.com")
    .optional(),
});

/**
 * Creates an invite link. Role/expiry/max-uses/email-domain validated here;
 * the admin/owner + "only an owner may create an owner-role invite" checks
 * are enforced again (authoritatively) inside public.create_invite —
 * assertCan here is defense-in-depth/early feedback only, same convention
 * as CONVENTIONS.md's "RLS/DB is the real trust boundary, can.ts is
 * convenience only".
 *
 * Token is 32 random bytes (hex), SHA-256-hashed before ever reaching
 * Postgres — this is the ONLY place the raw token exists server-side; the
 * returned `token`/`link` must be shown to the admin once and never
 * persisted or logged.
 */
export async function createInvite(_prevState: InviteActionState, formData: FormData): Promise<InviteActionState> {
  const user = await requireUserWithOrg();

  try {
    assertCan(user.role, "members.invite");
  } catch {
    return { error: "You don't have permission to create invites." };
  }

  const raw = formData.get("maxUses");
  const rawDomain = formData.get("emailDomain");
  const parsed = createInviteSchema.safeParse({
    role: formData.get("role"),
    expiresInDays: formData.get("expiresInDays") || undefined,
    maxUses: raw ? raw : undefined,
    emailDomain: rawDomain ? rawDomain : undefined,
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    await withActingUser(getPool(), user.userId, (db) =>
      db.query(
        "select public.create_invite($1, $2, $3, $4, $5, $6)",
        [
          user.org.id,
          parsed.data.role,
          tokenHash,
          expiresAt,
          parsed.data.maxUses ?? null,
          parsed.data.emailDomain ?? null,
        ],
      ),
    );
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Something went wrong. Try again." };
  }

  revalidatePath("/app/members");
  return { success: true, token, link: `/invite/${token}` };
}

/** RLS's own invite_links_select_admin policy gates this — no RPC needed. */
export async function listInvites(): Promise<InviteLink[]> {
  const user = await requireUserWithOrg();

  const result = await withActingUser(getPool(), user.userId, (db) =>
    db.query<{
      id: string;
      role: OrgRole;
      token_hash: string;
      expires_at: string;
      max_uses: number | null;
      uses: number;
      email_domain: string | null;
      revoked_at: string | null;
      created_at: string;
    }>(
      `select id, role, token_hash, expires_at, max_uses, uses, email_domain, revoked_at, created_at
       from public.invite_links
       where org_id = $1
       order by created_at desc`,
      [user.org.id],
    ),
  );

  return result.rows.map((r) => ({
    id: r.id,
    role: r.role,
    tokenHash: r.token_hash,
    expiresAt: r.expires_at,
    maxUses: r.max_uses,
    uses: r.uses,
    emailDomain: r.email_domain,
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
  }));
}

/** Called directly (not a form action) from InvitesClient's revoke button. */
export async function revokeInvite(inviteId: string): Promise<{ error?: string }> {
  const user = await requireUserWithOrg();

  try {
    await withActingUser(getPool(), user.userId, (db) => db.query("select public.revoke_invite($1)", [inviteId]));
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Something went wrong. Try again." };
  }

  revalidatePath("/app/members");
  return {};
}

export type AcceptInviteResult =
  | { error: string }
  | { alreadyMember: true; orgName: string; orgSlug: string }
  | { redirected: true };

/**
 * Called directly from /invite/[token]/page.tsx's render (not a form) —
 * requires sign-in, but that's already enforced by middleware.ts's
 * PUBLIC_PATHS before this page (and thus this action) is ever reached, so
 * getSessionUser() here is a defense-in-depth null check only.
 *
 * On success for a brand-new member: sets ACTIVE_ORG_COOKIE (same shape as
 * switchOrg) and the caller (the page) redirects to /app. On "already a
 * member": the cookie is still set (harmless — they already belong to that
 * org) but no redirect happens; the page renders "You're already a
 * member." with a manual link, per spec.
 */
export async function acceptInvite(rawToken: string): Promise<AcceptInviteResult> {
  const user = await getSessionUser();
  if (!user) {
    return { error: "Sign in to accept this invite." };
  }

  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  let row: { org_id: string; org_name: string; org_slug: string; role: OrgRole; already_member: boolean };
  try {
    const result = await withActingUser(getPool(), user.id, (db) =>
      db.query<{ org_id: string; org_name: string; org_slug: string; role: OrgRole; already_member: boolean }>(
        "select * from public.accept_invite($1)",
        [tokenHash],
      ),
    );
    row = result.rows[0]!;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Something went wrong. Try again." };
  }

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_ORG_COOKIE, row.org_id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  if (row.already_member) {
    return { alreadyMember: true, orgName: row.org_name, orgSlug: row.org_slug };
  }

  revalidatePath("/", "layout");
  return { redirected: true };
}
