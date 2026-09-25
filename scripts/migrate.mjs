#!/usr/bin/env node
// Migration runner. Shared verbatim by the root package.json scripts
// (migrate:status/push/verify/resolve), supabase/migrate.Dockerfile's
// ENTRYPOINT (manual/CI use), and apps/api/docker-entrypoint.sh (runs
// `push` automatically at container start) — one implementation instead
// of several that can drift.
//
// Replaces the Supabase CLI (`supabase migration list`/`supabase db push`)
// with a plain `pg` client, per docs/plans/local-dev.md — the whole point
// of this step is getting local dev and migrations off that CLI. Applies
// supabase/migrations/*.sql as-is, in filename order, tracked in a small
// `public._migrations` table this script owns (version, name, checksum,
// started_at, finished_at, error, rolled_back_at). No third-party
// migration framework: every off-the-shelf option (node-pg-migrate,
// dbmate, etc.) expects its own file-naming/up-down convention, and the
// plan requires importing the existing migrations unmodified.
//
// Migration compatibility rule (see DEPLOYMENT.md): every migration must
// work with both the old and new app code running against it at the same
// time, since both do during a deploy. Add a column as nullable, deploy,
// backfill, tighten later; never drop or rename a column the current code
// still uses.
//
// `push` takes a Postgres session-level advisory lock for the run, so
// concurrent starts (e.g. multiple apps/api replicas booting at once)
// serialize instead of racing each other's DDL. That requires a direct
// session connection — DATABASE_URL is rejected up front if it looks like
// a transaction pooler (e.g. PgBouncer in transaction mode), since a
// pooled connection can't reliably hold a session lock or run
// multi-statement DDL as one session.
//
// A migration's tracking row is inserted (started_at) before it runs and
// completed (finished_at) after it commits, as separate statements outside
// the migration's own transaction — so a row that crashed mid-migration is
// left with finished_at still null and, if the failure was caught, its
// error recorded. The next `push` refuses to proceed past that row until
// an operator investigates and runs `resolve <version>`, which marks it
// rolled back (Postgres itself already rolled back the migration's own
// DDL transaction — resolving here just clears the block so the next push
// retries that version, presumably from a fixed file).

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");

// Fixed, arbitrary constant scoping this app's migration advisory lock —
// any value works as long as it's stable across every process that calls
// push() for this database.
const ADVISORY_LOCK_KEY = 8_214_772_931;

function loadMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
      return {
        version: name.split("_")[0],
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    });
}

/**
 * Throws if databaseUrl looks like a transaction-mode pooler connection.
 *
 * Port is the discriminator here, not hostname. On Supabase, session mode
 * and transaction mode are the exact same Supavisor host — the only
 * difference is port 5432 (session) vs 6543 (transaction) — so a hostname
 * check (e.g. matching "pooler") blocks both modes indiscriminately, even
 * though session mode dedicates one backend connection to the client for
 * the whole session (same session-level guarantees as a direct connection:
 * an advisory lock taken on one statement is still held on the next, a
 * temp table created in one statement is still visible in the next) and
 * transaction mode does not (a different backend can service each
 * transaction, silently dropping session-level advisory locks and
 * temp tables). Verified live against Supabase's Supavisor: an advisory
 * lock taken, then a temp table created/committed/read/dropped, then the
 * lock released — all as separate statements over one session-mode
 * connection — see one backend pid throughout and the lock still held
 * after the DDL.
 *
 * This also means a hostname check is the wrong idea on a non-Supabase
 * host: Azure Database for PostgreSQL's hostname carries no "pooler"
 * marker at all, so a hostname-based check would silently do nothing
 * there even if a transaction-mode PgBouncer/pgpool sat in front of it.
 * Port 6543 is Supavisor/PgBouncer's transaction-mode convention, not a
 * hard guarantee — if a different setup puts a transaction-mode pooler on
 * another port, this check can't see it — but it is the correct, portable
 * signal for the poolers this codebase actually targets, and never
 * misfires against a legitimate direct or session-mode host.
 */
