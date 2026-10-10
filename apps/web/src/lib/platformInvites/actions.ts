"use server";

import { createHash } from "node:crypto";
import { withServiceRole } from "@nia/db";
import { getSessionUser } from "@/lib/auth/session";
import { getPool } from "@/lib/db/pool";

export type AcceptPlatformInviteResult =
  | { error: string }
  | { redirected: true };

/**
 * Called directly from /accept-invite/[token]/page.tsx's render (not a
 * form) — mirrors apps/web/src/lib/invites/actions.ts's acceptInvite().
 * Unlike org invites, /accept-invite/<token> is NOT in middleware.ts's
 * PUBLIC_PATHS, so sign-in is already enforced before this ever runs;
 * getSessionUser() here is a defense-in-depth null check only.
 *
 * Plan/grant application already happened in packages/auth/src/config.ts's
 * databaseHooks.user.create.after (it looks up platform_invites by email
 * at user-creation time, before this function ever runs) — this function
 * only has to mark the row accepted and re-check the email match in case
 * the signed-in user's email isn't the one the invite was issued to
 * (e.g. they already had an account under a different email and followed
 * the link anyway).
 */
export async function acceptPlatformInvite(rawToken: string): Promise<AcceptPlatformInviteResult> {
  const user = await getSessionUser();
  if (!user) {
    return { error: "Sign in to accept this invite." };
  }

  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  const result = await withServiceRole(getPool(), (db) =>
    db.query<{ id: string; email: string; status: "pending" | "accepted" | "revoked"; expires_at: string }>(
      `select id, email, status, expires_at
       from public.platform_invites
       where token_hash = $1`,
      [tokenHash],
    ),
  );
  const invite = result.rows[0];

  if (!invite) {
    return { error: "This invite link is invalid." };
  }
  if (invite.status === "revoked") {
    return { error: "This invite has been revoked." };
  }
  if (invite.status === "pending" && new Date(invite.expires_at) <= new Date()) {
    return { error: "This invite link has expired." };
  }
  if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
    return { error: "This invite was sent to a different email address." };
  }

  if (invite.status === "pending") {
    await withServiceRole(getPool(), (db) =>
      db.query(
        `update public.platform_invites
         set status = 'accepted', accepted_at = now(), accepted_user_id = $2, updated_at = now()
         where id = $1`,
        [invite.id, user.id],
      ),
    );
  }

  return { redirected: true };
}
