import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntrospectResponse } from "@nia/schemas";
import { AppError } from "../lib/appError.js";
import { getConnectionSchema } from "./connections.js";
import { setCachedSchema } from "../lib/schemaCache.js";

/**
 * Session-2 Task 4 gap: "403 on cross-user schema fetch" had no test
 * coverage anywhere (code was correct, just unverified). Codebase
 * convention (grants.ts, connectors.ts, workflowGraphs.ts, and every other
 * branch of connections.ts) is a uniform 404 NOT_FOUND for any
 * cross-workspace access, never a literal 403 — a real row is never
 * revealed to exist in a workspace the actor can't see. This test locks
 * that convention in for getConnectionSchema specifically.
 *
 * Hand-rolled fake Supabase client, same style as workflowGraphs.race.test.ts:
 * filters an in-memory row set the same way the real .eq()/.is() chain
 * would, so the actual `"orgId" in scope ? ... : ...` branch in
 * getConnectionSchema is exercised for real, not mocked around.
 */
type FakeRow = {
  id: string;
  connector_id: string;
  config: Record<string, unknown>;
  vault_secret_ref: string;
  cred_version: number;
  org_id: string | null;
  owner_id: string | null;
};

function createFakeConnectionsClient(rows: FakeRow[]): SupabaseClient {
  function makeQuery(filters: Array<(row: FakeRow) => boolean>) {
    return {
      eq: (col: keyof FakeRow, val: unknown) => makeQuery([...filters, (row) => row[col] === val]),
      is: (col: keyof FakeRow, val: null) => makeQuery([...filters, (row) => row[col] === val]),
      maybeSingle: async () => {
        const match = rows.find((row) => filters.every((f) => f(row)));
        return { data: match ?? null, error: null };
      },
    };
  }

  return {
    from: (table: string) => {
      if (table !== "connections") throw new Error(`unexpected table "${table}" in fake`);
      return { select: () => makeQuery([]) };
    },
  } as unknown as SupabaseClient;
}

describe("getConnectionSchema — workspace-scoped access", () => {
  it("org-scoped connection: a different org gets 404, never the schema", async () => {
    const supabase = createFakeConnectionsClient([
      { id: "conn-1", connector_id: "mysql", config: {}, vault_secret_ref: "ref-1", cred_version: 1, org_id: "org-A", owner_id: null },
    ]);

    await expect(getConnectionSchema(supabase, { orgId: "org-B" }, "conn-1")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
  });

  it("personal-workspace connection: a different owner gets 404, never the schema", async () => {
    const supabase = createFakeConnectionsClient([
      { id: "conn-2", connector_id: "mysql", config: {}, vault_secret_ref: "ref-2", cred_version: 1, org_id: null, owner_id: "user-A" },
    ]);

    await expect(getConnectionSchema(supabase, { ownerId: "user-B" }, "conn-2")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
  });

  it("personal-workspace connection: an org actor (any org) gets 404, never the schema", async () => {
    const supabase = createFakeConnectionsClient([
      { id: "conn-3", connector_id: "mysql", config: {}, vault_secret_ref: "ref-3", cred_version: 1, org_id: null, owner_id: "user-A" },
    ]);

    await expect(getConnectionSchema(supabase, { orgId: "org-A" }, "conn-3")).rejects.toBeInstanceOf(AppError);
  });

  it("matching scope: the row is found and its (cached) schema is returned", async () => {
    const supabase = createFakeConnectionsClient([
      { id: "conn-4", connector_id: "mysql", config: {}, vault_secret_ref: "ref-4", cred_version: 1, org_id: "org-A", owner_id: null },
    ]);
    const schema: IntrospectResponse = { entities: [] };
    // Pre-populate the cache so the assertion proves the workspace-scoped
    // row lookup succeeded and reached the cache read, without needing to
    // mock dispatchIntrospect's real connector I/O.
    setCachedSchema({ connectionId: "conn-4", credVersion: 1, vaultRef: "ref-4" }, schema);

    await expect(getConnectionSchema(supabase, { orgId: "org-A" }, "conn-4")).resolves.toEqual(schema);
  });
});
