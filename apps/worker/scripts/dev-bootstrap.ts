/**
 * One-command recovery for local dev data after `supabase db reset`.
 *
 * `supabase db reset` re-applies every migration plus supabase/seed.sql,
 * which already creates the demo user (demo@nia.dev / password) and the
 * "Ice Cream Co" org (slug icecream-co), plus the canvas-e2e/canvas-e2e-b
 * orgs and canvas-e2e-c personal workspace used by the canvas Playwright
 * suite — see supabase/seed.sql. What it does NOT do is install connectors
 * or create connections (those write to Vault via an RPC, not plain SQL,
 * so they don't belong in a SQL seed file). This script does that half:
 * idempotently ensures a MySQL and a Mongo connection exist against
 * docker-compose's sandbox DBs, pointed at both the demo org and the
 * canvas-e2e org (the latter gives canvas-e2e-a@nia.dev real source nodes
 * to drag onto the canvas), so a fresh `supabase db reset` is fully
 * recoverable with:
 *
 *   supabase db reset
 *   pnpm --filter @nia/worker bootstrap
 *
 * Reuses the exact seeding shape proven in scripts/chat-smoke.ts and
 * scripts/dispatch-smoke.ts (service-role client, docker-compose service
 * names/internal ports in `config` since the connector SERVICE containers
 * dial that, not this script).
 *
 * Run with (from apps/worker/): npx tsx scripts/dev-bootstrap.ts
 * Needs apps/worker/.env: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/REDIS_URL.
 */
import { createClient } from "@supabase/supabase-js";
import { env } from "../src/env.js";

if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(env.SUPABASE_URL)) {
  throw new Error(
    `Refusing to run: SUPABASE_URL (${env.SUPABASE_URL}) doesn't look like local Supabase. ` +
      "This script seeds throwaway dev data and must never run against a remote project.",
  );
}

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DEMO_USER_ID = "00000000-0000-0000-0000-0000000000d1";
const ORG_SLUG = "icecream-co";

// canvas-e2e-a@nia.dev — see supabase/seed.sql's "Canvas E2E fixtures" block.
const CANVAS_E2E_USER_ID = "00000000-0000-0000-0000-0000000000e1";
const CANVAS_E2E_ORG_SLUG = "canvas-e2e";

// canvas-e2e-c@nia.dev — org-less personal workspace, same fixtures block.
const CANVAS_E2E_C_USER_ID = "00000000-0000-0000-0000-0000000000e3";

// Dialed by the connector SERVICE containers, not this script — see
// dispatch-smoke.ts's header comment for the full host-vs-container rationale.
const SANDBOX = {
  mysql: { host: "dev-mysql", port: 3306, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
  mongodb: { host: "dev-mongo", port: 27017, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
} as const;

type ConnectorId = keyof typeof SANDBOX;
type Scope = { orgId: string; ownerId?: undefined } | { orgId?: undefined; ownerId: string };

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

async function getOrgId(slug: string): Promise<string> {
  const { data, error } = await supabase.from("organizations").select("id").eq("slug", slug).single();
  if (error || !data) {
    throw new Error(
      `Could not find seed.sql's org (slug=${slug}). Run \`supabase db reset\` first. (${error?.message})`,
    );
  }
  return data.id as string;
}

async function seedConnection(scope: Scope, connectorId: ConnectorId, installedByUserId: string): Promise<string> {
  const { host, port, database, user, password } = SANDBOX[connectorId];
  // Same org_id/owner_id xor filter shape used everywhere else in this repo
  // (resolveConnection.ts, connections service, RLS policies) — never both,
  // never neither.
  const scopeCols = scope.orgId !== undefined ? { org_id: scope.orgId, owner_id: null } : { org_id: null, owner_id: scope.ownerId };

  let installQuery = supabase
    .from("connector_installs")
    .select("id", { count: "exact", head: true })
    .eq("connector_id", connectorId);
  installQuery =
    scope.orgId !== undefined ? installQuery.eq("org_id", scope.orgId) : installQuery.eq("owner_id", scope.ownerId);
  const { count: installCount } = await installQuery;
  if (!installCount) {
    const { error } = await supabase
      .from("connector_installs")
      .insert({ ...scopeCols, connector_id: connectorId, installed_by_user_id: installedByUserId });
    if (error) throw new Error(`install ${connectorId} failed: ${error.message}`);
  }

  const handle = `@${connectorId}-dev`;
  let existingQuery = supabase.from("connections").select("id").eq("handle", handle);
  existingQuery =
    scope.orgId !== undefined ? existingQuery.eq("org_id", scope.orgId) : existingQuery.eq("owner_id", scope.ownerId);
  const { data: existing } = await existingQuery.maybeSingle();
  if (existing) {
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
      ...scopeCols,
      connector_id: connectorId,
      handle,
      display_name: `Dev sandbox (${connectorId})`,
      owner_user_id: installedByUserId,
      config: { host, port, database },
      vault_secret_ref: vaultRef as string,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`connection insert for ${connectorId} failed: ${error?.message}`);
  return data.id as string;
}

async function main(): Promise<void> {
  const orgId = await getOrgId(ORG_SLUG);
  log(`Demo org: ${ORG_SLUG} (${orgId})`);

  const connectionIds: Record<ConnectorId, string> = {
    mysql: await seedConnection({ orgId }, "mysql", DEMO_USER_ID),
    mongodb: await seedConnection({ orgId }, "mongodb", DEMO_USER_ID),
  };
  log(`Connections ready: ${JSON.stringify(connectionIds, null, 2)}`);

  const canvasOrgId = await getOrgId(CANVAS_E2E_ORG_SLUG);
  log(`Canvas E2E org: ${CANVAS_E2E_ORG_SLUG} (${canvasOrgId})`);

  const canvasConnectionIds: Record<ConnectorId, string> = {
    mysql: await seedConnection({ orgId: canvasOrgId }, "mysql", CANVAS_E2E_USER_ID),
    mongodb: await seedConnection({ orgId: canvasOrgId }, "mongodb", CANVAS_E2E_USER_ID),
  };
  log(`Canvas E2E connections ready: ${JSON.stringify(canvasConnectionIds, null, 2)}`);

  // canvas-e2e-c: org-less personal workspace — one connection (mysql only,
  // enough for a real chat round-trip) owned via owner_id, not org_id.
  const canvasCConnectionId = await seedConnection({ ownerId: CANVAS_E2E_C_USER_ID }, "mysql", CANVAS_E2E_C_USER_ID);
  log(`Canvas E2E personal connection ready: ${canvasCConnectionId}`);

  log("Sign in as demo@nia.dev / password to use them.");
  log("Sign in as canvas-e2e-a@nia.dev / password for the canvas E2E fixtures (member of canvas-e2e org).");
  log("Also seeded: canvas-e2e-b@nia.dev / password (other org, cross-org negative fixture)");
  log("        and: canvas-e2e-c@nia.dev / password (personal/individual workspace, no org).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
