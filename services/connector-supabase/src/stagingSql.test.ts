import { describe, expect, it } from "vitest";
import { buildAdvanceSequencesSql, buildApplyFromStagingSql, buildCreateQuarantineSql, buildCreateStagingSql, buildStagingUpsertSql } from "./stagingSql.js";

/**
 * Phase 13 Step 6 addition — regression guard for the RLS + no-USAGE
 * preflight on the `nia` staging/quarantine schema (see stagingSql.ts's
 * revokeSchemaUsageSql doc comment and TODO.md's "Phase 13 gate" deferred
 * check this closes out).
 */

const dest = { namespace: "sales", name: "orders" };
const stagingEntity = { namespace: "run-1", name: "nia_stg_abc123" };
const quarantineEntity = { namespace: "run-1", name: "nia_quarantine" };

describe("staging SQL — nia schema RLS + grants preflight", () => {
  it("revokes schema USAGE from PUBLIC/anon/authenticated when creating the staging table", () => {
    const statements = buildCreateStagingSql(dest, stagingEntity);
    const revoke = statements.find((s) => s.startsWith("DO $$"));
    expect(revoke).toContain('REVOKE ALL ON SCHEMA "nia" FROM PUBLIC');
    expect(revoke).toContain('REVOKE ALL ON SCHEMA "nia" FROM anon');
    expect(revoke).toContain('REVOKE ALL ON SCHEMA "nia" FROM authenticated');
  });

  it("tolerates anon/authenticated not existing (plain Postgres, not a Supabase project)", () => {
    const statements = buildCreateStagingSql(dest, stagingEntity);
    const revoke = statements.find((s) => s.startsWith("DO $$"));
    expect(revoke).toContain("EXCEPTION WHEN undefined_object THEN NULL");
  });

  it("enables RLS on the staging table", () => {
    const statements = buildCreateStagingSql(dest, stagingEntity);
    expect(statements).toContain('ALTER TABLE "nia"."nia_stg_abc123" ENABLE ROW LEVEL SECURITY');
  });

  // Follow-up item 2: a dest column like Supabase Studio's default
  // `id bigint generated always as identity` must stay generated/identity
  // in staging too, or an INSERT that (correctly) never targets that
  // column fails with a not-null violation once staging drops the
  // generation behavior LIKE excludes by default.
  it("mirrors GENERATED and IDENTITY column behavior onto the staging table (not just DEFAULTS/INDEXES)", () => {
    const statements = buildCreateStagingSql(dest, stagingEntity);
    const create = statements.find((s) => s.includes("CREATE TABLE IF NOT EXISTS"));
    expect(create).toContain("INCLUDING GENERATED");
    expect(create).toContain("INCLUDING IDENTITY");
  });

  it("revokes schema USAGE from PUBLIC/anon/authenticated when creating the quarantine table", () => {
    const statements = buildCreateQuarantineSql(quarantineEntity);
    const revoke = statements.find((s) => s.startsWith("DO $$"));
    expect(revoke).toContain('REVOKE ALL ON SCHEMA "nia" FROM PUBLIC');
    expect(revoke).toContain('REVOKE ALL ON SCHEMA "nia" FROM anon');
    expect(revoke).toContain('REVOKE ALL ON SCHEMA "nia" FROM authenticated');
  });

  it("enables RLS on the quarantine table (previously missing)", () => {
    const statements = buildCreateQuarantineSql(quarantineEntity);
    expect(statements).toContain('ALTER TABLE "nia"."nia_quarantine" ENABLE ROW LEVEL SECURITY');
  });

  // Bug fix: nia_quarantine is a single fixed table shared by every write
  // grant on the same database — a second grant's role is never its owner,
  // so re-running CREATE SCHEMA (needs database-level CREATE) or ALTER
  // TABLE ... ENABLE ROW LEVEL SECURITY (needs table ownership) against an
  // already-provisioned "nia"/nia_quarantine fails for that role even
  // though nothing is actually wrong. Once the caller (index.ts) has
  // confirmed both already exist, neither statement should be emitted —
  // only the harmless, ownership-free CREATE TABLE IF NOT EXISTS remains.
  it("omits CREATE SCHEMA and ALTER TABLE ENABLE RLS once the caller confirms the schema exists and RLS is already on", () => {
    const statements = buildCreateQuarantineSql(quarantineEntity, true, true);
    expect(statements.some((s) => s.startsWith("CREATE SCHEMA"))).toBe(false);
    expect(statements.some((s) => s.includes("ENABLE ROW LEVEL SECURITY"))).toBe(false);
    expect(statements.some((s) => s.startsWith("CREATE TABLE IF NOT EXISTS"))).toBe(true);
  });

  // Check item 1 (identity columns): staging is `LIKE dest INCLUDING
  // IDENTITY`, so a mapped column that's GENERATED ALWAYS AS IDENTITY on
  // dest is GENERATED ALWAYS AS IDENTITY on staging too — Postgres refuses
  // an explicit value into it without this clause. Confirmed live against
  // dev-postgres for both the staging write and the apply step.
  it("includes OVERRIDING SYSTEM VALUE on both the staging write and the apply, so an explicit id survives a GENERATED ALWAYS AS IDENTITY column", () => {
    const stagingSql = buildStagingUpsertSql(stagingEntity, ["id", "name"], ["id"], 1);
    expect(stagingSql).toContain("OVERRIDING SYSTEM VALUE");

    const [appendSql] = buildApplyFromStagingSql(dest, stagingEntity, ["id", "name"], ["id"], "append");
    expect(appendSql).toContain("OVERRIDING SYSTEM VALUE");

    const [, replaceInsertSql] = buildApplyFromStagingSql(dest, stagingEntity, ["id", "name"], ["id"], "replace");
    expect(replaceInsertSql).toContain("OVERRIDING SYSTEM VALUE");
  });

  // Sequence fix: OVERRIDING SYSTEM VALUE (above) writes explicit values
  // into a sequence-backed column without ever advancing its sequence —
  // this builder is the apply-transaction follow-up that does, guarded
  // per-column by pg_get_serial_sequence so it's a no-op for any applied
  // column that isn't actually sequence-backed.
  it("advances every applied column's sequence, guarded by pg_get_serial_sequence, without ever lowering it", () => {
    const sql = buildAdvanceSequencesSql(dest, ["id", "name"]);
    expect(sql).toContain(`pg_get_serial_sequence('"sales"."orders"', 'id')`);
    expect(sql).toContain(`pg_get_serial_sequence('"sales"."orders"', 'name')`);
    expect(sql).toContain("setval(seqname, GREATEST(cur_val, (SELECT COALESCE(MAX(\"id\"), 0) FROM \"sales\".\"orders\")))");
    expect(sql).toContain("IF seqname IS NOT NULL THEN");
  });

  it("runs the REVOKE before the table is created, for both staging and quarantine", () => {
    const staging = buildCreateStagingSql(dest, stagingEntity);
    const revokeIdx = staging.findIndex((s) => s.startsWith("DO $$"));
    const createIdx = staging.findIndex((s) => s.startsWith("CREATE TABLE"));
    expect(revokeIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(revokeIdx);

    const quarantine = buildCreateQuarantineSql(quarantineEntity);
    const qRevokeIdx = quarantine.findIndex((s) => s.startsWith("DO $$"));
    const qCreateIdx = quarantine.findIndex((s) => s.startsWith("CREATE TABLE"));
    expect(qRevokeIdx).toBeGreaterThanOrEqual(0);
    expect(qCreateIdx).toBeGreaterThan(qRevokeIdx);
  });
});
