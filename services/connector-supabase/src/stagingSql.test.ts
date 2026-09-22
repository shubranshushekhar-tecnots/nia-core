import { describe, expect, it } from "vitest";
import { buildCreateQuarantineSql, buildCreateStagingSql } from "./stagingSql.js";

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
    expect(statements).toContain('REVOKE ALL ON SCHEMA "nia" FROM PUBLIC, anon, authenticated');
  });

  it("enables RLS on the staging table", () => {
    const statements = buildCreateStagingSql(dest, stagingEntity);
    expect(statements).toContain('ALTER TABLE "nia"."nia_stg_abc123" ENABLE ROW LEVEL SECURITY');
  });

  it("revokes schema USAGE from PUBLIC/anon/authenticated when creating the quarantine table", () => {
    const statements = buildCreateQuarantineSql(quarantineEntity);
    expect(statements).toContain('REVOKE ALL ON SCHEMA "nia" FROM PUBLIC, anon, authenticated');
  });

  it("enables RLS on the quarantine table (previously missing)", () => {
    const statements = buildCreateQuarantineSql(quarantineEntity);
    expect(statements).toContain('ALTER TABLE "nia"."nia_quarantine" ENABLE ROW LEVEL SECURITY');
  });

  it("runs the REVOKE before the table is created, for both staging and quarantine", () => {
    const staging = buildCreateStagingSql(dest, stagingEntity);
    const revokeIdx = staging.findIndex((s) => s.startsWith("REVOKE"));
    const createIdx = staging.findIndex((s) => s.startsWith("CREATE TABLE"));
    expect(revokeIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(revokeIdx);

    const quarantine = buildCreateQuarantineSql(quarantineEntity);
    const qRevokeIdx = quarantine.findIndex((s) => s.startsWith("REVOKE"));
    const qCreateIdx = quarantine.findIndex((s) => s.startsWith("CREATE TABLE"));
    expect(qRevokeIdx).toBeGreaterThanOrEqual(0);
    expect(qCreateIdx).toBeGreaterThan(qRevokeIdx);
  });
});
