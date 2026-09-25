/**
 * Live smoke test for Task 3's proposal flow (proposeMapping.ts) against
 * real infrastructure AND a real model — NOT mocks. proposeMapping.test.ts
 * already proves the orchestration logic (hallucination filter, error
 * kinds, salvage-path parsing) against mocked resolveGraph/resolveConnection/
 * getSchema/gatewayClient; this script is the actual exit criterion: a real
 * mysql source and a real supabase (Postgres) destination, both introspected
 * for real, fed to the real LLM gateway, producing one real proposal.
 *
 * Run with (from apps/worker/):
 *   npx tsx scripts/mapping-smoke.ts
 * (reads apps/worker/.env via dotenv/config, same as env.ts — needs
 * SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/NIA_GATEWAY_API_KEY)
 *
 * Prerequisites (not started by this script — same as dispatch-smoke.ts/
 * chat-smoke.ts):
 *   - `supabase start`
 *   - `docker compose up -d --build dev-mysql dev-postgres connector-mysql
 *     connector-supabase`
 *
 * Reuses dispatch-smoke.ts's exact seeding conventions (service-role
 * Supabase client, docker-compose service names/internal ports for the
 * connection `config`). See that file's header comment for the full
 * host-vs-container-network rationale.
 *
 * The seeded mysql/postgres sandbox schemas (docker/dev-{mysql,postgres}
 * -init.sql) happen to share identical field names (sandbox_items.{id,name},
 * employees.{id,name,salary}) — there's no renamed-field fixture anywhere
 * else in the repo, and adding one would mean diverging the two DBs' seed
 * data just for this script. That's fine for this assertion: it doesn't
 * test the LLM's renaming judgment, only that a real end-to-end call
 * produces a parseable proposal with plausible (in this case: complete,
 * same-name) coverage. A prompt/dialect regression that produced garbage
 * fields or empty entries here would still fail loudly.
 */
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { GraphDoc } from "@nia/schemas";
import { proposeMapping } from "../src/lib/mappings/proposeMapping.js";
import { env } from "../src/env.js";
import { getSecretStore } from "../src/lib/secretStore.js";
import { dbPool } from "../src/lib/dbPool.js";

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DEMO_USER_ID = "00000000-0000-0000-0000-0000000000d1";
// Dialed by the connector SERVICE containers, not this script — see
// dispatch-smoke.ts's header comment for the full rationale.
const SANDBOX = {
  mysql: { host: "dev-mysql", port: 3306, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
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

  const handle = `@${connectorId}-mapping-smoke`;
  const { data: existing } = await supabase
    .from("connections")
    .select("id")
    .eq("org_id", orgId)
    .eq("handle", handle)
    .maybeSingle();
  if (existing) {
    const { error } = await supabase
      .from("connections")
      .update({ config: { host, port, database } })
      .eq("id", existing.id as string);
    if (error) throw new Error(`connection config update for ${connectorId} failed: ${error.message}`);
    return existing.id as string;
  }

  let vaultRef: string;
  try {
    vaultRef = await getSecretStore(dbPool).put({ user, password }, { orgId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`secret write for ${connectorId} failed: ${message}`);
  }

  const { data, error } = await supabase
    .from("connections")
    .insert({
      org_id: orgId,
      owner_id: null,
      connector_id: connectorId,
      handle,
      display_name: `Mapping smoke (${connectorId})`,
      owner_user_id: DEMO_USER_ID,
      config: { host, port, database },
      vault_secret_ref: vaultRef as string,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`connection insert for ${connectorId} failed: ${error?.message}`);
  return data.id as string;
}

/** Finds or creates a dedicated project + workflow for this script, with a source(mysql)->destination(supabase) graph. */
async function seedWorkflow(orgId: string, sourceConnectionId: string, destConnectionId: string): Promise<string> {
  const { data: existingProject } = await supabase
    .from("projects")
    .select("id")
    .eq("org_id", orgId)
    .eq("name", "Mapping Smoke")
    .maybeSingle();
  const projectId =
    (existingProject?.id as string | undefined) ??
    (
      await supabase
        .from("projects")
        .insert({ org_id: orgId, name: "Mapping Smoke", created_by: DEMO_USER_ID })
        .select("id")
        .single()
    ).data?.id;
  if (!projectId) throw new Error("Could not find or create the Mapping Smoke project.");

  const { data: existingWorkflow } = await supabase
    .from("workflows")
    .select("id")
    .eq("project_id", projectId)
    .eq("name", "mysql -> supabase mapping smoke")
    .maybeSingle();
  const workflowId =
    (existingWorkflow?.id as string | undefined) ??
    (
      await supabase
        .from("workflows")
        .insert({ project_id: projectId, org_id: orgId, name: "mysql -> supabase mapping smoke", created_by: DEMO_USER_ID })
        .select("id")
        .single()
    ).data?.id;
  if (!workflowId) throw new Error("Could not find or create the mapping smoke workflow.");

  const graph: GraphDoc = {
    nodes: [
      {
        id: "src",
        type: "source",
        manifestId: "mysql",
        connectionId: sourceConnectionId,
        position: { x: 0, y: 0 },
        config: { operation: "read" },
      },
      {
        id: "dest",
        type: "destination",
        manifestId: "supabase",
        connectionId: destConnectionId,
        position: { x: 200, y: 0 },
        config: { operation: "read" },
      },
    ],
    edges: [{ id: "e1", source: "src", target: "dest" }],
  };

  const { error } = await supabase.from("workflow_graphs").upsert({ workflow_id: workflowId, graph });
  if (error) throw new Error(`workflow_graphs upsert failed: ${error.message}`);

  return workflowId as string;
}

async function main(): Promise<void> {
  log("=== SEEDING (not part of the proposal proof below) ===");
  const orgId = await getOrgId();
  const sourceConnectionId = await seedConnection(orgId, "mysql");
  const destConnectionId = await seedConnection(orgId, "supabase");
  const workflowId = await seedWorkflow(orgId, sourceConnectionId, destConnectionId);
  log(`Seeded workflow ${workflowId} (source ${sourceConnectionId} -> dest ${destConnectionId})`);

  log("\n=== ASSERTIONS: proposeMapping() against real infra + real model ===");
  let failures = 0;
  function assert(label: string, cond: boolean, detail?: unknown): void {
    if (cond) {
      log(`  PASS  ${label}`);
    } else {
      failures++;
      log(`  FAIL  ${label} ${detail !== undefined ? JSON.stringify(detail) : ""}`);
    }
  }

  const result = await proposeMapping(workflowId, "dest", { orgId });

  assert("proposal succeeded", result.ok, result.ok ? undefined : result.error);
  if (result.ok) {
    const { entries } = result.value;
    assert("proposal is parseable and non-empty", Array.isArray(entries) && entries.length > 0, entries);

    // Destination schema (employees ∪ sandbox_items) has 5 unique fields:
    // id, name, salary (employees), id, name (sandbox_items) -> {id, name, salary}.
    const destFieldCount = 3;
    const mappedDestFields = new Set(entries.map((e) => e.to));
    assert(
      `proposal covers at least half the destination's fields (${mappedDestFields.size}/${destFieldCount})`,
      mappedDestFields.size >= Math.ceil(destFieldCount / 2),
      entries,
    );
    assert(
      "proposal maps the identically-named id/name/salary fields plausibly (from === to for every entry, since both sides share field names)",
      entries.every((e) => e.from === e.to),
      entries,
    );
  }

  log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
