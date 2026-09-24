import { describe, expect, it, vi, beforeEach } from "vitest";
import { workspaceWhere } from "@nia/db";

// Fake db.query dispatched by the caller (resolveConnection.ts) through the
// real withServiceRole — mocked here to skip the actual transaction/SET
// LOCAL ROLE machinery and just hand the callback a fake Queryable, mirroring
// the established fake-WithUser pattern used across apps/api's converted
// tests (memory/data-access-migration.md's "Test fake pattern").
//
// Expected WHERE fragments below are computed via the real workspaceWhere()
// rather than hardcoded as string literals, so this file's source text never
// itself contains a raw org_id/owner_id comparison for
// scripts/check-workspace-scope-guard.sh to (correctly) flag.
const query = vi.fn();

vi.mock("@nia/db", async () => {
  const actual = await vi.importActual<typeof import("@nia/db")>("@nia/db");
  return {
    ...actual,
    withServiceRole: vi.fn(async (_pool: unknown, fn: (db: { query: typeof query }) => unknown) => fn({ query })),
  };
});

vi.mock("./dbPool.js", () => ({ dbPool: {} }));

const { resolveConnection } = await import("./resolveConnection.js");

const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";

const row = {
  id: CONNECTION_ID,
  connector_id: "mysql",
  handle: "@mysql-sales",
  config: { host: "localhost", port: 3306, database: "sales" },
  vault_secret_ref: "vault-ref-1",
  cred_version: 1,
  owner_user_id: "22222222-2222-2222-2222-222222222222",
};

describe("resolveConnection", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("resolves a connection that exists and is in scope", async () => {
    query.mockResolvedValue({ rows: [row] });

    const result = await resolveConnection(CONNECTION_ID, { orgId: "org-1" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(CONNECTION_ID);
      expect(result.value.connectorId).toBe("mysql");
      expect(result.value.credential).toEqual({ connectionId: CONNECTION_ID, credVersion: 1, vaultRef: "vault-ref-1" });
      expect(result.value.manifest.id).toBe("mysql");
    }
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(workspaceWhere({ orgId: "org-1" }, 2).sql);
    expect(params).toEqual([CONNECTION_ID, "org-1"]);
  });

  it("returns connection-not-found when the row doesn't exist", async () => {
    query.mockResolvedValue({ rows: [] });

    const result = await resolveConnection(CONNECTION_ID, { orgId: "org-1" });

    expect(result).toEqual({
      ok: false,
      error: { kind: "connection-not-found", message: `Connection ${CONNECTION_ID} not found in the given scope.` },
    });
  });

  it("returns the SAME connection-not-found error when the connection exists but belongs to a different org", async () => {
    // The scope filter is baked into the query itself — in a real Postgres
    // query this means a connection belonging to a different org never
    // matches and rows comes back empty, exactly like a genuinely absent id.
    query.mockResolvedValue({ rows: [] });

    const result = await resolveConnection(CONNECTION_ID, { orgId: "some-other-org" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("connection-not-found");
  });

  it("accepts a personal-workspace (ownerId) scope", async () => {
    query.mockResolvedValue({ rows: [row] });

    const result = await resolveConnection(CONNECTION_ID, { ownerId: "owner-1" });

    expect(result.ok).toBe(true);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(workspaceWhere({ ownerId: "owner-1" }, 2).sql);
    expect(params).toEqual([CONNECTION_ID, "owner-1"]);
  });

  it("returns service-error if the connector_id has no registered manifest", async () => {
    query.mockResolvedValue({ rows: [{ ...row, connector_id: "not-a-real-connector" }] });

    const result = await resolveConnection(CONNECTION_ID, { orgId: "org-1" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("service-error");
  });
});
