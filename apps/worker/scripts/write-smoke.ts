/**
 * Live smoke test for the Block 2 write path (apps/worker/src/lib/
 * writeDispatch.ts -> connector-supabase's POST /write) against real
 * infrastructure — NOT mocks. Route-level mocks (index.test.ts's /write
 * suite, writeDispatch.test.ts, resolveWriteGrant.test.ts) already prove
 * the logic in isolation; this script proves the wiring end-to-end: real
 * Postgres (local `supabase start`) for the grant lifecycle, a real
 * connector-supabase container for the HTTP hop + guardrail re-check, and
 * a real docker-compose sandbox Postgres (dev-postgres) as the write
 * target — writes 3 rows to a scratch table, verifies them via a direct
 * connection, then cleans up.
 *
 * Run with (from apps/worker/):
 *   npx tsx scripts/write-smoke.ts
 * (reads apps/worker/.env for SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/
 * WRITE_DISPATCH_SIGNING_SECRET via dotenv/config, same as env.ts)
 *
 * Prerequisites (not started by this script):
 *   - `supabase start`
 *   - `redis`/`dev-postgres`/`connector-supabase` are rebuilt+started
 *     automatically by `pnpm run smoke:write`'s `presmoke:write` step
 *     (`docker compose up -d --build ...`) — always a fresh connector
 *     image, never a stale one silently serving old signature-verification
 *     logic (see docs/decisions.md's Phase 11 "stale image" lesson).
 *   - apps/web/.env.local (or supabase status) for SUPABASE_ANON_KEY, used
 *     here to sign in as seed.sql's demo user (demo@nia.dev/password) —
 *     create_write_grant/confirm_write_grant/revoke_write_grant are
 *     SECURITY DEFINER and re-derive auth.uid() themselves, so they must
 *     be called through a real user JWT, never the service-role client.
 *
 * This script runs on the HOST, so it reaches dev-postgres via its
 * host-published port (5433) both as the postgres superuser (to
 * provision a scratch write role/table) and to verify the written rows.
 * The connector-supabase CONTAINER reaches the same database via the
 * docker-compose service name (dev-postgres:5432) — see
 * dispatch-smoke.ts's header comment for the same duality applied to the
 * read path.
 */
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { dispatchWrite } from "../src/lib/writeDispatch.js";
import type { WorkspaceScope } from "../src/lib/workspaceScope.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY must be set (see this script's header comment).");
if (!ANON_KEY) throw new Error("SUPABASE_ANON_KEY must be set (see this script's header comment, e.g. copy from apps/web/.env.local).");

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DEMO_USER_ID = "00000000-0000-0000-0000-0000000000d1";
const DEMO_EMAIL = "demo@nia.dev";
const DEMO_PASSWORD = "password";

// Dialed by the connector-supabase CONTAINER, over the compose network.
const WRITE_TARGET_CONFIG = { host: "dev-postgres", port: 5432, database: "sandbox" };
// Dialed by THIS script, from the host, for provisioning + verification.
const HOST_PG = { host: "localhost", port: 5433, database: "sandbox", user: "postgres", password: "devroot" };

const SCRATCH_TABLE = "write_smoke_scratch";
const WRITE_ROLE_USER = "nia_write_smoke";
const WRITE_ROLE_PASSWORD = "nia_write_smoke_pw";

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

function assert(label: string, cond: boolean, detail?: unknown): boolean {
  if (cond) {
    log(`  PASS  ${label}`);
  } else {
    log(`  FAIL  ${label} ${detail !== undefined ? JSON.stringify(detail) : ""}`);
  }
  return cond;
}

async function provisionScratchTableAndRole(): Promise<void> {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  try {
    await client.query(`drop table if exists ${SCRATCH_TABLE}`);
    await client.query(`create table ${SCRATCH_TABLE} (id int primary key, note text not null)`);
    const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [WRITE_ROLE_USER]);
    if (!rowCount) {
      await client.query(`create role ${WRITE_ROLE_USER} with login password '${WRITE_ROLE_PASSWORD}'`);
    }
    await client.query(`grant connect on database sandbox to ${WRITE_ROLE_USER}`);
    await client.query(`grant usage on schema public to ${WRITE_ROLE_USER}`);
    await client.query(`grant select, insert, update on ${SCRATCH_TABLE} to ${WRITE_ROLE_USER}`);
  } finally {
    await client.end();
  }
}

