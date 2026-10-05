import { afterAll, describe, expect, it } from "vitest";
import { withActingUser } from "@nia/db";
import { dbPool } from "../lib/dbPool.js";
import { createConnection, updateConnection } from "./connections.js";

/**
 * Slice C1, required test 4 ("Access") — real Postgres + real RLS, same
 * fixture users/org helpers as agents.integration.test.ts (duplicated here
 * by the same per-file convention, not shared). Proves
 * assertAgentConnectionScope (connections.ts) refuses, on both create AND
 * update, a sqlserver_agent connection pointed at another org's agent or at
 * a local connection that agent doesn't currently report — never just
 * silently returning zero rows via RLS, but an explicit 404.
 *
 * platform_agents/agent_reported_connections rows are inserted directly via
 * dbPool (standing in for the bridge's service-role writes — same posture
 * as agents.integration.test.ts's simulatePair/simulateCheckIn) rather than
 * running the real bridge process.
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
    ["agent-scope test org", `agent-scope-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, ownerId],
  );
  const orgId = rows[0]!.id;
  await dbPool.query("insert into public.organization_members (org_id, user_id, role) values ($1, $2, 'owner')", [
    orgId,
    ownerId,
  ]);
  return orgId;
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

/** Stands in for the bridge's /pair + /check-in writes (service-role, no acting user). */
async function makeAgentWithConnection(
  orgId: string,
  createdByUserId: string,
  localConnectionId: string,
): Promise<string> {
  const { rows } = await dbPool.query<{ id: string }>(
    `insert into public.platform_agents (org_id, created_by_user_id, display_name, agent_key_hash, status)
     values ($1, $2, 'test agent', $3, 'active')
     returning id`,
    [orgId, createdByUserId, `agent-scope-test-key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`],
  );
  const agentId = rows[0]!.id;
  await dbPool.query(
    `insert into public.agent_reported_connections (agent_id, local_connection_id, name, database_name, dialect)
     values ($1, $2, 'Local SQL Server', 'orders_db', 'mssql')`,
    [agentId, localConnectionId],
  );
  return agentId;
}

async function dropConnection(id: string): Promise<void> {
  await dbPool.query("delete from public.connections where id = $1", [id]);
}

describe("createConnection/updateConnection sqlserver_agent scope — real Postgres (Slice C1)", () => {
  it("a sqlserver_agent connection can only point at an agent/local connection the caller's own workspace currently reports", async () => {
    const ownerA = await fixtureUserId("canvas-e2e-a@nia.dev");
    const ownerB = await fixtureUserId("canvas-e2e-c@nia.dev");
    const orgA = await makeOrg(ownerA);
    const orgB = await makeOrg(ownerB);
    let connectionId: string | undefined;

    try {
      await installConnector(orgA, "sqlserver-agent", ownerA);
      const agentA = await makeAgentWithConnection(orgA, ownerA, "local-conn-1");
      const agentB = await makeAgentWithConnection(orgB, ownerB, "local-conn-2");

      const scopeA = { orgId: orgA };

      // Refused — agentId belongs to a different org (not visible via
      // workspaceWhere's org_id equality, regardless of RLS membership).
      await expect(
        createConnection(withUserFor(ownerA), scopeA, ownerA, {
          connectorId: "sqlserver-agent",
          displayName: "cross-org agent",
          fields: { agentId: agentB, agentConnectionId: "local-conn-2" },
        }),
      ).rejects.toMatchObject({ statusCode: 404, code: "AGENT_NOT_FOUND" });

      // Refused — agentId is the caller's own, but that agent doesn't
      // report this local_connection_id.
      await expect(
        createConnection(withUserFor(ownerA), scopeA, ownerA, {
          connectorId: "sqlserver-agent",
          displayName: "unreported local connection",
          fields: { agentId: agentA, agentConnectionId: "not-a-real-local-id" },
        }),
      ).rejects.toMatchObject({ statusCode: 404, code: "AGENT_CONNECTION_NOT_FOUND" });

      // Allowed — own org's agent + a local connection it currently reports.
      const created = await createConnection(withUserFor(ownerA), scopeA, ownerA, {
        connectorId: "sqlserver-agent",
        displayName: "valid agent connection",
        fields: { agentId: agentA, agentConnectionId: "local-conn-1" },
      });
      connectionId = created.id;
      expect(created.config.agentId).toBe(agentA);
      expect(created.config.agentConnectionId).toBe("local-conn-1");

      // Refused on update too — repointing the existing connection at the
      // other org's agent must be refused the same way, before the
      // unconditional server-side test-connect (dispatchTest) ever runs.
      await expect(
        updateConnection(withUserFor(ownerA), scopeA, created.id, ownerA, {
          fields: { agentId: agentB, agentConnectionId: "local-conn-2" },
        }),
      ).rejects.toMatchObject({ statusCode: 404, code: "AGENT_NOT_FOUND" });
    } finally {
      if (connectionId) await dropConnection(connectionId);
      await dropOrg(orgA);
      await dropOrg(orgB);
    }
  });
});
