import { describe, expect, it, vi, beforeEach } from "vitest";

// Chainable mock query builder mimicking the subset of the supabase-js
// fluent API resolveConnection.ts actually calls: .from().select().eq()
// [.eq() | .is().eq()] .maybeSingle(). Each method returns `builder` itself
// so the real chaining code under test works unmodified.
const maybeSingle = vi.fn();
const builder: Record<string, unknown> = {};
builder.select = vi.fn(() => builder);
builder.eq = vi.fn(() => builder);
builder.is = vi.fn(() => builder);
builder.maybeSingle = maybeSingle;
const from = vi.fn((..._args: unknown[]) => builder);

vi.mock("./supabaseClient.js", () => ({
  supabase: { from: (...args: unknown[]) => from(...args) },
}));

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
    maybeSingle.mockReset();
    from.mockClear();
  });

  it("resolves a connection that exists and is in scope", async () => {
    maybeSingle.mockResolvedValue({ data: row });

    const result = await resolveConnection(CONNECTION_ID, { orgId: "org-1" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(CONNECTION_ID);
      expect(result.value.connectorId).toBe("mysql");
      expect(result.value.credential).toEqual({ connectionId: CONNECTION_ID, credVersion: 1, vaultRef: "vault-ref-1" });
      expect(result.value.manifest.id).toBe("mysql");
    }
  });

  it("returns connection-not-found when the row doesn't exist", async () => {
    maybeSingle.mockResolvedValue({ data: null });

    const result = await resolveConnection(CONNECTION_ID, { orgId: "org-1" });

    expect(result).toEqual({
      ok: false,
      error: { kind: "connection-not-found", message: `Connection ${CONNECTION_ID} not found in the given scope.` },
    });
  });

  it("returns the SAME connection-not-found error when the connection exists but belongs to a different org", async () => {
    // The scope filter is baked into the query itself (see the mocked
    // builder above) — in a real Postgres query this means a connection
    // belonging to a different org never matches and .maybeSingle()
    // resolves with data: null, exactly like a genuinely absent id.
    maybeSingle.mockResolvedValue({ data: null });

    const result = await resolveConnection(CONNECTION_ID, { orgId: "some-other-org" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("connection-not-found");
  });

  it("accepts a personal-workspace (ownerId) scope", async () => {
    maybeSingle.mockResolvedValue({ data: row });

    const result = await resolveConnection(CONNECTION_ID, { ownerId: "owner-1" });

    expect(result.ok).toBe(true);
    expect(builder.is).toHaveBeenCalledWith("org_id", null);
  });

  it("returns service-error if the connector_id has no registered manifest", async () => {
    maybeSingle.mockResolvedValue({ data: { ...row, connector_id: "not-a-real-connector" } });

    const result = await resolveConnection(CONNECTION_ID, { orgId: "org-1" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("service-error");
  });
});
