"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { withActingUser } from "@nia/db";
import { getPool } from "@/lib/db/pool";
import { getSessionUser, requireUser } from "@/lib/auth/session";
import type { ActionState } from "@/lib/auth/actions";
import type { WorkflowDefinition } from "./types";

const nameSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120, "Keep it under 120 characters"),
});

// The Sidebar (and its create-project/create-workflow dialogs) renders on
// every /app/* page, each fetching its own `projects` list independently —
// there's no shared layout to revalidate. Refresh all of them so the new
// project/workflow shows up regardless of which page the user created it
// from, instead of only the page they happened to be on.
const APP_SHELL_PATHS = ["/app", "/app/connections", "/app/billing", "/app/projects"] as const;

function revalidateAppShell() {
  for (const path of APP_SHELL_PATHS) revalidatePath(path);
}

const SUSPENDED_ORG_MESSAGE = "This organization has been suspended. Contact support.";

// Addition 3/5 (docs/plans/console-plan.md, Slice 3b): rename/delete/
// updateWorkflowDefinition below only have a row id, not an org id — RLS
// denies the update/delete (zero rows, no Postgres error — see the header
// comment above renameProject), which reads identically whether the cause
// is "not your row" or "your org got suspended mid-session" (a stale tab
// still open past app/app/layout.tsx's own suspension gate). This
// distinguishes the two with one extra, RLS-scoped read (select policies
// are untouched by 0046_org_suspension.sql, only insert/update/delete are)
// against the SPECIFIC row's actual org — never the caller's ctx.org,
// which could be a different (unrelated, and per decision 4 unaffected)
// org for a multi-org member — so it can't produce a false "suspended"
// message for an ordinary permission/not-found failure.
async function suspendedOrgMessage(
  userId: string,
  table: "projects" | "workflows",
  id: string,
): Promise<string | null> {
  const result = await withActingUser(getPool(), userId, (db) =>
    db.query<{ suspended_at: string | null }>(
      `select o.suspended_at
       from public.${table} t
       join public.organizations o on o.id = t.org_id
       where t.id = $1`,
      [id],
    ),
  );
  return result.rows[0]?.suspended_at ? SUSPENDED_ORG_MESSAGE : null;
}

export async function createProject(
  orgId: string | null,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = nameSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const ctx = await requireUser();

  // orgId null means an individual (org-less) workspace — insert with
  // owner_id instead, matching the 0005_individual_workspace.sql xor shape.
  if (orgId === null) {
    if (ctx.role !== "individual") return { error: "Choose an organization first." };

    try {
      await withActingUser(getPool(), ctx.userId, (db) =>
        db.query("insert into public.projects (org_id, owner_id, name, created_by) values (null, $1, $2, $1)", [
          ctx.userId,
          parsed.data.name,
        ]),
      );
    } catch {
      return { error: "Couldn't create the project. Try again." };
    }
    revalidateAppShell();
    return { success: true };
  }

  // Pre-check that the actor is actually a member of this org — mirrors
  // the projects_insert_members RLS check (any member, not just
  // admin/owner, may create a project) so a permission failure returns a
  // friendly message instead of a raw Postgres RLS error string. RLS
  // (0002/0005 migrations) remains the actual enforcement boundary.
  if (ctx.role === "individual" || ctx.org?.id !== orgId) {
    return { error: "You're not a member of this organization." };
  }

  // ctx.org.id === orgId is confirmed above, so ctx.org.suspendedAt is the
  // right org to check here — unlike renameProject/deleteProject below, no
  // cross-org ambiguity is possible for an insert (the target org IS the
  // caller's own resolved org).
  if (ctx.org.suspendedAt) return { error: SUSPENDED_ORG_MESSAGE };

  try {
    await withActingUser(getPool(), ctx.userId, (db) =>
      db.query("insert into public.projects (org_id, name, created_by) values ($1, $2, $3)", [
        orgId,
        parsed.data.name,
        ctx.userId,
      ]),
    );
  } catch {
    return { error: "Couldn't create the project. Try again." };
  }

  revalidateAppShell();
  return { success: true };
}

const workflowSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120, "Keep it under 120 characters"),
  projectId: z.string().uuid("Choose a project"),
});

