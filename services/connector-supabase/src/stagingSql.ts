import type { AssertionSpec, WriteEntityRef, WriteMode } from "@nia/schemas";

/**
 * Phase 11 Block 2A/2B/2E — fixed-template SQL builders for the staging
 * lifecycle (create/apply/drop) and its pre-apply assertions. Same posture
 * as writeSql.ts: identifiers are NOT re-validated here (StageRequest's
 * Zod schema — contract.ts's SqlIdentifier — already rejects anything that
 * isn't a bare identifier before this module ever sees it), and every
 * value that isn't an identifier is parameterized, never interpolated.
 *
 * Staging tables always live in a dedicated `nia` schema — never `public`
 * — per the Phase 11 plan (avoids ever colliding with, or being mistaken
 * for, a customer's own tables). Only `create`/`apply`/`drop` build SQL
 * that names a staging or quarantine table at all, and index.ts's /stage
 * handler only ever calls these with the SAME stagingEntity/quarantineEntity
 * that the request's signed WriteContext carries — see this module's
 * callers for that check, not this module (this module has no access to
 * the signature and must never be trusted as the enforcement point on its
 * own).
 */

const STAGING_SCHEMA = "nia";

function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

function qualifiedTable(entity: WriteEntityRef): string {
  return `${quoteIdent(entity.namespace)}.${quoteIdent(entity.name)}`;
}

/** Staging/quarantine entities are always addressed under the `nia` schema, regardless of the namespace field on the WriteEntityRef (which is normally the run's staging-name grouping, not a real Postgres schema). */
function qualifiedStagingTable(entity: WriteEntityRef): string {
  return `${quoteIdent(STAGING_SCHEMA)}.${quoteIdent(entity.name)}`;
}

/**
 * Phase 13 Step 6 preflight guard — PostgREST (the anon/authenticated API
 * surface every Supabase project exposes) can only reach a schema at all
 * if those roles hold USAGE on it. `nia` is never meant to be
 * PostgREST-visible (it's an internal staging/quarantine area written
 * only by this connector's own service-role Postgres connection), so
 * every staging/quarantine create path explicitly revokes USAGE right
 * after the schema exists, rather than relying on Postgres's default of
 * not auto-granting it to a freshly created schema — an explicit REVOKE
 * survives even if some other process (an extension, an inherited
 * `ALTER DEFAULT PRIVILEGES`, a future Supabase default change) ever
 * grants it. Idempotent (REVOKE on a role with no matching grant is a
 * no-op, not an error), so safe to run on every create call alongside
 * `CREATE SCHEMA IF NOT EXISTS`.
 *
 * `anon`/`authenticated` only exist on a real Supabase/PostgREST-fronted
 * project (see index.ts's own "postgres" manifest — same connector-
 * supabase service, dispatched against a plain sandbox/self-hosted
 * Postgres with neither role). Unlike a REVOKE against an existing role
 * with no matching grant, REVOKE against a role name that doesn't exist
 * at all raises `role "anon" does not exist` and aborts the transaction
 * — so each optional role's REVOKE is wrapped in its own exception
 * block, catching `undefined_object` (Postgres's SQLSTATE for "role does
 * not exist") as a no-op, keeping this kind-agnostic across both a real
 * Supabase project and a plain Postgres destination.
 */
function revokeSchemaUsageSql(): string {
  const schema = quoteIdent(STAGING_SCHEMA);
  return `DO $$
BEGIN
  REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
  BEGIN
    REVOKE ALL ON SCHEMA ${schema} FROM anon;
  EXCEPTION WHEN undefined_object THEN NULL;
  END;
  BEGIN
    REVOKE ALL ON SCHEMA ${schema} FROM authenticated;
  EXCEPTION WHEN undefined_object THEN NULL;
  END;
END $$`;
}

/**
 * `schemaExists`: same reasoning as writeSql.ts's buildCreateTableSql —
 * Postgres's `CREATE SCHEMA IF NOT EXISTS` still runs its database-level
 * CREATE privilege check even when the schema already exists, but a
 * write-grant role is only ever granted `CREATE ON SCHEMA "nia"` (see
 * writeGrantStatement.ts), never database-level CREATE. The caller
 * (index.ts's /stage and /write handlers) checks pg_namespace first and
 * only asks for the CREATE SCHEMA statement when it's actually needed —
 * see docs/decisions.md's "Staging/quarantine writes in nia..." entry.
 */
