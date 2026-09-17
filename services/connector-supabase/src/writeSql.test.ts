import { describe, expect, it } from "vitest";
import { buildUpsertSql } from "./writeSql.js";

describe("buildUpsertSql", () => {
  it("builds a single-row UPSERT with DO UPDATE SET for non-key columns", () => {
    const sql = buildUpsertSql({ namespace: "sales", name: "orders" }, ["id", "total", "status"], ["id"], 1);
    expect(sql).toBe(
      'INSERT INTO "sales"."orders" ("id", "total", "status") VALUES ($1, $2, $3) ON CONFLICT ("id") DO UPDATE SET "total" = excluded."total", "status" = excluded."status"',
    );
  });

  it("builds a multi-row VALUES list with sequential, non-overlapping placeholders", () => {
    const sql = buildUpsertSql({ namespace: "sales", name: "orders" }, ["id", "total"], ["id"], 3);
    expect(sql).toBe(
      'INSERT INTO "sales"."orders" ("id", "total") VALUES ($1, $2), ($3, $4), ($5, $6) ON CONFLICT ("id") DO UPDATE SET "total" = excluded."total"',
    );
  });

  it("falls back to DO NOTHING when every column is an upsert key (nothing left to update)", () => {
    const sql = buildUpsertSql({ namespace: "sales", name: "orders" }, ["id", "sku"], ["id", "sku"], 1);
    expect(sql).toBe('INSERT INTO "sales"."orders" ("id", "sku") VALUES ($1, $2) ON CONFLICT ("id", "sku") DO NOTHING');
  });

  it("quotes identifiers containing double quotes to prevent injection via identifier fields", () => {
    const sql = buildUpsertSql({ namespace: 'sa"les', name: "orders" }, ["id"], ["id"], 1);
    expect(sql).toContain('"sa""les"');
  });
});
