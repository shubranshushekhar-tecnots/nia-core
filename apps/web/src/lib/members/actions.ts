"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withActingUser } from "@nia/db";
import { OrgRole, assertCanManageMember, PermissionError } from "@nia/schemas";
import { requireUserWithOrg } from "@/lib/auth/session";
import { getPool } from "@/lib/db/pool";
import type { ActionState } from "@/lib/auth/actions";

export type MemberProfile = {
  userId: string;
  name: string | null;
  email: string | null;
  role: OrgRole;
  joinedAt: string;
};

/**
 * public.organization_members' own RLS (members_select_members) lets any
 * org member see every row for their org, but display name/email live in
 * public."user", which carries no grant to `authenticated` at all — hence
 * the public.list_org_member_profiles RPC (0060_org_member_profiles_rpc.sql)
 * instead of a plain join. That RPC re-checks org membership itself
 * (private.is_member), so this is safe to call with just the caller's own
 * resolved org id.
 */
export async function listMembers(): Promise<MemberProfile[]> {
  const user = await requireUserWithOrg();

  const result = await withActingUser(getPool(), user.userId, (db) =>
    db.query<{ user_id: string; name: string | null; email: string | null; role: OrgRole; joined_at: string }>(
      "select * from public.list_org_member_profiles($1)",
      [user.org.id],
    ),
  );

  return result.rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    email: r.email,
    role: r.role,
    joinedAt: r.joined_at,
  }));
}

async function currentRoleOf(userId: string, orgId: string, targetUserId: string): Promise<OrgRole | null> {
  const result = await withActingUser(getPool(), userId, (db) =>
    db.query<{ role: OrgRole }>(
      "select role from public.organization_members where org_id = $1 and user_id = $2",
      [orgId, targetUserId],
    ),
  );
  return result.rows[0]?.role ?? null;
}

/** Postgres error text from the protect_last_super_admin trigger — its own message IS the customer-facing copy. */
function friendlyMemberError(err: unknown): string {
  if (err instanceof PermissionError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong. Try again.";
}

/**
 * Called directly (not a form action) from MembersClient's per-row role
 * <select> — matches revokeInvite's direct-call precedent. assertCanManageMember
 * here is early/friendly feedback only; the organization_members RLS
 * policies + protect_last_super_admin trigger (0001/0004_owner_rename.sql)
 * remain the actual enforcement.
 */
export async function changeMemberRole(targetUserId: string, newRole: OrgRole): Promise<{ error?: string }> {
  const user = await requireUserWithOrg();

  const currentRole = await currentRoleOf(user.userId, user.org.id, targetUserId);
  if (currentRole === null) return { error: "That member could not be found." };

  try {
    assertCanManageMember(user.role, currentRole, newRole);
  } catch (err) {
    return { error: friendlyMemberError(err) };
  }

  try {
    const result = await withActingUser(getPool(), user.userId, (db) =>
      db.query(
        "update public.organization_members set role = $1 where org_id = $2 and user_id = $3",
        [newRole, user.org.id, targetUserId],
      ),
    );
    if (result.rowCount === 0) return { error: "Couldn't change that member's role. Try again." };
  } catch (err) {
    return { error: friendlyMemberError(err) };
  }

  revalidatePath("/app/members");
  return {};
}

const removeMemberSchema = z.object({ targetUserId: z.string().uuid() });

/**
 * A form action (bound with orgId is unnecessary — requireUserWithOrg
 * resolves it) so it can drive DeleteConfirmDialog like every other
 * destructive action in this app. Returns ActionState (not a redirect) —
 * the member stays on /app/members after removal, like connections' delete.
 */
export async function removeMember(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = removeMemberSchema.safeParse({ targetUserId: formData.get("targetUserId") });
  if (!parsed.success) return { error: "Something went wrong. Try again." };

  const user = await requireUserWithOrg();
  const { targetUserId } = parsed.data;

  const currentRole = await currentRoleOf(user.userId, user.org.id, targetUserId);
  if (currentRole === null) return { error: "That member could not be found." };

  // Self-leave bypasses the capability check entirely — organization_members'
  // own RLS (members_delete_admins_or_self, 0001_auth_orgs.sql) lets any
  // member remove their own row regardless of role, same as MembersClient's
  // "Leave" button, which is always shown for isSelf. assertCanManageMember
  // only governs managing SOMEONE ELSE; calling it here for self-removal
  // would incorrectly reject a plain member leaving (members.remove is
  // admin/owner-only). protect_last_super_admin (0004_owner_rename.sql)
  // still blocks the last owner from leaving, enforced at the DB layer.
  if (targetUserId !== user.userId) {
    try {
      assertCanManageMember(user.role, currentRole);
    } catch (err) {
      return { error: friendlyMemberError(err) };
    }
  }

  try {
    const result = await withActingUser(getPool(), user.userId, (db) =>
      db.query("delete from public.organization_members where org_id = $1 and user_id = $2", [
        user.org.id,
        targetUserId,
      ]),
    );
    if (result.rowCount === 0) return { error: "Couldn't remove that member. Try again." };
  } catch (err) {
    return { error: friendlyMemberError(err) };
  }

  revalidatePath("/app/members");
  return { success: true };
}