// The customer-visible copy for both enforcement layers below — must read
// identically whichever one fires. The application-level check (query,
// then compare) is a fast, friendly pre-check; the BEFORE INSERT trigger
// on public.workflows (0045_workflow_plan_enforcement.sql,
// private.enforce_workflow_limit) is the actual source of truth, closing
// the race this check alone can't (two concurrent creates both reading
// "N-1 used" and both inserting). The trigger raises this exact text with
// SQLSTATE 'NIA01', which the catch block below detects and passes
// through unmodified instead of falling back to the generic message.
function workflowLimitMessage(limit: number): string {
  return `Your plan allows ${limit} workflows. Delete one or upgrade to add more.`;
}

/** True when a pg error is the trigger's NIA01 workflow-limit race — its own message IS the customer-facing copy. */
function isWorkflowLimitError(err: unknown): err is Error & { code: "NIA01" } {
  return err instanceof Error && "code" in err && (err as { code?: unknown }).code === "NIA01";
}

/**
 * Mirrors apps/api/src/services/dashboard.ts's getOrgPlan() exactly: same
 * "case when op.org_id is null then 25 else op.workflow_limit end"
 * left-join (not coalesce, so an explicit workflow_limit = null row
 * — unlimited — survives), same Pro/25 default for personal (org-less)
 * workspaces where org_plan structurally cannot apply.
 */
async function checkWorkflowLimit(
  userId: string,
  orgId: string | null,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const scopeColumn = orgId === null ? "owner_id" : "org_id";
  const scopeValue = orgId === null ? userId : orgId;

  const limit = await withActingUser(getPool(), userId, async (db) => {
    if (orgId === null) return 25;
    const { rows } = await db.query<{ workflow_limit: number | null }>(
      `select case when op.org_id is null then 25 else op.workflow_limit end as workflow_limit
       from (select $1::uuid as id) o
       left join public.org_plan op on op.org_id = o.id`,
      [orgId],
    );
    return rows[0] ? rows[0].workflow_limit : 25;
  });
  if (limit === null) return { ok: true }; // unlimited

  const count = await withActingUser(getPool(), userId, (db) =>
    db.query<{ count: number }>(`select count(*)::int as count from public.workflows where ${scopeColumn} = $1`, [scopeValue]),
  );
  const used = count.rows[0]?.count ?? 0;
  if (used >= limit) return { ok: false, message: workflowLimitMessage(limit) };
  return { ok: true };
}

