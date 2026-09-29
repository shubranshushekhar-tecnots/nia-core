/**
 * One-command recovery for local dev data after a Postgres reset.
 *
 * Re-applying every migration plus supabase/seed.sql already creates the
 * demo user (demo@nia.dev / password) and the "Ice Cream Co" org (slug
 * icecream-co), plus the canvas-e2e/canvas-e2e-b orgs and canvas-e2e-c
 * personal workspace used by the canvas Playwright suite — see
 * supabase/seed.sql. What it does NOT do is install connectors or create
 * connections (those write a Vault-backed secret via nia_secrets, not plain
 * SQL, so they don't belong in a SQL seed file). This script does that
 * half: idempotently ensures a MySQL, a Mongo, and a Supabase(Postgres)
 * connection exist against docker-compose's sandbox DBs, pointed at both
 * the demo org and the canvas-e2e org (the latter gives canvas-e2e-a@nia.dev
 * real source nodes to drag onto the canvas, plus a real destination node
 * now that the supabase manifest declares "etl_sink" — Phase 5 Session 3),
 * so a fresh reset is fully recoverable with:
 *
 *   pnpm --filter @nia/worker bootstrap
 *
 * Reuses the exact seeding shape proven in scripts/chat-smoke.ts and
 * scripts/dispatch-smoke.ts (service-role, docker-compose service
 * names/internal ports in `config` since the connector SERVICE containers
 * dial that, not this script).
 *
 * Talks to Postgres directly via @nia/db's withServiceRole (RLS-bypassed,
 * same pattern as lib/secretStore.ts/resolveConnection.ts) — not
 * @supabase/supabase-js, since local dev no longer runs the Supabase CLI
 * (docs/plans/local-dev.md's "Supabase CLI -> plain Postgres" migration).
 *
 * Run with (from apps/worker/): npx tsx scripts/dev-bootstrap.ts
 * Needs apps/worker/.env: DATABASE_URL/REDIS_URL.
 */
import { withServiceRole } from "@nia/db";
import { getSecretStore } from "../src/lib/secretStore.js";
import { dbPool } from "../src/lib/dbPool.js";

// Fixture users now come from Better Auth's real signUpEmail path
// (pnpm --filter @nia/api seed:fixtures), which mints its own generated
// ids — the old fixed 00000000-...-000d1-style sentinel ids only worked
// back when these rows were inserted directly into auth.users by raw SQL.
// Looked up by email below (getUserId) instead of hardcoded.
const DEMO_USER_EMAIL = "demo@nia.dev";
const ORG_SLUG = "icecream-co";

// canvas-e2e-a@nia.dev — see supabase/seed.sql's "Canvas E2E fixtures" block.
const CANVAS_E2E_USER_EMAIL = "canvas-e2e-a@nia.dev";
const CANVAS_E2E_ORG_SLUG = "canvas-e2e";

// canvas-e2e-c@nia.dev — org-less personal workspace, same fixtures block.
const CANVAS_E2E_C_USER_EMAIL = "canvas-e2e-c@nia.dev";

