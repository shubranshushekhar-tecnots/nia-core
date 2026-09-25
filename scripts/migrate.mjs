#!/usr/bin/env node
// One-off migration runner — a release step, never invoked at service
// startup (no service Dockerfile/CMD calls this). Shared verbatim by the
// root package.json scripts (migrate:status/push/verify) and by
// supabase/migrate.Dockerfile's ENTRYPOINT, so there's one implementation
// instead of two that can drift.
//
// Replaces the Supabase CLI (`supabase migration list`/`supabase db push`)
// with a plain `pg` client, per docs/plans/local-dev.md — the whole point
// of this step is getting local dev and migrations off that CLI. Applies
// supabase/migrations/*.sql as-is, in filename order, tracked in a small
// `public._migrations` table this script owns (version, name, checksum,
// applied_at). No third-party migration framework: every off-the-shelf
// option (node-pg-migrate, dbmate, etc.) expects its own file-naming/
// up-down convention, and the plan requires importing the existing
// migrations unmodified.
//
// Migration compatibility rule (see DEPLOYMENT.md): every migration must
// work with both the old and new app code running against it at the same
// time, since both do during a deploy. Add a column as nullable, deploy,
// backfill, tighten later; never drop or rename a column the current code
// still uses.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");

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

async function ensureTrackingTable(client) {
  await client.query(`
    create table if not exists public._migrations (
      version text primary key,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function loadApplied(client) {
  const { rows } = await client.query("select version, name, checksum, applied_at from public._migrations");
  return new Map(rows.map((row) => [row.version, row]));
}

/** Already-applied migrations whose file content no longer matches what ran. */
function findDrift(migrations, applied) {
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
    const applied = await loadApplied(client);
    for (const migration of migrations) {
      const record = applied.get(migration.version);
      if (record) {
        const drift = record.checksum !== migration.checksum ? " (MODIFIED SINCE APPLIED)" : "";
        console.log(`applied  ${migration.name}  ${record.applied_at.toISOString()}${drift}`);
      } else {
        console.log(`pending  ${migration.name}`);
      }
    }
  });
}

async function push() {
  await withClient(async (client) => {
    await ensureTrackingTable(client);
    const migrations = loadMigrations();
    const applied = await loadApplied(client);

    const drifted = findDrift(migrations, applied);
    if (drifted.length > 0) {
      console.error("ERROR: refusing to push — already-applied migration(s) were modified:");
      for (const name of drifted) console.error(`  ${name}`);
      process.exit(1);
    }

    const pending = migrations.filter((m) => !applied.has(m.version));
    if (pending.length === 0) {
      console.log("OK: no pending migrations.");
      return;
    }

    for (const migration of pending) {
      console.log(`applying ${migration.name} ...`);
      await client.query("begin");
      try {
        await client.query(migration.sql);
        await client.query(
          "insert into public._migrations (version, name, checksum) values ($1, $2, $3)",
          [migration.version, migration.name, migration.checksum],
        );
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
      console.log(`applied  ${migration.name}`);
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

const cmd = process.argv[2];
const handlers = { status, push, verify };
const handler = handlers[cmd];
if (!handler) {
  console.error("Usage: migrate.mjs {status|push|verify}");
  process.exit(1);
}
handler().catch((err) => {
  console.error(err);
  process.exit(1);
});
