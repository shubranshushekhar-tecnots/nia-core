import { describe, it, expect } from "vitest";
import type { WithUser } from "../lib/withUser.js";
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
 * Hand-rolled fake WithUser, same style as grants.test.ts: filters an
 * in-memory row set by id plus whichever workspaceWhere() branch the real
 * query text encodes (`org_id = $2` vs `org_id is null and owner_id = $2`),
 * so the actual scope branching inside getConnectionSchema is exercised for
 * real, not mocked around.
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

function createFakeWithUser(rows: FakeRow[]): WithUser {
  return (async (fn) =>
    fn({
      query: async (text: string, params: readonly unknown[] = []) => {
        if (!text.includes("from connections")) throw new Error(`unexpected query in fake: ${text}`);
        const id = params[0] as string;
        const scopeParam = params[1] as string;
        const matches = rows.filter((row) => {
          if (row.id !== id) return false;
          if (text.includes("org_id = $2")) return row.org_id === scopeParam;
          if (text.includes("org_id is null and owner_id = $2")) return row.org_id === null && row.owner_id === scopeParam;
          throw new Error(`unrecognized where clause in fake: ${text}`);
        });
        return { rows: matches } as never;
      },
    })) as WithUser;
}

describe("getConnectionSchema — workspace-scoped access", () => {
  it("org-scoped connection: a different org gets 404, never the schema", async () => {
    const withUser = createFakeWithUser([
      { id: "conn-1", connector_id: "mysql", config: {}, vault_secret_ref: "ref-1", cred_version: 1, org_id: "org-A", owner_id: null },
    ]);

    await expect(getConnectionSchema(withUser, { orgId: "org-B" }, "conn-1")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
  });

  it("personal-workspace connection: a different owner gets 404, never the schema", async () => {
    const withUser = createFakeWithUser([
      { id: "conn-2", connector_id: "mysql", config: {}, vault_secret_ref: "ref-2", cred_version: 1, org_id: null, owner_id: "user-A" },
    ]);

    await expect(getConnectionSchema(withUser, { ownerId: "user-B" }, "conn-2")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
  });

  it("personal-workspace connection: an org actor (any org) gets 404, never the schema", async () => {
    const withUser = createFakeWithUser([
      { id: "conn-3", connector_id: "mysql", config: {}, vault_secret_ref: "ref-3", cred_version: 1, org_id: null, owner_id: "user-A" },
    ]);

    await expect(getConnectionSchema(withUser, { orgId: "org-A" }, "conn-3")).rejects.toBeInstanceOf(AppError);
  });

  it("matching scope: the row is found and its (cached) schema is returned", async () => {
    const withUser = createFakeWithUser([
      { id: "conn-4", connector_id: "mysql", config: {}, vault_secret_ref: "ref-4", cred_version: 1, org_id: "org-A", owner_id: null },
    ]);
    const schema: IntrospectResponse = { entities: [] };
    // Pre-populate the cache so the assertion proves the workspace-scoped
    // row lookup succeeded and reached the cache read, without needing to
    // mock dispatchIntrospect's real connector I/O.
    setCachedSchema({ connectionId: "conn-4", credVersion: 1, vaultRef: "ref-4" }, schema);

    await expect(getConnectionSchema(withUser, { orgId: "org-A" }, "conn-4")).resolves.toEqual(schema);
  });
});