export function buildCreateStagingSql(dest: WriteEntityRef, stagingEntity: WriteEntityRef, schemaExists = false): string[] {
  return [
    ...(schemaExists ? [] : [`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(STAGING_SCHEMA)}`]),
    revokeSchemaUsageSql(),
    // Follow-up item 2: LIKE's INCLUDING clauses are opt-in per Postgres's
    // own defaults, and GENERATED/IDENTITY are excluded unless named
    // explicitly. Without them, a dest column like Supabase Studio's
    // default `id bigint generated always as identity primary key` copies
    // into staging as a plain NOT NULL integer with no identity and no
    // default — the mapped-columns-only INSERT below (buildStagingUpsertSql
    // never targets a column nothing maps to) then fails with a not-null
    // violation on that column. INCLUDING GENERATED/IDENTITY makes staging
    // mirror dest's own auto-generation, so an unmapped identity/generated
    // column self-populates in staging exactly like it would in dest.
    `CREATE TABLE IF NOT EXISTS ${qualifiedStagingTable(stagingEntity)} (LIKE ${qualifiedTable(dest)} INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING IDENTITY INCLUDING INDEXES)`,
    `ALTER TABLE ${qualifiedStagingTable(stagingEntity)} ENABLE ROW LEVEL SECURITY`,
  ];
}

export function buildDropStagingSql(stagingEntity: WriteEntityRef): string {
  return `DROP TABLE IF EXISTS ${qualifiedStagingTable(stagingEntity)}`;
}

/**
 * `schemaExists`: see buildCreateStagingSql's doc comment above — same
 * pg_namespace-first pattern, needed here too since this also unconditionally
 * emitted `CREATE SCHEMA IF NOT EXISTS "nia"`.
 *
 * `rlsAlreadyEnabled`: `nia_quarantine` is a single fixed table shared by
 * every write grant on the same underlying database (stagingRegistry.ts's
 * deriveQuarantineEntity: "one fixed, long-lived quarantine table per
 * destination connection/database — never per-run"), so it's normal for a
 * SECOND grant's role to call this against a table a DIFFERENT role already
 * created (and RLS-enabled). `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`
 * requires being the table's owner — unconditionally re-running it here
 * fails with "must be owner of table nia_quarantine" for any role that
 * isn't the original creator. The admin-run grant DDL (writeGrantStatement.ts)
 * now creates+RLS-enables this table once up front; the caller (index.ts)
 * checks pg_class.relrowsecurity first and skips the ALTER when it's
 * already on, same as it skips CREATE SCHEMA when the schema already
 * exists. `CREATE TABLE IF NOT EXISTS` stays unconditional either way — it
 * only needs CREATE on the schema (which every write role has), never
 * ownership, so it's always a safe no-op once the table exists.
 */
export function buildCreateQuarantineSql(quarantineEntity: WriteEntityRef, schemaExists = false, rlsAlreadyEnabled = false): string[] {
  return [
    ...(schemaExists ? [] : [`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(STAGING_SCHEMA)}`]),
    revokeSchemaUsageSql(),
    `CREATE TABLE IF NOT EXISTS ${qualifiedStagingTable(quarantineEntity)} (
      id bigint generated always as identity primary key,
      run_id uuid not null,
      dest_table text not null,
      step_id text not null,
      function text not null,
      input_value text,
      source_row jsonb not null,
      status text not null default 'pending',
      created_at timestamptz not null default now()
    )`,
    ...(rlsAlreadyEnabled ? [] : [`ALTER TABLE ${qualifiedStagingTable(quarantineEntity)} ENABLE ROW LEVEL SECURITY`]),
  ];
}

