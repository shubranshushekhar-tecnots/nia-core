import type { AssertionSpec, WriteEntityRef, WriteMode } from "@nia/schemas";

/**
 * Phase 11 Block 2A/2B/2E — fixed-template SQL builders for the staging
 * lifecycle (create/apply/drop) and its pre-apply assertions. MySQL-dialect
 * mirror of connector-supabase/src/stagingSql.ts — same posture: identifiers
 * are NOT re-validated here (StageRequest's Zod schema already rejects
 * anything that isn't a bare identifier before this module ever sees it),
 * every non-identifier value is parameterized (`?`, mysql2's convention),
 * never interpolated.
 *
 * Dialect differences from the postgres version:
 *  - No separate schema concept distinct from "database" — the `nia`
 *    staging area is a MySQL database, created with `CREATE DATABASE IF NOT
 *    EXISTS` (MySQL treats SCHEMA/DATABASE as synonyms).
 *  - `CREATE TABLE ... LIKE dest` already copies indexes (unlike postgres,
 *    no INCLUDING INDEXES needed) — but does NOT copy the destination's
 *    rows, foreign keys, or AUTO_INCREMENT next-value, which is exactly
 *    the "just the shape" behavior staging needs.
 *  - No RLS — MySQL has no row-level-security primitive, so
 *    buildCreateStagingSql has no equivalent of the postgres ENABLE ROW
 *    LEVEL SECURITY statement.
 *  - `ON DUPLICATE KEY UPDATE` instead of `ON CONFLICT`, `VALUES(col)`
 *    instead of `excluded.col` — same self-assign fallback as writeSql.ts's
 *    buildUpsertSql when there are no non-key columns to update.
 *
 * Staging/quarantine tables always live under the `nia` database — never
 * the destination's own database — regardless of the entity's `namespace`
 * field (which is the run's staging-name grouping, not a real MySQL
 * database). Only index.ts's /stage handler decides when these are called,
 * and only after checking the request's stagingEntity/quarantineEntity
 * against the signed WriteContext — this module has no access to the
 * signature and must never be trusted as the enforcement point on its own.
 */

const STAGING_SCHEMA = "nia";

function quoteIdent(id: string): string {
  return `\`${id.replace(/`/g, "``")}\``;
}

function qualifiedTable(entity: WriteEntityRef): string {
  return `${quoteIdent(entity.namespace)}.${quoteIdent(entity.name)}`;
}

/** Staging/quarantine entities are always addressed under the `nia` database, regardless of the namespace field on the WriteEntityRef. */
function qualifiedStagingTable(entity: WriteEntityRef): string {
  return `${quoteIdent(STAGING_SCHEMA)}.${quoteIdent(entity.name)}`;
}

export function buildCreateStagingSql(dest: WriteEntityRef, stagingEntity: WriteEntityRef): string[] {
  return [
    `CREATE DATABASE IF NOT EXISTS ${quoteIdent(STAGING_SCHEMA)}`,
    `CREATE TABLE IF NOT EXISTS ${qualifiedStagingTable(stagingEntity)} LIKE ${qualifiedTable(dest)}`,
  ];
}

export function buildDropStagingSql(stagingEntity: WriteEntityRef): string {
  return `DROP TABLE IF EXISTS ${qualifiedStagingTable(stagingEntity)}`;
}

export function buildCreateQuarantineSql(quarantineEntity: WriteEntityRef): string[] {
  return [
    `CREATE DATABASE IF NOT EXISTS ${quoteIdent(STAGING_SCHEMA)}`,
    `CREATE TABLE IF NOT EXISTS ${qualifiedStagingTable(quarantineEntity)} (
      id bigint auto_increment primary key,
      run_id char(36) not null,
      dest_table varchar(255) not null,
      step_id varchar(255) not null,
      ${quoteIdent("function")} varchar(255) not null,
      input_value text,
      source_row json not null,
      status varchar(20) not null default 'pending',
      created_at timestamp not null default current_timestamp
    )`,
  ];
}

