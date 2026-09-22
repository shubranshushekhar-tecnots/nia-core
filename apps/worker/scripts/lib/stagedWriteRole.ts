/**
 * Shared staged-mode write-role provisioning for smoke/kill-test scripts.
 *
 * Since Phase 11, resolveWriteMode() (packages/schemas/src/nodeConfig.ts)
 * defaults an absent `writeMode` to "staged". Staged mode's preflight
 * (runPreflight, apps/worker/src/lib/etl/stagedWrite.ts — invoked once per
 * run, before extraction starts) requires the destination credential's role
 * to be able to CREATE (and, for mysql, DROP) in the `nia` staging
 * schema/database, in addition to writing the destination entity itself.
 * That's exactly what services/connector-{supabase,mysql}/src/index.ts's
 * `/preflight` checks (`create-schema-nia`, `create-drop-staging-table`)
 * ask for in their generated `grantSql` hints when a role is missing them —
 * this module is the one place that grant SQL lives for smoke/kill-test
 * scripts, instead of being copy-pasted (and silently drifting out of date,
 * as happened after Phase 11 shipped — see docs/decisions.md's Phase 13
 * gate entry) across scripts.
 *
 * Scripts using these helpers stay on the default staged write path (no
 * `writeMode: "direct"` override), so they keep exercising the real
 * staging/atomic-apply/quarantine machinery customers get by default.
 */
import type pg from "pg";
import type mysql from "mysql2/promise";

/**
 * Grants a Postgres role the staged-mode preflight privileges: CREATE on
 * the database (needed for `CREATE SCHEMA IF NOT EXISTS "nia"`), plus
 * CREATE *and* USAGE on the `nia` schema itself (needed to create AND
 * subsequently drop/reference the staging table — CREATE alone lets the
 * role create a table in the schema but not look it back up by qualified
 * name afterward, which is what the connector's `/preflight` create-then-
 * drop probe does; USAGE isn't mentioned in the connector's own grantSql
 * hint text, but is required in practice — confirmed by reproducing the
 * exact `CREATE TABLE ...; DROP TABLE ...;` probe as a CREATE-only role
 * during the Phase 13 gate rework, see docs/decisions.md). Ensures the
 * `nia` schema exists first so the schema-level grants have a target
 * regardless of which script runs first against the shared sandbox
 * database.
 *
 * No separate DML grant is needed here: the role itself creates the
 * staging table (`CREATE TABLE ... AS`/`CREATE TABLE`), so Postgres makes
 * it the table's owner, which carries implicit SELECT/INSERT/UPDATE/DELETE
 * — unlike MySQL (see grantStagedMysqlWriteRole below), which has no
 * per-table ownership model.
 *
 * `client` must already be connected as an admin/superuser role (e.g. the
 * sandbox's `postgres` user) against the target database. `database` is
 * the literal database name — `GRANT ... ON DATABASE` requires a real
 * identifier, not `current_database()` (the connector's grantSql hint text
 * uses that as a stand-in for "whichever database you're connected to",
 * not literal executable SQL).
 */
export async function grantStagedPostgresWriteRole(client: pg.Client, database: string, roleUser: string): Promise<void> {
  await client.query(`grant create on database ${database} to ${roleUser}`);
  await client.query(`create schema if not exists "nia"`);
  await client.query(`grant create, usage on schema "nia" to ${roleUser}`);
}

/**
 * Sequence fix (docs/plans/schema-layer.md) — a destination table the
 * write role does NOT own (e.g. admin-created, like DEST_HAPPY etc.
 * below) only gets DML privileges via an explicit per-table GRANT (see
 * each script's own `grant select, insert, update on ${table}` calls);
 * unlike the table itself, granting DML on the table does NOT also grant
 * anything on its identity/serial columns' backing sequences. Writing an
 * explicit id (OVERRIDING SYSTEM VALUE) into such a column now also
 * advances that sequence (stagingSql.ts's buildAdvanceSequencesSql, run
 * inside the same apply transaction), which needs SELECT (read the
 * sequence's current value) and UPDATE (setval) on the sequence itself —
 * privileges table ownership would have implied for free, but a plain
 * per-table DML grant does not. Call this once per sequence-backed
 * destination column a script's write role needs to write explicit ids
 * into, alongside its existing per-table `grant select, insert, update`
 * calls. `column` must already be sequence-backed (identity or serial) on
 * `table` — this doesn't create one.
 */
export async function grantPostgresSequencePrivileges(client: pg.Client, table: string, column: string, roleUser: string): Promise<void> {
  const { rows } = await client.query<{ seq: string }>(`select pg_get_serial_sequence($1, $2) as seq`, [table, column]);
  const seq = rows[0]?.seq;
  if (!seq) throw new Error(`column "${column}" on ${table} is not sequence-backed (identity or serial) — nothing to grant`);
  await client.query(`grant usage, select, update on sequence ${seq} to ${roleUser}`);
}

/**
 * Grants a MySQL role the staged-mode preflight privileges (global CREATE,
 * needed for `CREATE DATABASE IF NOT EXISTS nia`; CREATE+DROP scoped to the
 * `nia` database, needed to create/drop the staging table) plus the DML
 * privileges actually needed to write into and apply-from the staging
 * table afterward. Unlike Postgres (where creating a table makes the
 * creating role its owner, with implicit DML rights), MySQL has no per-
 * table ownership model — CREATE/DROP alone lets the role create and drop
 * the staging table but grants no SELECT/INSERT/UPDATE/DELETE on it, which
 * the staged-write/apply/quarantine machinery needs once the table exists
 * (confirmed by reproducing the CREATE-DROP-only role against a live
 * staged run during the Phase 13 gate rework — see docs/decisions.md).
 *
 * `admin` must already be connected as an admin user (e.g. the sandbox's
 * `root` user).
 */
export async function grantStagedMysqlWriteRole(admin: mysql.Connection, roleUser: string): Promise<void> {
  await admin.query(`GRANT CREATE ON *.* TO '${roleUser}'@'%'`);
  await admin.query("CREATE DATABASE IF NOT EXISTS `nia`");
  await admin.query(`GRANT CREATE, DROP, SELECT, INSERT, UPDATE, DELETE ON \`nia\`.* TO '${roleUser}'@'%'`);
}
