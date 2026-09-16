/**
 * Live smoke test for the dispatch path (apps/worker/src/lib/dispatch.ts)
 * against real infrastructure — NOT mocks. Route-level mocks (dispatch.test.ts,
 * connectorClient.test.ts, resolveConnection.test.ts) already prove the
 * logic in isolation; this script proves the wiring: real Postgres (via
 * local `supabase start`), real connector services (mysql/mongodb/supabase,
 * running as actual containers via `docker compose up --build`, NOT host
 * processes — see PHASE1_NOTES.md for the Dockerfile fix that made this
 * possible), real sandbox databases (docker-compose's
 * dev-mysql/dev-mongo/dev-postgres, also containers).
 *
 * Run with (from apps/worker/):
 *   npx tsx scripts/dispatch-smoke.ts
 * (reads apps/worker/.env for SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/
 * CONNECTOR_DEV_HOST via dotenv/config, same as env.ts)
 *
 * Prerequisites (not started by this script):
 *   - `supabase start` (applies migrations + seed.sql)
 *   - `docker compose up -d --build redis dev-mysql dev-mongo dev-postgres
 *     connector-mysql connector-mongodb connector-supabase` — the connector
 *     containers need SUPABASE_URL=http://host.docker.internal:54321 (see
 *     root .env) since 127.0.0.1 inside a container is the container itself,
 *     not the host running `supabase start`.
 *
 * This script itself runs on the HOST (not in a container), so it reaches
 * the connector services' HTTP APIs via CONNECTOR_DEV_HOST=localhost +
 * their published ports (4010/4020/4030) — unchanged by containerization,
 * since docker-compose still publishes those ports to the host loopback.
 *
 * ---- SEEDING (separate from assertions below) ----
 * supabase/seed.sql has no sandbox connections, so this script creates its
 * own: one connector_installs + connections row per connector, each
 * pointed at the docker-compose sandbox DB using the docker-compose
 * *service name* as host (dev-mysql/dev-mongo/dev-postgres) and the
 * container-internal port (3306/27017/5432, NOT the host-remapped
 * 3307/27018/5433). The connector SERVICE dials this `config.host:port`
 * from inside its own container, over the shared compose `default`
 * network — it never sees the host-published port remaps, which exist
 * only so this script (and a human) can reach the sandbox DBs directly
 * from the host for debugging. This is the same CONNECTOR_DEV_HOST
 * duality documented in env.ts, just applied to the connector -> sandbox
 * DB hop instead of the worker -> connector hop.
 */
