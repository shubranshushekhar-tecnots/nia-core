import { describe, expect, it, vi, beforeEach } from "vitest";

// Chainable mock query builder mimicking the subset of the supabase-js
// fluent API resolveWriteGrant.ts actually calls:
// .from().select().eq().not().is().order() — the last call resolves the
// chain, mirroring how resolveConnection.test.ts mocks .maybeSingle().
let orderResult: { data: unknown };
const builder: Record<string, unknown> = {};
builder.select = vi.fn(() => builder);
builder.eq = vi.fn(() => builder);
builder.not = vi.fn(() => builder);
builder.is = vi.fn(() => builder);
builder.order = vi.fn(() => Promise.resolve(orderResult));
const from = vi.fn((..._args: unknown[]) => builder);

vi.mock("./supabaseClient.js", () => ({
  supabase: { from: (...args: unknown[]) => from(...args) },
}));

const { resolveWriteGrant } = await import("./resolveWriteGrant.js");

const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "grant-1",
    cred_version: 1,
    write_credential_vault_ref: "vault-ref-write-1",
    scope: { schemas: ["sales"] },
    ...overrides,
  };
}

describe("resolveWriteGrant", () => {
  beforeEach(() => {
    from.mockClear();
    (builder.select as ReturnType<typeof vi.fn>).mockClear();
    (builder.eq as ReturnType<typeof vi.fn>).mockClear();
    (builder.not as ReturnType<typeof vi.fn>).mockClear();
    (builder.is as ReturnType<typeof vi.fn>).mockClear();
    (builder.order as ReturnType<typeof vi.fn>).mockClear();
    orderResult = { data: [] };
  });

  it("resolves a grant whose scope.schemas includes the requested namespace", async () => {
    orderResult = { data: [row()] };

    const result = await resolveWriteGrant(CONNECTION_ID, "sales");

    expect(result).toEqual({
      ok: true,
      value: { grantId: "grant-1", credVersion: 1, vaultRef: "vault-ref-write-1" },
    });
    expect(builder.eq).toHaveBeenCalledWith("connection_id", CONNECTION_ID);
    expect(builder.not).toHaveBeenCalledWith("confirmed_at", "is", null);
    expect(builder.is).toHaveBeenCalledWith("revoked_at", null);
  });

  it("returns grant-invalid when no row's scope covers the namespace", async () => {
    orderResult = { data: [row({ scope: { schemas: ["marketing"] } })] };

    const result = await resolveWriteGrant(CONNECTION_ID, "sales");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("grant-invalid");
      expect(result.error.message).toMatch(/No confirmed, unrevoked write grant covers schema "sales"/);
    }
  });

  it("returns grant-invalid when there are no rows at all", async () => {
    orderResult = { data: [] };

    const result = await resolveWriteGrant(CONNECTION_ID, "sales");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("grant-invalid");
  });

  it("returns grant-invalid when data is null", async () => {
    orderResult = { data: null };

    const result = await resolveWriteGrant(CONNECTION_ID, "sales");

    expect(result.ok).toBe(false);
  });

  it("picks the first matching row when multiple grants exist (already ordered granted_at desc by the query)", async () => {
    orderResult = {
      data: [
        row({ id: "grant-newest", cred_version: 2, write_credential_vault_ref: "vault-ref-2", scope: { schemas: ["sales"] } }),
        row({ id: "grant-oldest", cred_version: 1, write_credential_vault_ref: "vault-ref-1", scope: { schemas: ["sales"] } }),
      ],
    };

    const result = await resolveWriteGrant(CONNECTION_ID, "sales");

    expect(result).toEqual({
      ok: true,
      value: { grantId: "grant-newest", credVersion: 2, vaultRef: "vault-ref-2" },
    });
  });

  it("returns grant-invalid when the matching row has no write_credential_vault_ref", async () => {
    orderResult = { data: [row({ write_credential_vault_ref: null })] };

    const result = await resolveWriteGrant(CONNECTION_ID, "sales");

    expect(result.ok).toBe(false);
  });
});