/** Same INSERT...ON DUPLICATE KEY UPDATE shape as writeSql.ts's buildUpsertSql, targeting the staging table instead of the destination. */
export function buildStagingUpsertSql(
  stagingEntity: WriteEntityRef,
  columns: string[],
  upsertKeys: string[],
  rowCount: number,
): string {
  const table = qualifiedStagingTable(stagingEntity);
  const colList = columns.map(quoteIdent).join(", ");
  const placeholderRow = `(${columns.map(() => "?").join(", ")})`;
  const valueRows = Array.from({ length: rowCount }, () => placeholderRow).join(", ");
  const updateCols = columns.filter((c) => !upsertKeys.includes(c));
  const updateClause =
    updateCols.length > 0
      ? updateCols.map((c) => `${quoteIdent(c)} = VALUES(${quoteIdent(c)})`).join(", ")
      : `${quoteIdent(upsertKeys[0]!)} = ${quoteIdent(upsertKeys[0]!)}`;
  return `INSERT INTO ${table} (${colList}) VALUES ${valueRows} ON DUPLICATE KEY UPDATE ${updateClause}`;
}

export function buildQuarantineInsertSql(quarantineEntity: WriteEntityRef, rowCount: number): string {
  const table = qualifiedStagingTable(quarantineEntity);
  const placeholderRow = `(${Array.from({ length: 6 }, () => "?").join(", ")})`;
  const valueRows = Array.from({ length: rowCount }, () => placeholderRow).join(", ");
  return `INSERT INTO ${table} (run_id, dest_table, step_id, ${quoteIdent("function")}, input_value, source_row) VALUES ${valueRows}`;
}

export function buildQuarantineCommitSql(quarantineEntity: WriteEntityRef): { sql: string } {
  return { sql: `UPDATE ${qualifiedStagingTable(quarantineEntity)} SET status = 'committed' WHERE run_id = ? AND status = 'pending'` };
}

export function buildQuarantineDeletePendingSql(quarantineEntity: WriteEntityRef): { sql: string } {
  return { sql: `DELETE FROM ${qualifiedStagingTable(quarantineEntity)} WHERE run_id = ? AND status = 'pending'` };
}

export function buildQuarantineCountSql(quarantineEntity: WriteEntityRef): { sql: string } {
  return { sql: `SELECT COUNT(*) AS n FROM ${qualifiedStagingTable(quarantineEntity)} WHERE run_id = ? AND status = 'pending'` };
}

export function buildStagingCountSql(stagingEntity: WriteEntityRef): string {
  return `SELECT COUNT(*) AS n FROM ${qualifiedStagingTable(stagingEntity)}`;
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
  if (mode === "replace") {
    return [`DELETE FROM ${destTable}`, `INSERT INTO ${destTable} (${colList}) SELECT ${colList} FROM ${stagingTable}`];
  }
  const updateCols = columns.filter((c) => !upsertKeys.includes(c));
  const updateClause =
    updateCols.length > 0
      ? updateCols.map((c) => `${quoteIdent(c)} = VALUES(${quoteIdent(c)})`).join(", ")
      : `${quoteIdent(upsertKeys[0]!)} = ${quoteIdent(upsertKeys[0]!)}`;
  return [`INSERT INTO ${destTable} (${colList}) SELECT ${colList} FROM ${stagingTable} ON DUPLICATE KEY UPDATE ${updateClause}`];
}

export type AssertionQuery = { kind: AssertionSpec["kind"]; sql: string; evaluate: (row: Record<string, unknown>) => { ok: boolean; detail?: string } };

/**
 * Builds the read-only SQL for every AssertionSpec kind that queries
 * staging/destination directly. `maxFailureRate` is excluded — the
 * connector evaluates it from the quarantine row count it already holds
 * mid-transaction (buildQuarantineCountSql), not from a query this
 * function would build — same rule as the postgres version.
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
        sql: `SELECT COUNT(*) AS n FROM ${stagingTable} WHERE ${cond}`,
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
        sql: `SELECT COUNT(*) AS n FROM (SELECT ${colList} FROM ${stagingTable} GROUP BY ${colList} HAVING COUNT(*) > 1) dup`,
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
        sql: `SELECT (SELECT COUNT(*) FROM ${stagingTable}) AS staging_count, (SELECT COUNT(*) FROM ${destTable}) AS dest_count`,
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