// Dialed by the connector SERVICE containers, not this script — see
// dispatch-smoke.ts's header comment for the full host-vs-container rationale.
// supabase's sandbox config matches dispatch-smoke.ts's own SANDBOX entry
// exactly (same dev-postgres container, same nia_ro role from
// docker/dev-postgres-init.sql).
const SANDBOX = {
  mysql: { host: "dev-mysql", port: 3306, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
  mongodb: { host: "dev-mongo", port: 27017, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
  supabase: { host: "dev-postgres", port: 5432, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
} as const;

type ConnectorId = keyof typeof SANDBOX;
type Scope = { orgId: string; ownerId?: undefined } | { orgId?: undefined; ownerId: string };

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

async function getOrgId(slug: string): Promise<string> {
  const { rows } = await withServiceRole(dbPool, (db) =>
    db.query<{ id: string }>(`select id from public.organizations where slug = $1`, [slug]),
  );
  if (!rows[0]) {
    throw new Error(`Could not find seed.sql's org (slug=${slug}). Run the migrations + seed.sql first.`);
  }
  return rows[0].id;
}

async function getUserId(email: string): Promise<string> {
  const { rows } = await withServiceRole(dbPool, (db) =>
    db.query<{ id: string }>(`select id from public."user" where email = $1`, [email]),
  );
  if (!rows[0]) {
    throw new Error(
      `Could not find Better Auth user (email=${email}). Run \`pnpm --filter @nia/api seed:fixtures\` first.`,
    );
  }
  return rows[0].id;
}

// Same org_id/owner_id xor filter shape used everywhere else in this repo
// (resolveConnection.ts, connections service, RLS policies) — never both,
// never neither. The returned `column` is always one of these two literal
// names, never external input, so interpolating it into SQL text below is
// safe (no injection surface — it's not derived from `scope`'s values).
function scopeColumn(scope: Scope): { column: "org_id" | "owner_id"; value: string } {
  return scope.orgId !== undefined ? { column: "org_id", value: scope.orgId } : { column: "owner_id", value: scope.ownerId };
}

async function seedConnection(scope: Scope, connectorId: ConnectorId, installedByUserId: string): Promise<string> {
  const { host, port, database, user, password } = SANDBOX[connectorId];
  const { column, value } = scopeColumn(scope);
  const config = JSON.stringify({ host, port, database });

  const { rows: installRows } = await withServiceRole(dbPool, (db) =>
    db.query<{ count: string }>(
      `select count(*)::text as count from public.connector_installs where connector_id = $1 and ${column} = $2`,
      [connectorId, value],
    ),
  );
  if (Number(installRows[0]?.count ?? 0) === 0) {
    await withServiceRole(dbPool, (db) =>
      db.query(
        `insert into public.connector_installs (org_id, owner_id, connector_id, installed_by_user_id)
         values ($1, $2, $3, $4)`,
        [scope.orgId ?? null, scope.ownerId ?? null, connectorId, installedByUserId],
      ),
    );
  }

  const handle = `@${connectorId}-dev`;
  const { rows: existingRows } = await withServiceRole(dbPool, (db) =>
    db.query<{ id: string }>(`select id from public.connections where handle = $1 and ${column} = $2`, [handle, value]),
  );
  if (existingRows[0]) {
    await withServiceRole(dbPool, (db) =>
      db.query(`update public.connections set config = $1 where id = $2`, [config, existingRows[0].id]),
    );
    return existingRows[0].id;
  }

  const vaultRef = await getSecretStore(dbPool).put({ user, password }, scope);

  const { rows: insertedRows } = await withServiceRole(dbPool, (db) =>
    db.query<{ id: string }>(
      `insert into public.connections
         (org_id, owner_id, connector_id, handle, display_name, owner_user_id, config, vault_secret_ref)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id`,
      [
        scope.orgId ?? null,
        scope.ownerId ?? null,
        connectorId,
        handle,
        `Dev sandbox (${connectorId})`,
        installedByUserId,
        config,
        vaultRef,
      ],
    ),
  );
  return insertedRows[0].id;
}

async function main(): Promise<void> {
  const demoUserId = await getUserId(DEMO_USER_EMAIL);
  const orgId = await getOrgId(ORG_SLUG);
  log(`Demo org: ${ORG_SLUG} (${orgId})`);

  const connectionIds: Partial<Record<ConnectorId, string>> = {
    mysql: await seedConnection({ orgId }, "mysql", demoUserId),
    mongodb: await seedConnection({ orgId }, "mongodb", demoUserId),
  };
  log(`Connections ready: ${JSON.stringify(connectionIds, null, 2)}`);

  const canvasUserId = await getUserId(CANVAS_E2E_USER_EMAIL);
  const canvasOrgId = await getOrgId(CANVAS_E2E_ORG_SLUG);
  log(`Canvas E2E org: ${CANVAS_E2E_ORG_SLUG} (${canvasOrgId})`);

  // supabase added Session 3 (etl_sink amendment): canvas-e2e-a@nia.dev now
  // has a real destination node to drag onto the canvas, not just sources —
  // see canvas.spec.ts's "palette purity" describe block, which asserts on
  // this exact connection set, and mapping-smoke's mysql -> supabase pairing.
  const canvasConnectionIds: Record<ConnectorId, string> = {
    mysql: await seedConnection({ orgId: canvasOrgId }, "mysql", canvasUserId),
    mongodb: await seedConnection({ orgId: canvasOrgId }, "mongodb", canvasUserId),
    supabase: await seedConnection({ orgId: canvasOrgId }, "supabase", canvasUserId),
  };
  log(`Canvas E2E connections ready: ${JSON.stringify(canvasConnectionIds, null, 2)}`);

  // canvas-e2e-c: org-less personal workspace — one connection (mysql only,
  // enough for a real chat round-trip) owned via owner_id, not org_id.
  const canvasCUserId = await getUserId(CANVAS_E2E_C_USER_EMAIL);
  const canvasCConnectionId = await seedConnection({ ownerId: canvasCUserId }, "mysql", canvasCUserId);
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
