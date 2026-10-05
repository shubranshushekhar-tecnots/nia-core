import { afterAll, describe, expect, it } from "vitest";
import { withActingUser, withServiceRole } from "@nia/db";
import { decryptSecret, parseMasterKey, type EncryptedSecret } from "@nia/secrets";
import type { AgentJobSetup } from "@nia/schemas";
import { dbPool } from "../lib/dbPool.js";
import { createConnection } from "./connections.js";
import { previewPublishAgentSetup, publishAgentSetup } from "./agentSetups.js";

/**
 * Slice R3a ("publishing a job to an agent, platform side" — docs/plans/
 * agent-canvas-integration.md B.2/B.4/B.7), required tests. Real local
 * Postgres only (apps/api/.env's DATABASE_URL), same fixture users/org
 * helpers as agents.integration.test.ts / connections.agentScope.
 * integration.test.ts (duplicated here by the same per-file convention,
 * not shared). Run explicitly with `pnpm test:integration`.
 *
 * The bridge's own service-role reads (services/agent-bridge/src/app.ts's
 * check-in setups list, GET /agent-api/setups/:id, GET
 * /agent-api/setups/:id/secret) are simulated here directly via
 * withServiceRole against the same dbPool, reproducing exactly the SQL
 * those routes run — same posture as agents.integration.test.ts's
 * simulatePair/simulateCheckIn, since this process never spins up the
 * real bridge.
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
    ["r3a test org", `r3a-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, ownerId],
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
    [orgId, "r3a test project", userId],
  );
  const projectId = projectRows[0]!.id;
  const { rows: workflowRows } = await dbPool.query<{ id: string }>(
    `insert into public.workflows (project_id, org_id, name, created_by) values ($1, $2, $3, $4) returning id`,
    [projectId, orgId, "r3a test workflow", userId],
  );
  return { workflowId: workflowRows[0]!.id, projectId };
}

/** workflows_select_members (0055) requires org admin OR project membership — a viewer needs this to even see the workflow (404 vs the write-authorization 403 this test is actually after). */
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
       values ($1, $2, 'r3a test agent', $3, 'active')
       returning id`,
      [orgId, createdByUserId, `r3a-test-key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`],
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

function baseSetup(
  sourceConnectionId: string,
  destinationConnectionId: string,
  overrides: Partial<AgentJobSetup> = {},
): AgentJobSetup {
  return {
    sourceConnectionId,
    sourceTable: "dbo.orders",
    destinationConnectionId,
    columns: [],
    mapping: [],
    filter: [],
    params: {},
    mode: "replace",
    ...overrides,
  };
}

/** Stands in for the bridge's check-in's post-hold setups query (app.ts). */
async function simulateSetupsCheckIn(
  agentId: string,
): Promise<{ id: string; workflowId: string; wantedVersion: number; appliedVersion: number; removed: boolean }[]> {
  const { rows } = await withServiceRole(dbPool, (db) =>
    db.query<{
      id: string;
      workflow_id: string;
      wanted_version: number;
      applied_version: number;
      unpublished_at: string | null;
    }>(
      `select id, workflow_id, wanted_version, applied_version, unpublished_at
       from public.agent_setups where agent_id = $1 and source = 'platform'`,
      [agentId],
    ),
  );
  return rows.map((row) => ({
    id: row.id,
    workflowId: row.workflow_id,
    wantedVersion: row.wanted_version,
    appliedVersion: row.applied_version,
    removed: row.unpublished_at !== null,
  }));
}

/** Stands in for the bridge's GET /agent-api/setups/:id (app.ts) — same combined 404 for wrong-agent/not-found/unpublished. */
async function simulateFetchSetup(
  setupId: string,
  requestingAgentId: string,
): Promise<{
  id: string;
  workflowId: string;
  wantedVersion: number;
  setup: Record<string, unknown> | null;
  destination: { connectorId: string; config: Record<string, unknown> };
}> {
  const { rows } = await withServiceRole(dbPool, (db) =>
    db.query<{
      id: string;
      agent_id: string;
      workflow_id: string;
      wanted_version: number;
      published_setup: Record<string, unknown> | null;
      unpublished_at: string | null;
      connection_id: string | null;
      destination_connection_id: string | null;
    }>(
      `select id, agent_id, workflow_id, wanted_version, published_setup, unpublished_at, connection_id, destination_connection_id
       from public.agent_setups where id = $1 and source = 'platform'`,
      [setupId],
    ),
  );
  const setup = rows[0];
  if (!setup || setup.agent_id !== requestingAgentId || setup.unpublished_at !== null) {
    throw new Error("setup not found");
  }

  const { rows: connRows } = await withServiceRole(dbPool, (db) =>
    db.query<{ id: string; connector_id: string; config: Record<string, unknown> }>(
      `select id, connector_id, config from public.connections where id = any($1::uuid[])`,
      [[setup.connection_id, setup.destination_connection_id]],
    ),
  );
  const destination = connRows.find((row) => row.id === setup.destination_connection_id);
  if (!destination) throw new Error("destination connection not found");

  return {
    id: setup.id,
    workflowId: setup.workflow_id,
    wantedVersion: setup.wanted_version,
    setup: setup.published_setup,
    destination: { connectorId: destination.connector_id, config: destination.config },
  };
}

/** Stands in for the bridge's GET /agent-api/setups/:id/secret (app.ts). */
async function simulateFetchSecret(setupId: string, requestingAgentId: string): Promise<Record<string, unknown>> {
  const { rows } = await withServiceRole(dbPool, (db) =>
    db.query<{ agent_id: string; unpublished_at: string | null; destination_connection_id: string | null }>(
      `select agent_id, unpublished_at, destination_connection_id from public.agent_setups where id = $1 and source = 'platform'`,
      [setupId],
    ),
  );
  const setup = rows[0];
  if (!setup || setup.agent_id !== requestingAgentId || setup.unpublished_at !== null || !setup.destination_connection_id) {
    throw new Error("setup not found");
  }

  const { rows: connRows } = await withServiceRole(dbPool, (db) =>
    db.query<{ vault_secret_ref: string }>(`select vault_secret_ref from public.connections where id = $1`, [
      setup.destination_connection_id,
    ]),
  );
  const ref = connRows[0]?.vault_secret_ref;
  if (!ref) throw new Error("destination connection not found");

  const { rows: secretRows } = await withServiceRole(dbPool, (db) =>
    db.query<{
      ciphertext: string;
      encrypted_data_key: string;
      iv: string;
      auth_tag: string;
      algorithm: string;
      key_version: number;
    }>(
      `select ciphertext, encrypted_data_key, iv, auth_tag, algorithm, key_version from public.nia_secrets where id = $1`,
      [ref],
    ),
  );
  const secretRow = secretRows[0];
  if (!secretRow) throw new Error("secret not found");

  const masterKey = parseMasterKey(process.env.NIA_SECRET_MASTER_KEY);
  const encrypted: EncryptedSecret = {
    ciphertext: secretRow.ciphertext,
    encryptedDataKey: secretRow.encrypted_data_key,
    iv: secretRow.iv,
    authTag: secretRow.auth_tag,
    algorithm: secretRow.algorithm,
    keyVersion: secretRow.key_version,
  };
  return decryptSecret(masterKey, encrypted);
}

describe("agent_setups publish/fetch — real Postgres (Slice R3a)", () => {
  it("allowed: publishing stores the setup and raises wanted_version; the next check-in lists it; the agent fetches it without secrets and the secret separately; a changed filter forces a full reload", async () => {
    const ownerId = await fixtureUserId("canvas-e2e-a@nia.dev");
    const orgId = await makeOrg(ownerId);

    try {
      await installConnector(orgId, "sqlserver-agent", ownerId);
      await installConnector(orgId, "https-endpoint", ownerId);
      const agentId = await makeAgent(orgId, ownerId, "local-conn-r3a");
      const scope = { orgId };

      const source = await createConnection(withUserFor(ownerId), scope, ownerId, {
        connectorId: "sqlserver-agent",
        displayName: "r3a source",
        fields: { agentId, agentConnectionId: "local-conn-r3a" },
      });
      const sourceConnectionId = source.id;

      const destination = await createConnection(
        withUserFor(ownerId),
        scope,
        ownerId,
        {
          connectorId: "https-endpoint",
          displayName: "r3a destination",
          fields: { address: "https://example.com/webhook", authMethod: "bearer", bearerToken: "r3a-secret-token" },
        },
        { assertAddressSafe: async () => {} },
      );
      const destConnectionId = destination.id;

      const { workflowId } = await makeWorkflow(orgId, ownerId);

      const setupV1 = baseSetup(sourceConnectionId, destConnectionId);
      const published = await publishAgentSetup(
        withUserFor(ownerId),
        scope,
        workflowId,
        sourceConnectionId,
        destConnectionId,
        setupV1,
      );
      expect(published.wantedVersion).toBe(1);
      expect(published.appliedVersion).toBe(0);

      const checkIn = await simulateSetupsCheckIn(agentId);
      const listed = checkIn.find((s) => s.workflowId === workflowId);
      expect(listed).toMatchObject({ wantedVersion: 1, appliedVersion: 0, removed: false });

      const fetched = await simulateFetchSetup(listed!.id, agentId);
      expect(fetched.setup).toMatchObject({ sourceTable: "dbo.orders", mode: "replace" });
      expect(fetched.destination.config).not.toHaveProperty("bearerToken");
      expect(JSON.stringify(fetched)).not.toContain("r3a-secret-token");

      const secret = await simulateFetchSecret(listed!.id, agentId);
      expect(secret).toMatchObject({ bearerToken: "r3a-secret-token" });

      const setupV2 = baseSetup(sourceConnectionId, destConnectionId, {
        filter: [{ field: "status", operator: "eq", value: "active" }],
      });
      const preview = await previewPublishAgentSetup(
        withUserFor(ownerId),
        scope,
        workflowId,
        sourceConnectionId,
        destConnectionId,
        setupV2,
      );
      expect(preview.currentlyPublished).toBe(true);
      expect(preview.diff.changedFields).toContain("filter");
      expect(preview.diff.forcesFullReload).toBe(true);
    } finally {
      // Deleting the org cascades to workflows (-> agent_setups), platform_agents and
      // connections alike — no separate connection/agent cleanup needed.
      await dropOrg(orgId);
    }
  });

  it("refused: a viewer cannot publish; a non-local source is refused; another agent's key cannot fetch the setup or its secret", async () => {
    const ownerId = await fixtureUserId("canvas-e2e-a@nia.dev");
    const viewerId = await fixtureUserId("canvas-e2e-b@nia.dev");
    const orgId = await makeOrg(ownerId);

    try {
      await addMember(orgId, viewerId, "viewer");
      await installConnector(orgId, "sqlserver-agent", ownerId);
      await installConnector(orgId, "https-endpoint", ownerId);
      const agentId = await makeAgent(orgId, ownerId, "local-conn-r3a-refused");
      const otherAgentId = await makeAgent(orgId, ownerId, "local-conn-r3a-refused-other");
      const scope = { orgId };

      const source = await createConnection(withUserFor(ownerId), scope, ownerId, {
        connectorId: "sqlserver-agent",
        displayName: "r3a refused source",
        fields: { agentId, agentConnectionId: "local-conn-r3a-refused" },
      });
      const sourceConnectionId = source.id;

      const destination = await createConnection(
        withUserFor(ownerId),
        scope,
        ownerId,
        {
          connectorId: "https-endpoint",
          displayName: "r3a refused destination",
          fields: { address: "https://example.com/webhook", authMethod: "none" },
        },
        { assertAddressSafe: async () => {} },
      );
      const destConnectionId = destination.id;

      const otherDestination = await createConnection(
        withUserFor(ownerId),
        scope,
        ownerId,
        {
          connectorId: "https-endpoint",
          displayName: "r3a refused destination 2",
          fields: { address: "https://example.com/webhook2", authMethod: "none" },
        },
        { assertAddressSafe: async () => {} },
      );
      const otherDestConnectionId = otherDestination.id;

      const { workflowId, projectId } = await makeWorkflow(orgId, ownerId);
      // workflows_select_members (0055) requires org admin OR project
      // membership — without this the viewer gets 404 NOT_FOUND (can't see
      // the workflow at all) rather than the write-authorization 403 this
      // test is actually after.
      await addProjectMember(projectId, viewerId);
      const setup = baseSetup(sourceConnectionId, destConnectionId);

      // A viewer cannot publish (private.can_write_workflow excludes viewer).
      await expect(
        publishAgentSetup(withUserFor(viewerId), scope, workflowId, sourceConnectionId, destConnectionId, setup),
      ).rejects.toMatchObject({ statusCode: 403, code: "PUBLISH_REFUSED" });

      // A source that is not a local-database connection is refused —
      // using the destination connection itself as the "source".
      await expect(
        publishAgentSetup(
          withUserFor(ownerId),
          scope,
          workflowId,
          destConnectionId,
          otherDestConnectionId,
          baseSetup(destConnectionId, otherDestConnectionId),
        ),
      ).rejects.toMatchObject({ code: "INVALID_SOURCE" });

      // Publish for real, then prove another agent's key cannot fetch it.
      const published = await publishAgentSetup(
        withUserFor(ownerId),
        scope,
        workflowId,
        sourceConnectionId,
        destConnectionId,
        setup,
      );
      const checkIn = await simulateSetupsCheckIn(agentId);
      const setupId = checkIn.find((s) => s.workflowId === workflowId)!.id;
      expect(published.wantedVersion).toBeGreaterThanOrEqual(1);

      await expect(simulateFetchSetup(setupId, otherAgentId)).rejects.toThrow("setup not found");
      await expect(simulateFetchSecret(setupId, otherAgentId)).rejects.toThrow("setup not found");
    } finally {
      // Deleting the org cascades to workflows (-> agent_setups), platform_agents and
      // connections alike — no separate connection/agent cleanup needed.
      await dropOrg(orgId);
    }
  });
});
