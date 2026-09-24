import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WithUser } from "../lib/withUser.js";
import { confirmWriteGrant } from "./grants.js";

/**
 * confirmWriteGrant must test-connect the freshly-stored write credential
 * (via dispatchTest, the same CredentialRef-only boundary updateConnection
 * uses) before ever calling confirm_write_grant. A failing test must roll
 * back the Vault write (delete_connector_secret) and never reach
 * confirm_write_grant — an untested/bad credential can never become the
 * confirmed one. dispatchTest/dispatchInvalidate hit a real connector
 * service over HTTP, mocked at the module boundary (same convention as
 * connections.test.ts).
 */
vi.mock("../lib/connectorDispatch.js", () => ({
  dispatchTest: vi.fn(async () => ({ ok: true, latencyMs: 5 })),
  dispatchInvalidate: vi.fn(async () => undefined),
}));
vi.mock("./connections.js", () => ({
  getConnection: vi.fn(async () => ({
    id: "conn-1",
    connectorId: "mysql",
    handle: "@mysql-x",
    displayName: "X",
    ownerUserId: "user-1",
    config: { host: "sandbox-host", port: 3306, database: "sandbox" },
    credVersion: 1,
    lastTestStatus: null,
    lastTestLatencyMs: null,
    lastTestAt: null,
    lastUsedAt: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  })),
}));

import { dispatchTest, dispatchInvalidate } from "../lib/connectorDispatch.js";

/**
 * Fake WithUser backing both grants.ts's raw SQL AND lib/secretStore.ts's
 * getSecretStore (now withUser-based too). Also backs a minimal in-memory
 * nia_secrets table for getSecretStore's put/delete — confirmWriteGrant
 * only ever writes a brand-new credential here (never reads an existing
 * one), so no select support is needed, unlike connections.test.ts's fake.
 */
function createFakeClient(existingGrantCredVersions: number[]) {
  const secretRows = new Map<string, Record<string, unknown>>();
  let nextSecretId = 1;

  const queries: { text: string; params: readonly unknown[] }[] = [];
  const withUser: WithUser = (async (fn) =>
    fn({
      query: async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (text.includes("select cred_version from write_grants")) {
          return { rows: existingGrantCredVersions.map((cred_version) => ({ cred_version })) } as never;
        }
        if (text.includes("insert into nia_secrets")) {
          const [ciphertext, encrypted_data_key, iv, auth_tag, algorithm, key_version] = params;
          const id = `secret-${nextSecretId++}`;
          secretRows.set(id, { ciphertext, encrypted_data_key, iv, auth_tag, algorithm, key_version });
          return { rows: [{ id }] } as never;
        }
        if (text.includes("delete from nia_secrets where id")) {
          secretRows.delete(params[0] as string);
          return { rows: [] } as never;
        }
        if (text.includes("confirm_write_grant")) {
          return {
            rows: [
              {
                id: "grant-1",
                connection_id: "conn-1",
                granted_by_user_id: "user-1",
                scope: {},
                granted_at: "2024-01-01T00:00:00Z",
                revoked_at: null,
                confirmed_at: "2024-01-02T00:00:00Z",
                cred_version: 2,
                write_credential_vault_ref: "new-vault-ref",
                write_role_name: "writer",
              },
            ],
          } as never;
        }
        throw new Error(`unexpected query: ${text}`);
      },
    })) as WithUser;

  return { withUser, queries, secretRows };
}

describe("confirmWriteGrant — test-connects before confirming", () => {
  beforeEach(() => {
    vi.mocked(dispatchTest).mockClear();
    vi.mocked(dispatchInvalidate).mockClear();
  });

  it("test-connects the new credential and confirms on success", async () => {
    const { withUser, queries, secretRows } = createFakeClient([1]);

    const result = await confirmWriteGrant(withUser, { orgId: "org-A" }, "conn-1", "grant-1", {
      user: "writer",
      password: "secret",
    });

    // secretStore.put(...) is the first (and only) id this fake ever hands
    // out, so the credential dispatchTest receives must carry it.
    expect(dispatchTest).toHaveBeenCalledWith(
      expect.anything(),
      { connectionId: "conn-1", credVersion: 2, vaultRef: "secret-1" },
      { host: "sandbox-host", port: 3306, database: "sandbox" },
    );
    expect(dispatchInvalidate).toHaveBeenCalledTimes(1);
    expect(secretRows.size).toBe(1);
    const confirmQuery = queries.find((q) => q.text.includes("confirm_write_grant"));
    expect(confirmQuery?.params).toEqual(["grant-1", "secret-1", "writer"]);
    expect(result.confirmedAt).not.toBeNull();
    expect(result.writeRoleName).toBe("writer");
  });

  it("rolls back the Vault write and never confirms when the test fails", async () => {
    vi.mocked(dispatchTest).mockResolvedValueOnce({ ok: false, error: { message: "ECONNREFUSED", details: "ECONNREFUSED" } });
    const { withUser, queries, secretRows } = createFakeClient([]);

    await expect(
      confirmWriteGrant(withUser, { orgId: "org-A" }, "conn-1", "grant-1", { user: "writer", password: "wrong" }),
    ).rejects.toMatchObject({ code: "WRITE_GRANT_TEST_FAILED" });

    // Written then rolled back via secretStore.delete(vaultRef) — nothing
    // left behind, and confirm_write_grant is never reached.
    expect(secretRows.size).toBe(0);
    expect(queries.some((q) => q.text.includes("confirm_write_grant"))).toBe(false);
  });
});