export async function createWorkflow(
  orgId: string | null,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = workflowSchema.safeParse({
    name: formData.get("name"),
    projectId: formData.get("projectId"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const ctx = await requireUser();

  // orgId null means an individual (org-less) workspace — insert with
  // owner_id instead, matching the 0005_individual_workspace.sql xor shape.
  if (orgId === null) {
    if (ctx.role !== "individual") return { error: "Choose an organization first." };

    const limitCheck = await checkWorkflowLimit(ctx.userId, null);
    if (!limitCheck.ok) return { error: limitCheck.message };

    try {
      await withActingUser(getPool(), ctx.userId, (db) =>
        db.query(
          "insert into public.workflows (org_id, owner_id, project_id, name, created_by) values (null, $1, $2, $3, $1)",
          [ctx.userId, parsed.data.projectId, parsed.data.name],
        ),
      );
    } catch (err) {
      if (isWorkflowLimitError(err)) return { error: err.message };
      return { error: "Couldn't create the workflow. Try again." };
    }
    revalidateAppShell();
    return { success: true };
  }

  // Pre-check that the actor is actually a member of this org — mirrors
  // the workflows_insert_members RLS check, same reasoning as createProject.
  if (ctx.role === "individual" || ctx.org?.id !== orgId) {
    return { error: "You're not a member of this organization." };
  }

  // Same reasoning as createProject — ctx.org.id === orgId is already
  // confirmed above, so no cross-org ambiguity here.
  if (ctx.org.suspendedAt) return { error: SUSPENDED_ORG_MESSAGE };

  const limitCheck = await checkWorkflowLimit(ctx.userId, orgId);
  if (!limitCheck.ok) return { error: limitCheck.message };

  try {
    await withActingUser(getPool(), ctx.userId, (db) =>
      db.query("insert into public.workflows (org_id, project_id, name, created_by) values ($1, $2, $3, $4)", [
        orgId,
        parsed.data.projectId,
        parsed.data.name,
        ctx.userId,
      ]),
    );
  } catch (err) {
    if (isWorkflowLimitError(err)) return { error: err.message };
    return { error: "Couldn't create the workflow. Try again." };
  }

  revalidateAppShell();
  return { success: true };
}

// Rename/delete below don't take an `orgId` pre-check like create* above —
// they target a specific row by id, so RLS itself (workflows_update_members /
// _delete_members, projects_update_members / _delete_members, all covering
// org-member or individual-owner per 0002/0005) is the actual gate. If the
// caller isn't authorized, `update`/`delete` simply match zero rows (no
// Postgres error), which we detect via the `.select().maybeSingle()` coming
// back null and turn into the same friendly error string as a real failure.

export async function renameProject(
  projectId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = nameSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const user = await getSessionUser();
  if (!user) return { error: "Your session expired — sign in again." };

  const result = await withActingUser(getPool(), user.id, (db) =>
    db.query<{ id: string }>("update public.projects set name = $1 where id = $2 returning id", [
      parsed.data.name,
      projectId,
    ]),
  );
  const data = result.rows[0] ?? null;

  if (!data) {
    const suspendedMsg = await suspendedOrgMessage(user.id, "projects", projectId);
    return { error: suspendedMsg ?? "Couldn't rename the project. Try again." };
  }

  revalidateAppShell();
  revalidatePath(`/app/projects/${projectId}`);
  return { success: true };
}

export async function renameWorkflow(
  workflowId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = nameSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const user = await getSessionUser();
  if (!user) return { error: "Your session expired — sign in again." };

  const result = await withActingUser(getPool(), user.id, (db) =>
    db.query<{ id: string; project_id: string }>(
      "update public.workflows set name = $1 where id = $2 returning id, project_id",
      [parsed.data.name, workflowId],
    ),
  );
  const data = result.rows[0] ?? null;

  if (!data) {
    const suspendedMsg = await suspendedOrgMessage(user.id, "workflows", workflowId);
    return { error: suspendedMsg ?? "Couldn't rename the workflow. Try again." };
  }

  revalidateAppShell();
  revalidatePath(`/app/projects/${data.project_id}`);
  revalidatePath(`/app/workflows/${workflowId}`);
  return { success: true };
}

// Delete actions take (prevState, formData) — like every other action here —
// so the confirm dialogs can drive them with useActionState and surface a
// real error message instead of silently no-op'ing on an RLS mismatch.

export async function deleteProject(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const projectId = String(formData.get("projectId"));
  // Detail page deletes must navigate away (the project no longer exists);
  // the /app/projects list page instead stays put and just shows the
  // updated list — callers opt into that via a hidden `redirectTo` field.
  const redirectTo = String(formData.get("redirectTo") || "/app");

  const user = await getSessionUser();
  if (!user) return { error: "Your session expired — sign in again." };

  const result = await withActingUser(getPool(), user.id, (db) =>
    db.query<{ id: string }>("delete from public.projects where id = $1 returning id", [projectId]),
  );
  const data = result.rows[0] ?? null;

  if (!data) {
    const suspendedMsg = await suspendedOrgMessage(user.id, "projects", projectId);
    return { error: suspendedMsg ?? "Couldn't delete the project. Try again." };
  }

  revalidateAppShell();
  redirect(redirectTo);
}

export async function deleteWorkflow(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const workflowId = String(formData.get("workflowId"));
  const projectId = String(formData.get("projectId"));

  const user = await getSessionUser();
  if (!user) return { error: "Your session expired — sign in again." };

  const result = await withActingUser(getPool(), user.id, (db) =>
    db.query<{ id: string }>("delete from public.workflows where id = $1 returning id", [workflowId]),
  );
  const data = result.rows[0] ?? null;

  if (!data) {
    const suspendedMsg = await suspendedOrgMessage(user.id, "workflows", workflowId);
    return { error: suspendedMsg ?? "Couldn't delete the workflow. Try again." };
  }

  revalidateAppShell();
  redirect(`/app/projects/${projectId}`);
}

export async function updateWorkflowDefinition(
  workflowId: string,
  definition: WorkflowDefinition,
): Promise<{ error?: string; success?: boolean }> {
  const user = await getSessionUser();
  if (!user) return { error: "Your session expired — sign in again." };

  const result = await withActingUser(getPool(), user.id, (db) =>
    db.query<{ id: string }>("update public.workflows set definition = $1 where id = $2 returning id", [
      definition,
      workflowId,
    ]),
  );
  const data = result.rows[0] ?? null;

  if (!data) {
    const suspendedMsg = await suspendedOrgMessage(user.id, "workflows", workflowId);
    return { error: suspendedMsg ?? "Couldn't save the canvas. Try again." };
  }

  revalidatePath(`/app/workflows/${workflowId}`);
  return { success: true };
}