async function readScratchRows(): Promise<Array<{ id: number; note: string }>> {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  try {
    const { rows } = await client.query(`select id, note from ${SCRATCH_TABLE} order by id`);
    return rows as Array<{ id: number; note: string }>;
  } finally {
    await client.end();
  }
}

async function cleanupScratchTableAndRole(): Promise<void> {
  const client = new pg.Client(HOST_PG);
  await client.connect();
  try {
    await client.query(`drop table if exists ${SCRATCH_TABLE}`);
    const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [WRITE_ROLE_USER]);
    if (rowCount) {
      await client.query(`drop owned by ${WRITE_ROLE_USER}`);
      await client.query(`drop role if exists ${WRITE_ROLE_USER}`);
    }
  } finally {
    await client.end();
  }
}

async function getOrgId(): Promise<string> {
  const { data, error } = await supabaseAdmin.from("organizations").select("id").eq("slug", "icecream-co").single();
  if (error || !data) throw new Error(`Could not find seed.sql's demo org: ${error?.message}`);
  return data.id as string;
}

async function seedWriteSmokeConnection(orgId: string): Promise<string> {
  const { count: installCount } = await supabaseAdmin
    .from("connector_installs")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("connector_id", "supabase");
  if (!installCount) {
    const { error } = await supabaseAdmin
      .from("connector_installs")
      .insert({ org_id: orgId, connector_id: "supabase", installed_by_user_id: DEMO_USER_ID });
    if (error) throw new Error(`install supabase failed: ${error.message}`);
  }

  const handle = "@supabase-write-smoke";
  const { data: existing } = await supabaseAdmin
    .from("connections")
    .select("id")
    .eq("org_id", orgId)
    .eq("handle", handle)
    .maybeSingle();
  if (existing) return existing.id as string;

  const { data: vaultRef, error: vaultError } = await supabaseAdmin.rpc("create_connector_secret", {
    p_secret: { user: "nia_ro", password: "nia_ro_pw" },
  });
  if (vaultError || !vaultRef) throw new Error(`vault write for read cred failed: ${vaultError?.message}`);

  const { data, error } = await supabaseAdmin
    .from("connections")
    .insert({
      org_id: orgId,
      owner_id: null,
      connector_id: "supabase",
      handle,
      display_name: "Write smoke (supabase)",
      owner_user_id: DEMO_USER_ID,
      config: WRITE_TARGET_CONFIG,
      vault_secret_ref: vaultRef as string,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`connection insert failed: ${error?.message}`);
  return data.id as string;
}

async function countAuditRows(connectionId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("detail->>connectionId", connectionId);
  return count ?? 0;
}

async function main(): Promise<void> {
  let failures = 0;
  const track = (ok: boolean) => {
    if (!ok) failures++;
  };

  log("=== SEEDING (not part of the write-path proof below) ===");
  await provisionScratchTableAndRole();
  const orgId = await getOrgId();
  const scope: WorkspaceScope = { orgId };
  const connectionId = await seedWriteSmokeConnection(orgId);
  log(`Seeded connection: ${connectionId}`);

  const writeVaultRef = await (async () => {
    const { data, error } = await supabaseAdmin.rpc("create_connector_secret", {
      p_secret: { user: WRITE_ROLE_USER, password: WRITE_ROLE_PASSWORD },
    });
    if (error || !data) throw new Error(`vault write for write cred failed: ${error?.message}`);
    return data as string;
  })();

  // create_write_grant/confirm_write_grant/revoke_write_grant are SECURITY
  // DEFINER and derive their actor from auth.uid() — must go through a real
  // user JWT, not the service-role client.
  const supabaseUser = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await supabaseUser.auth.signInWithPassword({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
  if (signInError) throw new Error(`sign-in as demo user failed: ${signInError.message}`);

  const { data: grantRow, error: grantError } = await supabaseUser.rpc("create_write_grant", {
    p_connection_id: connectionId,
    p_scope: { schemas: ["public"] },
  });
  if (grantError || !grantRow) throw new Error(`create_write_grant failed: ${grantError?.message}`);
  const grantId = (grantRow as { id: string }).id;
  log(`Created write grant: ${grantId}`);

  const { error: confirmError } = await supabaseUser.rpc("confirm_write_grant", {
    p_grant_id: grantId,
    p_write_credential_vault_ref: writeVaultRef,
  });
  if (confirmError) throw new Error(`confirm_write_grant failed: ${confirmError.message}`);
  log("Confirmed write grant.");

  log("\n=== ASSERTIONS: dispatchWrite() against real infra ===");

  // --- success path: write 3 rows via the full worker -> connector -> dev-postgres path ---
  {
    const auditBefore = await countAuditRows(connectionId);
    const result = await dispatchWrite(
      connectionId,
      {
        entity: { namespace: "public", name: SCRATCH_TABLE },
        columns: ["id", "note"],
        rows: [
          [1, "alpha"],
          [2, "beta"],
          [3, "gamma"],
        ],
        upsertKeys: ["id"],
      },
      scope,
      DEMO_USER_ID,
    );
    track(assert("dispatchWrite ok", result.ok, result.ok ? undefined : result.error));
    if (result.ok) {
      track(assert("dispatchWrite reports written: 3", result.value.written === 3, result.value));
    }

    const rows = await readScratchRows();
    track(assert("3 rows actually landed in dev-postgres", rows.length === 3, rows));
    track(
      assert(
        "row content matches what was written",
        JSON.stringify(rows) === JSON.stringify([
          { id: 1, note: "alpha" },
          { id: 2, note: "beta" },
          { id: 3, note: "gamma" },
        ]),
        rows,
      ),
    );

    const auditAfter = await countAuditRows(connectionId);
    track(assert("audit row written", auditAfter === auditBefore + 1));
  }

  // --- upsert path: re-write id=1 with new content, plus a new row 4 ---
  {
    const result = await dispatchWrite(
      connectionId,
      {
        entity: { namespace: "public", name: SCRATCH_TABLE },
        columns: ["id", "note"],
        rows: [
          [1, "alpha-updated"],
          [4, "delta"],
        ],
        upsertKeys: ["id"],
      },
      scope,
      DEMO_USER_ID,
    );
    track(assert("upsert dispatchWrite ok", result.ok, result.ok ? undefined : result.error));
    const rows = await readScratchRows();
    track(assert("upsert updated id=1 and inserted id=4 (4 rows total)", rows.length === 4, rows));
    track(assert("id=1 note was updated", rows.find((r) => r.id === 1)?.note === "alpha-updated", rows));
  }

  // --- guardrail: revoke the grant, then confirm the write path is blocked ---
  {
    const { error: revokeError } = await supabaseUser.rpc("revoke_write_grant", { p_grant_id: grantId });
    if (revokeError) throw new Error(`revoke_write_grant failed: ${revokeError.message}`);
    log("Revoked write grant.");

    const result = await dispatchWrite(
      connectionId,
      {
        entity: { namespace: "public", name: SCRATCH_TABLE },
        columns: ["id", "note"],
        rows: [[5, "epsilon"]],
        upsertKeys: ["id"],
      },
      scope,
      DEMO_USER_ID,
    );
    track(assert("write after revoke: grant-invalid", !result.ok && result.error.kind === "grant-invalid", result));
    const rows = await readScratchRows();
    track(assert("no row 5 was written after revoke", !rows.some((r) => r.id === 5), rows));
  }

  log("\n=== CLEANUP ===");
  await cleanupScratchTableAndRole();
  log("Dropped scratch table + write role.");

  log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await cleanupScratchTableAndRole();
  } catch {
    // best-effort cleanup on failure
  }
  process.exit(1);
});
