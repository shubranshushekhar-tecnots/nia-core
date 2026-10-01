import { withActingUser } from "@nia/db";
import { auth } from "../lib/auth.js";
import { dbPool } from "../lib/dbPool.js";
import { env } from "../env.js";

/**
 * Idempotently creates the 5 manual-test personas (superadmin, individual,
 * owner, admin, member of "Nia Test Org") plus two projects/workflows, via
 * the same real code paths the app itself uses (Better Auth signUpEmail,
 * the create_organization RPC, RLS-scoped inserts through withActingUser) —
 * never raw/service-role SQL for anything RLS normally gates, so plans,
 * triggers, and memberships end up set up exactly as in real signup/invite
 * flows.
 *
 * LOCAL DEV ONLY: refuses to run unless DATABASE_URL points at
 * localhost/127.0.0.1. Password is read from the MANUAL_TEST_PASSWORD env
 * var, never hardcoded here.
 *
 *   MANUAL_TEST_PASSWORD='...' pnpm --filter @nia/api seed:manual-test-profiles
 *
 * Safe to re-run: every step checks for an existing row first. Does NOT
 * grant platform_staff to superadmin@nia.test — that's a separate,
 * deliberately CLI-only step (see manageStaff.ts's own header comment for
 * why): run
 *   pnpm --filter @nia/api staff:grant superadmin@nia.test --by demo@nia.dev
 * (or --bootstrap if no active staff exists yet) after this script finishes.
 */

const password = process.env.MANUAL_TEST_PASSWORD;
if (!password) {
  console.error("Refusing: set MANUAL_TEST_PASSWORD env var (never hardcode the password here).");
  process.exit(1);
}

if (!/(localhost|127\.0\.0\.1)/.test(env.DATABASE_URL)) {
  console.error(`Refusing: DATABASE_URL does not point at localhost/127.0.0.1 (${env.DATABASE_URL}). This script only ever runs against local dev.`);
  process.exit(1);
}

async function findUserIdByEmail(email: string): Promise<string | null> {
  const r = await dbPool.query<{ id: string }>('select id from "user" where email = $1', [email]);
  return r.rows[0]?.id ?? null;
}

async function ensureUser(email: string, name: string): Promise<string> {
  const existing = await findUserIdByEmail(email);
  if (existing) {
    console.log(`user exists: ${email} -> ${existing}`);
    return existing;
  }
  const result = await auth.api.signUpEmail({ body: { email, password: password!, name } });
  console.log(`created user: ${email} -> ${result.user.id}`);
  return result.user.id;
}

async function findOrgBySlug(slug: string): Promise<string | null> {
  const r = await dbPool.query<{ id: string }>("select id from public.organizations where slug = $1", [slug]);
  return r.rows[0]?.id ?? null;
}

async function ensureOrg(ownerUserId: string, name: string, slug: string): Promise<string> {
  const existing = await findOrgBySlug(slug);
  if (existing) {
    console.log(`org exists: ${slug} -> ${existing}`);
    return existing;
  }
  const result = await withActingUser(dbPool, ownerUserId, (db) =>
    db.query<{ create_organization: string }>("select public.create_organization($1, $2) as create_organization", [name, slug]),
  );
  const orgId = result.rows[0]!.create_organization;
  console.log(`created org: ${slug} -> ${orgId}`);
  return orgId;
}

async function ensureOrgMembership(
  actingUserId: string,
  orgId: string,
  targetUserId: string,
  role: "admin" | "member",
): Promise<void> {
  const existing = await dbPool.query<{ role: string }>(
    "select role from public.organization_members where org_id = $1 and user_id = $2",
    [orgId, targetUserId],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].role !== role) {
      await withActingUser(dbPool, actingUserId, (db) =>
        db.query("update public.organization_members set role = $1 where org_id = $2 and user_id = $3", [role, orgId, targetUserId]),
      );
      console.log(`updated membership role: ${targetUserId} -> ${role} in org ${orgId}`);
    } else {
      console.log(`membership already ${role}: ${targetUserId} in org ${orgId}`);
    }
    return;
  }
  await withActingUser(dbPool, actingUserId, (db) =>
    db.query("insert into public.organization_members (org_id, user_id, role) values ($1, $2, $3)", [orgId, targetUserId, role]),
  );
  console.log(`added membership: ${targetUserId} -> ${role} in org ${orgId}`);
}