/** Same INSERT...ON CONFLICT shape as writeSql.ts's buildUpsertSql, targeting the staging table instead of the destination. */
export function buildStagingUpsertSql(
  stagingEntity: WriteEntityRef,
  columns: string[],
  upsertKeys: string[],
  rowCount: number,
): string {
  const table = qualifiedStagingTable(stagingEntity);
  const colList = columns.map(quoteIdent).join(", ");
  const valueRows: string[] = [];
  let paramIndex = 1;
  for (let r = 0; r < rowCount; r++) {
    valueRows.push(`(${columns.map(() => `$${paramIndex++}`).join(", ")})`);
  }
  const conflictCols = upsertKeys.map(quoteIdent).join(", ");
  const updateCols = columns.filter((c) => !upsertKeys.includes(c));
  const conflictClause =
    updateCols.length > 0
      ? `ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateCols.map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`).join(", ")}`
      : `ON CONFLICT (${conflictCols}) DO NOTHING`;
  // Check item 1 (identity columns): staging is created with `LIKE dest
  // INCLUDING IDENTITY` (buildCreateStagingSql above), so a mapped column
  // that's GENERATED ALWAYS AS IDENTITY on dest is GENERATED ALWAYS AS
  // IDENTITY on staging too — Postgres refuses an explicit (non-DEFAULT)
  // value into such a column without OVERRIDING SYSTEM VALUE. Unconditional
  // and always safe to include: confirmed live (dev-postgres) that it's a
  // no-op on a plain non-identity column, on a GENERATED BY DEFAULT column,
  // and even when the identity column isn't in the column list at all.
  return `INSERT INTO ${table} (${colList}) OVERRIDING SYSTEM VALUE VALUES ${valueRows.join(", ")} ${conflictClause}`;
}

export function buildQuarantineInsertSql(quarantineEntity: WriteEntityRef, rowCount: number): string {
  const table = qualifiedStagingTable(quarantineEntity);
  const valueRows: string[] = [];
  let paramIndex = 1;
  for (let r = 0; r < rowCount; r++) {
    const placeholders = Array.from({ length: 6 }, () => `$${paramIndex++}`).join(", ");
    valueRows.push(`(${placeholders})`);
  }
  return `INSERT INTO ${table} (run_id, dest_table, step_id, function, input_value, source_row) VALUES ${valueRows.join(", ")}`;
}

export function buildQuarantineCommitSql(quarantineEntity: WriteEntityRef): { sql: string } {
  return { sql: `UPDATE ${qualifiedStagingTable(quarantineEntity)} SET status = 'committed' WHERE run_id = $1 AND status = 'pending'` };
}

export function buildQuarantineDeletePendingSql(quarantineEntity: WriteEntityRef): { sql: string } {
  return { sql: `DELETE FROM ${qualifiedStagingTable(quarantineEntity)} WHERE run_id = $1 AND status = 'pending'` };
}

export function buildQuarantineCountSql(quarantineEntity: WriteEntityRef): { sql: string } {
  return { sql: `SELECT COUNT(*)::int AS n FROM ${qualifiedStagingTable(quarantineEntity)} WHERE run_id = $1 AND status = 'pending'` };
}

export function buildStagingCountSql(stagingEntity: WriteEntityRef): string {
  return `SELECT COUNT(*)::int AS n FROM ${qualifiedStagingTable(stagingEntity)}`;
}

/** The one destination-mutating step: moves staging rows into `dest` per `mode`, inside the caller's transaction. */
export function buildApplyFromStagingSql(
  dest: WriteEntityRef,
  stagingEntity: WriteEntityRef,
  columns: string[],
  upsertKeys: string[],
  mode: WriteMode,
): string[] {
  const destTable = qualifiedTable(dest);
  const stagingTable = qualifiedStagingTable(stagingEntity);
  const colList = columns.map(quoteIdent).join(", ");
  // Check item 1: same OVERRIDING SYSTEM VALUE need as buildStagingUpsertSql
  // above, here for the apply step's INSERT into dest itself.
  if (mode === "replace") {
    return [`DELETE FROM ${destTable}`, `INSERT INTO ${destTable} (${colList}) OVERRIDING SYSTEM VALUE SELECT ${colList} FROM ${stagingTable}`];
  }
  const conflictCols = upsertKeys.map(quoteIdent).join(", ");
  const updateCols = columns.filter((c) => !upsertKeys.includes(c));
  const conflictClause =
    updateCols.length > 0
      ? `ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateCols.map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`).join(", ")}`
      : `ON CONFLICT (${conflictCols}) DO NOTHING`;
  return [`INSERT INTO ${destTable} (${colList}) OVERRIDING SYSTEM VALUE SELECT ${colList} FROM ${stagingTable} ${conflictClause}`];
}

/**
 * Sequence fix: writing explicit ids via OVERRIDING SYSTEM VALUE (above)
 * bypasses the column's sequence entirely — Postgres never advances a
 * sequence just because a value landed in the column it backs. Left
 * alone, the customer's own app later inserting a row *without* an id
 * (letting the column self-generate, the normal case) can collide with an
 * id this run just wrote explicitly, once the sequence's next value
 * catches up to one already taken. Runs inside the same apply transaction
 * as the INSERT/SELECT above, once per applied column: `seqname` is only
 * non-null when that column is actually sequence-backed (identity or
 * plain `serial` — `pg_get_serial_sequence` covers both), so this is safe
 * to call unconditionally with every applied column, not just ones known
 * ahead of time to need it. Never lowers the sequence: the new value is
 * `GREATEST(its own current last_value, MAX(column) in dest now)` —
 * reading `last_value` needs dynamic SQL (EXECUTE ... INTO) since
 * `seqname` is only known at run time, but `MAX(column)` doesn't, since
 * `dest`/the column are fixed identifiers already known when this SQL is
 * built.
 */
export function buildAdvanceSequencesSql(dest: WriteEntityRef, columns: string[]): string {
  const destTable = qualifiedTable(dest);
  const steps = columns
    .map((c) => {
      const col = quoteIdent(c);
      return `
  seqname := pg_get_serial_sequence('${destTable}', '${c}');
  IF seqname IS NOT NULL THEN
    EXECUTE format('SELECT last_value FROM %s', seqname) INTO cur_val;
    PERFORM setval(seqname, GREATEST(cur_val, (SELECT COALESCE(MAX(${col}), 0) FROM ${destTable})));
  END IF;`;
    })
    .join("\n");
  return `DO $$
