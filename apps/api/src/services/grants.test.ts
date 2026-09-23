import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
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

function createFakeClient(existingGrantCredVersions: number[]) {
  const rpcCalls: { name: string; args: unknown }[] = [];

  const supabase = {
    from: (table: string) => {
      if (table !== "write_grants") throw new Error(`unexpected table "${table}" in fake`);
      return {
        select: () => ({
          eq: async () => ({ data: existingGrantCredVersions.map((cred_version) => ({ cred_version })), error: null }),
        }),
      };
    },
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      if (name === "create_connector_secret") return { data: "new-vault-ref", error: null };
      if (name === "delete_connector_secret") return { data: null, error: null };
      if (name === "confirm_write_grant") {
        return {
          data: {
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
          error: null,
        };
      }
      throw new Error(`unexpected rpc "${name}" in fake`);
    },
  } as unknown as SupabaseClient;

  return { supabase, rpcCalls };
}

describe("confirmWriteGrant — test-connects before confirming", () => {
  beforeEach(() => {
    vi.mocked(dispatchTest).mockClear();
    vi.mocked(dispatchInvalidate).mockClear();
  });

  it("test-connects the new credential and confirms on success", async () => {
    const { supabase, rpcCalls } = createFakeClient([1]);

    const result = await confirmWriteGrant(supabase, { orgId: "org-A" }, "conn-1", "grant-1", {
      user: "writer",
      password: "secret",
    });

    expect(dispatchTest).toHaveBeenCalledWith(
      expect.anything(),
      { connectionId: "conn-1", credVersion: 2, vaultRef: "new-vault-ref" },
      { host: "sandbox-host", port: 3306, database: "sandbox" },
    );
    expect(dispatchInvalidate).toHaveBeenCalledTimes(1);
    expect(rpcCalls.map((c) => c.name)).toEqual(["create_connector_secret", "confirm_write_grant"]);
    expect(rpcCalls.find((c) => c.name === "confirm_write_grant")?.args).toMatchObject({ p_write_role_name: "writer" });
    expect(result.confirmedAt).not.toBeNull();
    expect(result.writeRoleName).toBe("writer");
  });

  it("rolls back the Vault write and never confirms when the test fails", async () => {
    vi.mocked(dispatchTest).mockResolvedValueOnce({ ok: false, error: { message: "ECONNREFUSED", details: "ECONNREFUSED" } });
    const { supabase, rpcCalls } = createFakeClient([]);

    await expect(
      confirmWriteGrant(supabase, { orgId: "org-A" }, "conn-1", "grant-1", { user: "writer", password: "wrong" }),
    ).rejects.toMatchObject({ code: "WRITE_GRANT_TEST_FAILED" });

    expect(rpcCalls.map((c) => c.name)).toEqual(["create_connector_secret", "delete_connector_secret"]);
  });
});