/**
 * Nia Test Org needs 2 projects; Free (the default new-org plan, 0050) caps
 * projects at 1. Bumps this org to Pro (project_limit 5) so the fixture data
 * below fits — same org_plan row a Console admin would edit, just written
 * directly since org_plan writes are Console/service_role-only by design
 * (0042/0050_org_plan.sql) and this is local test-data setup, not a
 * simulated user action.
 */
async function ensureOrgPlan(orgId: string, planId: string): Promise<void> {
  const existing = await dbPool.query<{ plan_id: string }>("select plan_id from public.org_plan where org_id = $1", [orgId]);
  if (existing.rows[0]?.plan_id === planId) {
    console.log(`org plan already ${planId}: ${orgId}`);
    return;
  }
  await dbPool.query("update public.org_plan set plan_id = $1, updated_at = now() where org_id = $2", [planId, orgId]);
  console.log(`set org plan: ${orgId} -> ${planId}`);
}

async function findProjectByName(orgId: string, name: string): Promise<string | null> {
  const r = await dbPool.query<{ id: string }>("select id from public.projects where org_id = $1 and name = $2", [orgId, name]);
  return r.rows[0]?.id ?? null;
}

async function ensureProject(actingUserId: string, orgId: string, name: string): Promise<string> {
  const existing = await findProjectByName(orgId, name);
  if (existing) {
    console.log(`project exists: ${name} -> ${existing}`);
    return existing;
  }
  await withActingUser(dbPool, actingUserId, (db) =>
    db.query("insert into public.projects (org_id, name, created_by) values ($1, $2, $3)", [orgId, name, actingUserId]),
  );
  const id = await findProjectByName(orgId, name);
  console.log(`created project: ${name} -> ${id}`);
  return id!;
}

async function ensureProjectMember(actingUserId: string, projectId: string, targetUserId: string): Promise<void> {
  const existing = await dbPool.query("select 1 from public.project_members where project_id = $1 and user_id = $2", [
    projectId,
    targetUserId,
  ]);
  if (existing.rows[0]) {
    console.log(`already a project member: ${targetUserId} in project ${projectId}`);
    return;
  }
  await withActingUser(dbPool, actingUserId, (db) =>
    db.query("insert into public.project_members (project_id, user_id) values ($1, $2) on conflict do nothing", [
      projectId,
      targetUserId,
    ]),
  );
  console.log(`added project member: ${targetUserId} -> project ${projectId}`);
}

async function findWorkflowByName(orgId: string, projectId: string, name: string): Promise<string | null> {
  const r = await dbPool.query<{ id: string }>(
    "select id from public.workflows where org_id = $1 and project_id = $2 and name = $3",
    [orgId, projectId, name],
  );
  return r.rows[0]?.id ?? null;
}

async function ensureWorkflow(actingUserId: string, orgId: string, projectId: string, name: string): Promise<string> {
  const existing = await findWorkflowByName(orgId, projectId, name);
  if (existing) {
    console.log(`workflow exists: ${name} -> ${existing}`);
    return existing;
  }
  await withActingUser(dbPool, actingUserId, (db) =>
    db.query("insert into public.workflows (org_id, project_id, name, created_by) values ($1, $2, $3, $4)", [
      orgId,
      projectId,
      name,
      actingUserId,
    ]),
  );
  const id = await findWorkflowByName(orgId, projectId, name);
  console.log(`created workflow: ${name} -> ${id}`);
  return id!;
}

async function main() {
  await ensureUser("superadmin@nia.test", "Super Admin Test");
  await ensureUser("individual@nia.test", "Individual Test");
  const ownerId = await ensureUser("owner@nia.test", "Owner Test");
  const adminId = await ensureUser("admin@nia.test", "Admin Test");
  const memberId = await ensureUser("member@nia.test", "Member Test");

  const orgId = await ensureOrg(ownerId, "Nia Test Org", "nia-test-org");

  await ensureOrgMembership(ownerId, orgId, adminId, "admin");
  await ensureOrgMembership(ownerId, orgId, memberId, "member");
  await ensureOrgPlan(orgId, "pro");

  const projectAlphaId = await ensureProject(ownerId, orgId, "Project Alpha");
  const projectBetaId = await ensureProject(ownerId, orgId, "Project Beta");

  await ensureProjectMember(ownerId, projectAlphaId, memberId);

  await ensureWorkflow(ownerId, orgId, projectAlphaId, "Alpha Workflow");
  await ensureWorkflow(ownerId, orgId, projectBetaId, "Beta Workflow");

  console.log(
    "\nDone. Remaining manual steps: (1) grant staff to superadmin@nia.test via staff:grant, " +
      "(2) it will need to enrol 2FA on its first /console visit.",
  );
  await dbPool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