DECLARE
  seqname text;
  cur_val bigint;
BEGIN${steps}
END $$`;
}

export type AssertionQuery = { kind: AssertionSpec["kind"]; sql: string; evaluate: (row: Record<string, unknown>) => { ok: boolean; detail?: string } };

/**
 * Builds the read-only SQL for every AssertionSpec kind that queries
 * staging/destination directly. `maxFailureRate` is excluded — the
 * connector evaluates it from the quarantine row count it already holds
 * mid-transaction (buildQuarantineCountSql), not from a query this
 * function would build, per contract.ts's WriteContext-adjacent comment
 * ("evaluated ... from counts it already has ... rather than a
 * client-supplied number").
 */
export function buildAssertionQuery(
  spec: AssertionSpec,
  stagingEntity: WriteEntityRef,
  dest: WriteEntityRef,
): AssertionQuery | null {
  const stagingTable = qualifiedStagingTable(stagingEntity);
  switch (spec.kind) {
    case "noNullKeys": {
      const cond = spec.columns.map((c) => `${quoteIdent(c)} IS NULL`).join(" OR ");
      return {
        kind: spec.kind,
        sql: `SELECT COUNT(*)::int AS n FROM ${stagingTable} WHERE ${cond}`,
        evaluate: (row) => {
          const n = Number(row.n);
          return n === 0 ? { ok: true } : { ok: false, detail: `${n} staging row(s) have a NULL value in an upsert-key column` };
        },
      };
    }
    case "uniqueColumns": {
      const colList = spec.columns.map(quoteIdent).join(", ");
      return {
        kind: spec.kind,
        sql: `SELECT COUNT(*)::int AS n FROM (SELECT ${colList} FROM ${stagingTable} GROUP BY ${colList} HAVING COUNT(*) > 1) dup`,
        evaluate: (row) => {
          const n = Number(row.n);
          return n === 0 ? { ok: true } : { ok: false, detail: `${n} duplicate group(s) found in staging for columns (${spec.columns.join(", ")})` };
        },
      };
    }
    case "replaceShrinkGuard": {
      const destTable = qualifiedTable(dest);
      return {
        kind: spec.kind,
        sql: `SELECT (SELECT COUNT(*)::int FROM ${stagingTable}) AS staging_count, (SELECT COUNT(*)::int FROM ${destTable}) AS dest_count`,
        evaluate: (row) => {
          const stagingCount = Number(row.staging_count);
          const destCount = Number(row.dest_count);
          if (spec.allowShrink || destCount === 0) return { ok: true };
          const ratio = stagingCount / destCount;
          return ratio >= spec.minRatio
            ? { ok: true }
            : { ok: false, detail: `staging holds ${stagingCount} row(s), ${(ratio * 100).toFixed(1)}% of destination's ${destCount} (below ${(spec.minRatio * 100).toFixed(0)}% minimum)` };
        },
      };
    }
    case "maxFailureRate":
      return null;
  }
}