export function assertDirectConnection(databaseUrl) {
  const url = new URL(databaseUrl);
  if (url.port === "6543") {
    throw new Error(
      `DATABASE_URL looks like a transaction-pooler connection (host=${url.hostname}, port=${url.port}) — ` +
        "migrate.mjs needs a direct or session-mode connection to hold an advisory lock and run multi-statement DDL. " +
        "Use the database's direct connection string, or a session-mode pooler port (e.g. Supabase Supavisor's 5432) instead.",
    );
  }
}

async function ensureTrackingTable(client) {
  await client.query(`
    create table if not exists public._migrations (
      version text primary key,
      name text not null,
      checksum text not null,
      started_at timestamptz not null default now(),
      finished_at timestamptz,
      error text,
      rolled_back_at timestamptz
    )
  `);

  // Self-upgrade a pre-existing old-shape table (version, name, checksum,
  // applied_at) to the new shape, so both a fresh table and one already
  // populated under the old single-column model converge with no manual
  // step. Every pre-existing row was applied successfully under the old
  // model, so it backfills as already-finished.
  await client.query(`alter table public._migrations add column if not exists started_at timestamptz`);
  await client.query(`alter table public._migrations add column if not exists finished_at timestamptz`);
  await client.query(`alter table public._migrations add column if not exists error text`);
  await client.query(`alter table public._migrations add column if not exists rolled_back_at timestamptz`);

  const { rows } = await client.query(`
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = '_migrations' and column_name = 'applied_at'
  `);
  if (rows.length > 0) {
    await client.query(`
      update public._migrations
      set started_at = coalesce(started_at, applied_at), finished_at = coalesce(finished_at, applied_at)
      where finished_at is null
    `);
    await client.query(`alter table public._migrations drop column applied_at`);
  }

  await client.query(`update public._migrations set started_at = now() where started_at is null`);
  await client.query(`alter table public._migrations alter column started_at set not null`);
  await client.query(`alter table public._migrations alter column started_at set default now()`);
}

/** Genuinely applied rows only: finished, and never rolled back. */
async function loadApplied(client) {
  const { rows } = await client.query(`
    select version, name, checksum, started_at, finished_at
    from public._migrations
    where finished_at is not null and rolled_back_at is null
  `);
  return new Map(rows.map((row) => [row.version, row]));
}

/** The oldest unresolved failed/unfinished row, if any. */
async function loadUnresolvedFailure(client) {
  const { rows } = await client.query(`
    select version, name, error, started_at
    from public._migrations
    where finished_at is null and rolled_back_at is null
    order by started_at asc
    limit 1
  `);
  return rows[0] ?? null;
}

/** Already-applied migrations whose file content no longer matches what ran. */
export function findDrift(migrations, applied) {
  const drifted = [];
  for (const migration of migrations) {
    const record = applied.get(migration.version);
    if (record && record.checksum !== migration.checksum) {
      drifted.push(migration.name);
    }
  }
  return drifted;
}

async function withClient(fn) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required (direct Postgres connection string)");
  }
  assertDirectConnection(databaseUrl);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function status() {
  await withClient(async (client) => {
    await ensureTrackingTable(client);
    const migrations = loadMigrations();
    const { rows } = await client.query(`
      select version, name, checksum, started_at, finished_at, error, rolled_back_at
      from public._migrations
    `);
    const records = new Map(rows.map((row) => [row.version, row]));

    for (const migration of migrations) {
      const record = records.get(migration.version);
      if (!record || record.rolled_back_at) {
        console.log(`pending  ${migration.name}`);
        continue;
      }
      if (!record.finished_at) {
        const detail = record.error ? ` — ${record.error}` : "";
        console.log(`FAILED   ${migration.name}  started ${record.started_at.toISOString()}${detail}`);
        continue;
      }
      const drift = record.checksum !== migration.checksum ? " (MODIFIED SINCE APPLIED)" : "";
      console.log(`applied  ${migration.name}  ${record.finished_at.toISOString()}${drift}`);
    }
  });
}

