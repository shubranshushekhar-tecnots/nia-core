"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withActingUser } from "@nia/db";
import type { OrgRole } from "@nia/schemas";
import { requireUserWithOrg } from "@/lib/auth/session";
import { getPool } from "@/lib/db/pool";
import type { ActionState } from "@/lib/auth/actions";

export type ProjectMemberProfile = {
  userId: string;
  name: string | null;
  email: string | null;
  role: OrgRole;
};

/**
 * Org-scoped projects only (0054_project_members.sql — a personal/
 * owner_id project has no membership concept beyond its one owner, so
 * this panel isn't rendered for those). Reuses list_org_member_profiles
 * (0060_org_member_profiles_rpc.sql) for name/email rather than a second
 * RPC, then splits the org roster by whether each id is already a
 * project_members row for this project.
 */
async function orgRosterSplitByProjectMembership(
  userId: string,
  orgId: string,
  projectId: string,
): Promise<{ members: ProjectMemberProfile[]; addable: ProjectMemberProfile[] }> {
  const [roster, memberIds] = await Promise.all([
    withActingUser(getPool(), userId, (db) =>
      db.query<{ user_id: string; name: string | null; email: string | null; role: OrgRole }>(
        "select user_id, name, email, role from public.list_org_member_profiles($1)",
        [orgId],
      ),
    ),
    withActingUser(getPool(), userId, (db) =>
      db.query<{ user_id: string }>("select user_id from public.project_members where project_id = $1", [projectId]),
    ),
  ]);

  const memberIdSet = new Set(memberIds.rows.map((r) => r.user_id));
  const members: ProjectMemberProfile[] = [];
  const addable: ProjectMemberProfile[] = [];

  for (const r of roster.rows) {
    const profile: ProjectMemberProfile = { userId: r.user_id, name: r.name, email: r.email, role: r.role };
    if (memberIdSet.has(r.user_id)) members.push(profile);
    else addable.push(profile);
  }

  return { members, addable };
}

export async function listProjectMembers(
  projectId: string,
): Promise<{ members: ProjectMemberProfile[]; addable: ProjectMemberProfile[] }> {
  const user = await requireUserWithOrg();
  return orgRosterSplitByProjectMembership(user.userId, user.org.id, projectId);
}

/**
 * Called directly (not a form action) from ProjectMembersPanel's "Add"
 * select, matching changeMemberRole's direct-call precedent.
 * project_members_insert_admins_or_owner (0054_project_members.sql) is the
 * actual enforcement — a member/viewer's attempt fails with 0 rows
 * inserted, mapped to a friendly message below.
 */
export async function addProjectMember(projectId: string, targetUserId: string): Promise<{ error?: string }> {
  const user = await requireUserWithOrg();

  try {
    const result = await withActingUser(getPool(), user.userId, (db) =>
      db.query(
        "insert into public.project_members (project_id, user_id) values ($1, $2) on conflict (project_id, user_id) do nothing",
        [projectId, targetUserId],
      ),
    );
    if (result.rowCount === 0) {
      return { error: "Couldn't add that person. You may not have permission to manage this project's members." };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Something went wrong. Try again." };
  }

  revalidatePath(`/app/projects/${projectId}`);
  return {};
}

const removeProjectMemberSchema = z.object({
  projectId: z.string().uuid(),
  targetUserId: z.string().uuid(),
});

/** Form action for DeleteConfirmDialog. Self-removal ("leave") and admin/owner removal both go through the same delete policy. */
export async function removeProjectMember(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = removeProjectMemberSchema.safeParse({
    projectId: formData.get("projectId"),
    targetUserId: formData.get("targetUserId"),
  });
  if (!parsed.success) return { error: "Something went wrong. Try again." };

  const user = await requireUserWithOrg();
  const { projectId, targetUserId } = parsed.data;

  try {
    const result = await withActingUser(getPool(), user.userId, (db) =>
      db.query("delete from public.project_members where project_id = $1 and user_id = $2", [
        projectId,
        targetUserId,
      ]),
    );
    if (result.rowCount === 0) {
      return { error: "Couldn't remove that person. You may not have permission to manage this project's members." };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Something went wrong. Try again." };
  }

  revalidatePath(`/app/projects/${projectId}`);
  return { success: true };
}
