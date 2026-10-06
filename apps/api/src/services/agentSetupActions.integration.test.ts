import { afterAll, describe, expect, it } from "vitest";
import { withActingUser, withServiceRole } from "@nia/db";
import type { AgentJobSetup } from "@nia/schemas";
import { dbPool } from "../lib/dbPool.js";
import { createConnection } from "./connections.js";
import { publishAgentSetup } from "./agentSetups.js";
import { requestAgentSetupAction, listAgentSetupRuns } from "./agentSetupActions.js";

/**
 * Slice R5a ("actions and run history for agent-delivered workflows" —
 * docs/plans/agent-canvas-integration.md B.7/B.8), required tests. Real
 * local Postgres only (apps/api/.env's DATABASE_URL), same fixture
 * users/org helpers as agentSetups.integration.test.ts (duplicated here
 * by the same per-file convention, not shared). Run explicitly with
 * `pnpm test:integration`.
 *
 * simulateRunReport below reproduces exactly the SQL services/agent-
 * bridge/src/app.ts's check-in handler runs for a run report that
 * carries a setupId, since this process never spins up the real bridge
 * (same posture as agentSetups.integration.test.ts's simulateSetupsCheckIn).
 */

afterAll(async () => {
  await dbPool.end();
});

async function fixtureUserId(email: string): Promise<string> {
  const { rows } = await dbPool.query<{ id: string }>('select id from public."user" where email = $1', [email]);
  const id = rows[0]?.id;
  if (!id) throw new Error(`fixture user ${email} not found — run \`pnpm --filter @nia/api seed:fixtures\` first`);
  return id;
}