async function push() {
  await withClient(async (client) => {
    await client.query("select pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    try {
      await ensureTrackingTable(client);
      const migrations = loadMigrations();
      const applied = await loadApplied(client);

      const drifted = findDrift(migrations, applied);
      if (drifted.length > 0) {
        throw new Error(`refusing to push — already-applied migration(s) were modified: ${drifted.join(", ")}`);
      }

      const unresolved = await loadUnresolvedFailure(client);
      if (unresolved) {
        const detail = unresolved.error ? ` — recorded error: ${unresolved.error}` : "";
        throw new Error(
          `migration ${unresolved.name} did not finish (started ${unresolved.started_at.toISOString()})${detail}. ` +
            `Investigate, then run: node scripts/migrate.mjs resolve ${unresolved.version}`,
        );
      }

      const pending = migrations.filter((m) => !applied.has(m.version));
      if (pending.length === 0) {
        console.log("OK: no pending migrations.");
        return;
      }

      for (const migration of pending) {
        console.log(`applying ${migration.name} ...`);
        // Upsert, not a plain insert: a version being retried after `resolve`
        // still has a row (rolled_back_at set, same primary key) — this
        // resets it for the fresh attempt instead of colliding on insert.
        await client.query(
          `insert into public._migrations (version, name, checksum, started_at)
           values ($1, $2, $3, now())
           on conflict (version) do update set
             name = excluded.name,
             checksum = excluded.checksum,
             started_at = now(),
             finished_at = null,
             error = null,
             rolled_back_at = null`,
          [migration.version, migration.name, migration.checksum],
        );
        try {
          await client.query("begin");
          await client.query(migration.sql);
          await client.query("commit");
        } catch (err) {
          await client.query("rollback");
          const message = err instanceof Error ? err.message : String(err);
          await client.query("update public._migrations set error = $2 where version = $1", [migration.version, message]);
          throw new Error(
            `migration ${migration.name} failed: ${message}. Fix the issue, then run: node scripts/migrate.mjs resolve ${migration.version}`,
          );
        }
        await client.query("update public._migrations set finished_at = now() where version = $1", [migration.version]);
        console.log(`applied  ${migration.name}`);
      }
    } finally {
      await client.query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    }
  });
}

async function verify() {
  await withClient(async (client) => {
    await ensureTrackingTable(client);
    const migrations = loadMigrations();
    const applied = await loadApplied(client);

    const drifted = findDrift(migrations, applied);
    if (drifted.length > 0) {
      console.error("ERROR: already-applied migration(s) were modified — migrations are forward-only/additive, add a new one instead:");
      for (const name of drifted) console.error(`  ${name}`);
      process.exit(1);
    }
    console.log("OK: no already-applied migrations were modified.");
  });
}

/** Marks an unresolved failed row as rolled back, unblocking the next push. */
async function resolve(version) {
  if (!version) {
    throw new Error("Usage: migrate.mjs resolve <version>");
  }
  await withClient(async (client) => {
    await ensureTrackingTable(client);
    const { rows } = await client.query(
      `select version, name, error, started_at from public._migrations
       where version = $1 and finished_at is null and rolled_back_at is null`,
      [version],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`no unresolved failed migration found for version ${version}`);
    }
    console.log(`resolving ${row.name} (started ${row.started_at.toISOString()})`);
    if (row.error) console.log(`  recorded error: ${row.error}`);
    await client.query("update public._migrations set rolled_back_at = now() where version = $1", [version]);
    console.log(`OK: ${row.name} marked as rolled back — the next push will retry it.`);
  });
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  const cmd = process.argv[2];
  const arg = process.argv[3];
  const handlers = { status, push, verify, resolve: () => resolve(arg) };
  const handler = handlers[cmd];
  if (!handler) {
    console.error("Usage: migrate.mjs {status|push|verify|resolve <version>}");
    process.exit(1);
  }
  handler().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