import { createClient } from "@supabase/supabase-js";
import { dispatch } from "../src/lib/dispatch.js";
import type { WorkspaceScope } from "../src/lib/workspaceScope.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY must be set (see this script's header comment).");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DEMO_USER_ID = "00000000-0000-0000-0000-0000000000d1";
// These configs are dialed by the connector SERVICE containers, not by this
// script — so they use docker-compose *service names* and each DB image's
// container-internal port (never the host-remapped 3307/27018/5433, which
// only exist so this script/a human can reach the sandbox DBs directly from
// the host; see this file's header comment).
const SANDBOX = {
  mysql: { host: "dev-mysql", port: 3306, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
  mongodb: { host: "dev-mongo", port: 27017, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
  supabase: { host: "dev-postgres", port: 5432, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
} as const;

type ConnectorId = keyof typeof SANDBOX;

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

async function getOrgId(): Promise<string> {
  const { data, error } = await supabase.from("organizations").select("id").eq("slug", "icecream-co").single();
  if (error || !data) throw new Error(`Could not find seed.sql's demo org: ${error?.message}`);
  return data.id as string;
}

async function seedConnection(orgId: string, connectorId: ConnectorId): Promise<string> {
  const { host, port, database, user, password } = SANDBOX[connectorId];

  const { count: installCount } = await supabase
    .from("connector_installs")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("connector_id", connectorId);
  if (!installCount) {
    const { error } = await supabase
      .from("connector_installs")
      .insert({ org_id: orgId, connector_id: connectorId, installed_by_user_id: DEMO_USER_ID });
    if (error) throw new Error(`install ${connectorId} failed: ${error.message}`);
  }

  const handle = `@${connectorId}-dispatch-smoke`;
  const { data: existing } = await supabase
    .from("connections")
    .select("id")
    .eq("org_id", orgId)
    .eq("handle", handle)
    .maybeSingle();
  if (existing) {
    // Keep config in sync across reruns — e.g. switching between host-run
    // and containerized connector services changes host/port here.
    const { error } = await supabase
      .from("connections")
      .update({ config: { host, port, database } })
      .eq("id", existing.id as string);
    if (error) throw new Error(`connection config update for ${connectorId} failed: ${error.message}`);
    return existing.id as string;
  }

  const { data: vaultRef, error: vaultError } = await supabase.rpc("create_connector_secret", {
    p_secret: { user, password },
  });
  if (vaultError || !vaultRef) throw new Error(`vault write for ${connectorId} failed: ${vaultError?.message}`);

  const { data, error } = await supabase
    .from("connections")
    .insert({
      org_id: orgId,
      owner_id: null,
      connector_id: connectorId,
      handle,
      display_name: `Dispatch smoke (${connectorId})`,
      owner_user_id: DEMO_USER_ID,
      config: { host, port, database },
      vault_secret_ref: vaultRef as string,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`connection insert for ${connectorId} failed: ${error?.message}`);
  return data.id as string;
}

async function countAuditRows(connectionId: string): Promise<number> {
  const { count } = await supabase
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("detail->>connectionId", connectionId);
  return count ?? 0;
}

async function main(): Promise<void> {
  log("=== SEEDING (not part of the dispatch proof below) ===");
  const orgId = await getOrgId();
  const scope: WorkspaceScope = { orgId };
  const connectionIds: Record<ConnectorId, string> = {
    mysql: await seedConnection(orgId, "mysql"),
    mongodb: await seedConnection(orgId, "mongodb"),
    supabase: await seedConnection(orgId, "supabase"),
  };
  log(`Seeded connections: ${JSON.stringify(connectionIds)}`);

  log("\n=== ASSERTIONS: dispatch() against real infra ===");
  let failures = 0;

  function assert(label: string, cond: boolean, detail?: unknown): void {
    if (cond) {
      log(`  PASS  ${label}`);
    } else {
      failures++;
      log(`  FAIL  ${label} ${detail !== undefined ? JSON.stringify(detail) : ""}`);
    }
  }

  // --- success path: SQL connectors ---
  for (const connectorId of ["mysql", "supabase"] as const) {
    const auditBefore = await countAuditRows(connectionIds[connectorId]);
    const result = await dispatch(
      connectionIds[connectorId],
      { kind: "sql", sql: "SELECT id, name FROM sandbox_items ORDER BY id", params: [] },
      scope,
      DEMO_USER_ID,
    );
    assert(`${connectorId}: dispatch ok`, result.ok, result.ok ? undefined : result.error);
    if (result.ok) {
      assert(`${connectorId}: 2 rows returned`, result.value.rows.length === 2, result.value.rows);
      const nameIdx = result.value.columns.findIndex((c) => c.name === "name");
      assert(
        `${connectorId}: row content matches seed`,
        JSON.stringify(result.value.rows.map((r) => r[nameIdx])) === JSON.stringify(["seed-1", "seed-2"]),
        result.value.rows,
      );
    }
    const auditAfter = await countAuditRows(connectionIds[connectorId]);
    assert(`${connectorId}: audit row written`, auditAfter === auditBefore + 1);
  }

  // --- success path: mongo ---
  {
    const auditBefore = await countAuditRows(connectionIds.mongodb);
    const result = await dispatch(
      connectionIds.mongodb,
      { kind: "mongo", collection: "sandbox_items", pipeline: [{ $sort: { _id: 1 } }] },
      scope,
      DEMO_USER_ID,
    );
    assert("mongodb: dispatch ok", result.ok, result.ok ? undefined : result.error);
    if (result.ok) {
      assert("mongodb: 2 rows returned", result.value.rows.length === 2, result.value.rows);
    }
    const auditAfter = await countAuditRows(connectionIds.mongodb);
    assert("mongodb: audit row written", auditAfter === auditBefore + 1);
  }

  // --- connection-not-found: random UUID, never audited (no row to attribute to) ---
  {
    const result = await dispatch(
      "00000000-0000-0000-0000-000000000000",
      { kind: "sql", sql: "SELECT 1", params: [] },
      scope,
      DEMO_USER_ID,
    );
    assert("missing connection: connection-not-found", !result.ok && result.error.kind === "connection-not-found", result);
  }

  // --- guardrail-rejected: mongo-shaped query against a mysql connection, IS audited ---
  {
    const auditBefore = await countAuditRows(connectionIds.mysql);
    const result = await dispatch(
      connectionIds.mysql,
      { kind: "mongo", collection: "sandbox_items", pipeline: [] },
      scope,
      DEMO_USER_ID,
    );
    assert("wrong-kind query: guardrail-rejected", !result.ok && result.error.kind === "guardrail-rejected", result);
    const auditAfter = await countAuditRows(connectionIds.mysql);
    assert("wrong-kind query: audit row written", auditAfter === auditBefore + 1);
  }

  log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
