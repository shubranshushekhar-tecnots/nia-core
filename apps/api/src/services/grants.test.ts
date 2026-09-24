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

/**
 * Also backs a minimal in-memory nia_secrets table for getSecretStore's
 * put/delete (packages/secrets/src/store.ts) — confirmWriteGrant only ever
 * writes a brand-new credential here (never reads an existing one), so no
 * select/get support is needed, unlike connections.test.ts's fake.
 */
function createFakeClient(existingGrantCredVersions: number[]) {
  const rpcCalls: { name: string; args: unknown }[] = [];
  const secretRows = new Map<string, Record<string, unknown>>();
  let nextSecretId = 1;

  const supabase = {
    from: (table: string) => {
      if (table === "nia_secrets") {
        return {
          insert: (secretRow: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                const id = `secret-${nextSecretId++}`;
                secretRows.set(id, secretRow);
                return { data: { id }, error: null };
              },
            }),
          }),
          delete: () => ({
            eq: async (_col: string, id: string) => {
              secretRows.delete(id);
              return { error: null };
            },
          }),
        };
      }
      if (table !== "write_grants") throw new Error(`unexpected table "${table}" in fake`);
      return {
        select: () => ({
          eq: async () => ({ data: existingGrantCredVersions.map((cred_version) => ({ cred_version })), error: null }),
        }),
      };
    },
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
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

  return { supabase, rpcCalls, secretRows };
}

describe("confirmWriteGrant — test-connects before confirming", () => {
  beforeEach(() => {
    vi.mocked(dispatchTest).mockClear();
    vi.mocked(dispatchInvalidate).mockClear();
  });

  it("test-connects the new credential and confirms on success", async () => {
    const { supabase, rpcCalls, secretRows } = createFakeClient([1]);

    const result = await confirmWriteGrant(supabase, { orgId: "org-A" }, "conn-1", "grant-1", {
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
    expect(rpcCalls.map((c) => c.name)).toEqual(["confirm_write_grant"]);
    expect(rpcCalls.find((c) => c.name === "confirm_write_grant")?.args).toMatchObject({
      p_write_role_name: "writer",
      p_write_credential_vault_ref: "secret-1",
    });
    expect(result.confirmedAt).not.toBeNull();
    expect(result.writeRoleName).toBe("writer");
  });

  it("rolls back the Vault write and never confirms when the test fails", async () => {
    vi.mocked(dispatchTest).mockResolvedValueOnce({ ok: false, error: { message: "ECONNREFUSED", details: "ECONNREFUSED" } });
    const { supabase, rpcCalls, secretRows } = createFakeClient([]);

    await expect(
      confirmWriteGrant(supabase, { orgId: "org-A" }, "conn-1", "grant-1", { user: "writer", password: "wrong" }),
    ).rejects.toMatchObject({ code: "WRITE_GRANT_TEST_FAILED" });

    // Written then rolled back via secretStore.delete(vaultRef) — nothing
    // left behind, and confirm_write_grant is never reached.
    expect(secretRows.size).toBe(0);
    expect(rpcCalls.map((c) => c.name)).toEqual([]);
  });
});