async function makeOrg(ownerId: string): Promise<string> {
  const { rows } = await dbPool.query<{ id: string }>(
    `insert into public.organizations (name, slug, created_by) values ($1, $2, $3) returning id`,
    ["r5a test org", `r5a-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, ownerId],
  );
  const orgId = rows[0]!.id;
  await dbPool.query("insert into public.organization_members (org_id, user_id, role) values ($1, $2, 'owner')", [
    orgId,
    ownerId,
  ]);
  return orgId;
}

async function addMember(orgId: string, userId: string, role: string): Promise<void> {
  await dbPool.query("insert into public.organization_members (org_id, user_id, role) values ($1, $2, $3)", [
    orgId,
    userId,
    role,
  ]);
}

async function dropOrg(orgId: string): Promise<void> {
  await dbPool.query(
    "alter table public.organization_members disable trigger organization_members_protect_last_super_admin",
  );
  try {
    await dbPool.query("delete from public.organizations where id = $1", [orgId]);
  } finally {
    await dbPool.query(
      "alter table public.organization_members enable trigger organization_members_protect_last_super_admin",
    );
  }
}

function withUserFor(actingUserId: string) {
  return <T>(fn: (db: import("@nia/db").Queryable) => Promise<T>) => withActingUser(dbPool, actingUserId, fn);
}

async function installConnector(orgId: string, connectorId: string, installedByUserId: string): Promise<void> {
  await dbPool.query(
    `insert into public.connector_installs (org_id, connector_id, installed_by_user_id) values ($1, $2, $3)`,
    [orgId, connectorId, installedByUserId],
  );
}

async function makeWorkflow(orgId: string, userId: string): Promise<{ workflowId: string; projectId: string }> {
  const { rows: projectRows } = await dbPool.query<{ id: string }>(
    `insert into public.projects (org_id, name, created_by) values ($1, $2, $3) returning id`,
    [orgId, "r5a test project", userId],
  );
  const projectId = projectRows[0]!.id;
  const { rows: workflowRows } = await dbPool.query<{ id: string }>(
    `insert into public.workflows (project_id, org_id, name, created_by) values ($1, $2, $3, $4) returning id`,
    [projectId, orgId, "r5a test workflow", userId],
  );
  return { workflowId: workflowRows[0]!.id, projectId };
}

/** workflows_select_members (0055) requires org admin OR project membership — needed for both a viewer/member to even see the workflow. */
async function addProjectMember(projectId: string, userId: string): Promise<void> {
  await dbPool.query("insert into public.project_members (project_id, user_id) values ($1, $2)", [
    projectId,
    userId,
  ]);
}

/** Stands in for the bridge's /pair + /check-in's agentConnections write (service-role, no acting user). */
async function makeAgent(orgId: string, createdByUserId: string, localConnectionId: string): Promise<string> {
  const { rows } = await withServiceRole(dbPool, (db) =>
    db.query<{ id: string }>(
      `insert into public.platform_agents (org_id, created_by_user_id, display_name, agent_key_hash, status)
       values ($1, $2, 'r5a test agent', $3, 'active')
       returning id`,
      [orgId, createdByUserId, `r5a-test-key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`],
    ),
  );
  const agentId = rows[0]!.id;
  await withServiceRole(dbPool, (db) =>
    db.query(
      `insert into public.agent_reported_connections (agent_id, local_connection_id, name, database_name, dialect)
       values ($1, $2, 'Local SQL Server', 'orders_db', 'mssql')`,
      [agentId, localConnectionId],
    ),
  );
  return agentId;
}

function baseSetup(sourceConnectionId: string, destinationConnectionId: string): AgentJobSetup {
  return {
    sourceConnectionId,
    sourceTable: "dbo.orders",
    destinationConnectionId,
    columns: [],
    mapping: [],
    filter: [],
    params: {},
    mode: "replace",
  };
}

/** Stands in for the bridge's check-in's post-hold setups query (app.ts). */
async function simulateSetupsCheckIn(agentId: string): Promise<{ id: string; workflowId: string }[]> {
  const { rows } = await withServiceRole(dbPool, (db) =>
    db.query<{ id: string; workflow_id: string }>(
      `select id, workflow_id from public.agent_setups where agent_id = $1 and source = 'platform'`,
      [agentId],
    ),
  );
  return rows.map((row) => ({ id: row.id, workflowId: row.workflow_id }));
}

/** Stands in for a run report carrying setupId landing in the bridge's check-in handler (app.ts's runReports CTE). */
async function simulateRunReport(
  agentId: string,
  setupId: string,
  report: {
    runId: string;
    status: "ok" | "failed";
    rowsSent: number;
    rowsDeleted: number;
    mode: string | null;
    errorClass: string | null;
    startedAt: string;
    finishedAt: string;
  },
): Promise<void> {
  await withServiceRole(dbPool, (db) =>
    db.query(
      `with target as (
         select id from public.agent_setups
         where agent_id = $1
           and (
             (source = 'platform' and id = $15)
             or (source = 'local' and local_job_id = $2)
           )
       )
       insert into public.agent_setup_runs
         (agent_setup_id, run_id, status, rows_sent, rows_deleted, parts, mode, error_class, started_at, finished_at, is_realtime_aggregate, period_start, period_end)
       select target.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
       from target
       on conflict (run_id) do nothing`,
      [
        agentId,
        "unused-local-job-id",
        report.runId,
        report.status,
        report.rowsSent,
        report.rowsDeleted,
        0,
        report.mode,
        report.errorClass,
        report.startedAt,
        report.finishedAt,
        false,
        null,
        null,
        setupId,
      ],
    ),
  );
}

describe("agent_setup actions/run history — real Postgres (Slice R5a)", () => {
  it("allowed: a member's run now creates a task for the right agent, and a run report carrying the setup id appears in that workflow's run history", async () => {
    const ownerId = await fixtureUserId("canvas-e2e-a@nia.dev");
    const memberId = await fixtureUserId("canvas-e2e-c@nia.dev");
    const orgId = await makeOrg(ownerId);

    try {
      await addMember(orgId, memberId, "member");
      await installConnector(orgId, "sqlserver-agent", ownerId);
      await installConnector(orgId, "https-endpoint", ownerId);
      const agentId = await makeAgent(orgId, ownerId, "local-conn-r5a");
      const scope = { orgId };

      const source = await createConnection(withUserFor(ownerId), scope, ownerId, {
        connectorId: "sqlserver-agent",
        displayName: "r5a source",
        fields: { agentId, agentConnectionId: "local-conn-r5a" },
      });
      const destination = await createConnection(
        withUserFor(ownerId),
        scope,
        ownerId,
        {
          connectorId: "https-endpoint",
          displayName: "r5a destination",
          fields: { address: "https://example.com/webhook", authMethod: "none" },
        },
        { assertAddressSafe: async () => {} },
      );

      const { workflowId, projectId } = await makeWorkflow(orgId, ownerId);
      // workflows_select_members (0055) requires org admin OR project membership.
      await addProjectMember(projectId, memberId);

      await publishAgentSetup(withUserFor(ownerId), scope, workflowId, source.id, destination.id, baseSetup(source.id, destination.id));
      const checkIn = await simulateSetupsCheckIn(agentId);
      const setupId = checkIn.find((s) => s.workflowId === workflowId)!.id;

      const task = await requestAgentSetupAction(withUserFor(memberId), scope, workflowId, {
        kind: "run_now",
        params: { since: "2024-01-01" },
      });
      expect(task.kind).toBe("run_now");
      expect(task.agentSetupId).toBe(setupId);

      const { rows: taskRows } = await withServiceRole(dbPool, (db) =>
        db.query<{ agent_id: string; kind: string; agent_setup_id: string; payload: Record<string, unknown> }>(
          `select agent_id, kind, agent_setup_id, payload from public.agent_tasks where id = $1`,
          [task.id],
        ),
      );
      expect(taskRows[0]).toMatchObject({ agent_id: agentId, kind: "run_now", agent_setup_id: setupId });
      expect(taskRows[0]!.payload).toMatchObject({ params: { since: "2024-01-01" } });

      await simulateRunReport(agentId, setupId, {
        // Distinct from agents.integration.test.ts's own hardcoded run_id
        // ("1111...1111") — both files ran in the same vitest.integration.config.ts
        // suite against the same real Postgres, and run_id has a UNIQUE
        // constraint (agent_setup_runs_run_id_key), so sharing the literal
        // caused whichever file ran second to silently no-op its insert via
        // ON CONFLICT DO NOTHING.
        runId: "66666666-6666-6666-6666-666666666666",
        status: "ok",
        rowsSent: 42,
        rowsDeleted: 3,
        mode: "incremental",
        errorClass: null,
        startedAt: new Date(Date.now() - 5000).toISOString(),
        finishedAt: new Date().toISOString(),
      });

      const runs = await listAgentSetupRuns(withUserFor(memberId), scope, workflowId);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "ok", rowsSent: 42, rowsDeleted: 3, mode: "incremental" });
    } finally {
      // Deleting the org cascades to workflows (-> agent_setups -> agent_setup_runs),
      // platform_agents, agent_tasks and connections alike.
      await dropOrg(orgId);
    }
  });

  it("refused: a viewer cannot trigger any action; allow-one-large-delete without the confirmation flag is refused; a user without access to the workflow cannot read its runs", async () => {
    const ownerId = await fixtureUserId("canvas-e2e-a@nia.dev");
    const viewerId = await fixtureUserId("canvas-e2e-b@nia.dev");
    const outsiderId = await fixtureUserId("canvas-e2e-c@nia.dev");
    const orgId = await makeOrg(ownerId);

    try {
      await addMember(orgId, viewerId, "viewer");
      await installConnector(orgId, "sqlserver-agent", ownerId);
      await installConnector(orgId, "https-endpoint", ownerId);
      const agentId = await makeAgent(orgId, ownerId, "local-conn-r5a-refused");
      const scope = { orgId };

      const source = await createConnection(withUserFor(ownerId), scope, ownerId, {
        connectorId: "sqlserver-agent",
        displayName: "r5a refused source",
        fields: { agentId, agentConnectionId: "local-conn-r5a-refused" },
      });
      const destination = await createConnection(
        withUserFor(ownerId),
        scope,
        ownerId,
        {
          connectorId: "https-endpoint",
          displayName: "r5a refused destination",
          fields: { address: "https://example.com/webhook", authMethod: "none" },
        },
        { assertAddressSafe: async () => {} },
      );

      const { workflowId, projectId } = await makeWorkflow(orgId, ownerId);
      // workflows_select_members (0055) requires org admin OR project
      // membership — without this the viewer gets 404 NOT_FOUND (can't see
      // the workflow at all) rather than the write-authorization 403 this
      // test is actually after.
      await addProjectMember(projectId, viewerId);

      await publishAgentSetup(withUserFor(ownerId), scope, workflowId, source.id, destination.id, baseSetup(source.id, destination.id));

      // A viewer cannot trigger any action (private.can_write_workflow excludes viewer).
      await expect(
        requestAgentSetupAction(withUserFor(viewerId), scope, workflowId, { kind: "test" }),
      ).rejects.toMatchObject({ statusCode: 403, code: "ACTION_REFUSED" });

      // Allow-one-large-delete without the explicit confirmation flag is refused
      // before it ever reaches the RPC's own mass-delete-guard-state check.
      await expect(
        requestAgentSetupAction(withUserFor(ownerId), scope, workflowId, { kind: "allow_mass_delete" }),
      ).rejects.toMatchObject({ statusCode: 400, code: "CONFIRMATION_REQUIRED" });

      // A user without access to this workflow (their own personal workspace,
      // not this org) cannot read its run history.
      await expect(
        listAgentSetupRuns(withUserFor(outsiderId), { ownerId: outsiderId }, workflowId),
      ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
    } finally {
      await dropOrg(orgId);
    }
  });
});
