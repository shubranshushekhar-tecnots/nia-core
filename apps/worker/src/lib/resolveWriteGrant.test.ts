import { describe, expect, it, vi, beforeEach } from "vitest";

// Fake db.query dispatched by the caller (resolveWriteGrant.ts) through the
// real withServiceRole — mocked here to skip the actual transaction/SET
// LOCAL ROLE machinery, mirroring resolveConnection.test.ts.
const query = vi.fn();

vi.mock("@nia/db", async () => {
  const actual = await vi.importActual<typeof import("@nia/db")>("@nia/db");
  return {
    ...actual,
    withServiceRole: vi.fn(async (_pool: unknown, fn: (db: { query: typeof query }) => unknown) => fn({ query })),
  };
});

vi.mock("./dbPool.js", () => ({ dbPool: {} }));

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
    query.mockReset();
  });

  it("resolves a grant whose scope.schemas includes the requested namespace", async () => {
    query.mockResolvedValue({ rows: [row()] });

    const result = await resolveWriteGrant(CONNECTION_ID, "sales");

    expect(result).toEqual({
      ok: true,
      value: { grantId: "grant-1", credVersion: 1, vaultRef: "vault-ref-write-1" },
    });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("connection_id = $1");
    expect(sql).toContain("confirmed_at is not null");
    expect(sql).toContain("revoked_at is null");
    expect(sql).toContain("order by granted_at desc");
    expect(params).toEqual([CONNECTION_ID]);
  });

  it("returns grant-invalid when no row's scope covers the namespace", async () => {
    query.mockResolvedValue({ rows: [row({ scope: { schemas: ["marketing"] } })] });

    const result = await resolveWriteGrant(CONNECTION_ID, "sales");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("grant-invalid");
      expect(result.error.message).toMatch(/No confirmed, unrevoked write grant covers schema "sales"/);
    }
  });

  it("returns grant-invalid when there are no rows at all", async () => {
    query.mockResolvedValue({ rows: [] });

    const result = await resolveWriteGrant(CONNECTION_ID, "sales");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("grant-invalid");
  });

  it("picks the first matching row when multiple grants exist (already ordered granted_at desc by the query)", async () => {
    query.mockResolvedValue({
      rows: [
        row({ id: "grant-newest", cred_version: 2, write_credential_vault_ref: "vault-ref-2", scope: { schemas: ["sales"] } }),
        row({ id: "grant-oldest", cred_version: 1, write_credential_vault_ref: "vault-ref-1", scope: { schemas: ["sales"] } }),
      ],
    });

    const result = await resolveWriteGrant(CONNECTION_ID, "sales");

    expect(result).toEqual({
      ok: true,
      value: { grantId: "grant-newest", credVersion: 2, vaultRef: "vault-ref-2" },
    });
  });

  it("returns grant-invalid when the matching row has no write_credential_vault_ref", async () => {
    query.mockResolvedValue({ rows: [row({ write_credential_vault_ref: null })] });

    const result = await resolveWriteGrant(CONNECTION_ID, "sales");

    expect(result.ok).toBe(false);
  });
});
