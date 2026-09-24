import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, parseMasterKey } from "@nia/secrets";
import { createConnection, updateConnection } from "./connections.js";

// getSecretStore (../lib/secretStore.js) does real envelope encryption
// against NIA_SECRET_MASTER_KEY (fixed test value from vitest.config.ts) —
// used below to decrypt what the fakes' nia_secrets table actually stored,
// rather than inspecting an RPC call's args as the pre-migration tests did.
const TEST_MASTER_KEY = parseMasterKey(process.env.NIA_SECRET_MASTER_KEY);

/**
 * updateConnection's edit flow (see connections.ts's header comment on the
 * function): splitFieldsForEdit never requires a secret field, so leaving
 * user/password blank must mean "keep the stored value" — merge_connector_secret
 * is only called when a secret field actually has a new value. Any config or
 * secret change rotates cred_version and must invalidate the connector's warm
 * pool (dispatchInvalidate) so the change takes effect immediately, not on
 * the pool's next idle-evict.
 *
 * dispatchTest/dispatchInvalidate hit a real connector service over HTTP
 * (connectorDispatch.ts) — mocked at the module boundary here rather than
 * stubbing global.fetch for two different endpoints (no existing convention
 * for either in this file specifically; connectorDispatch.test.ts stubs
 * fetch directly, but that's testing connectorDispatch.ts itself).
 */
vi.mock("../lib/connectorDispatch.js", () => ({
  dispatchTest: vi.fn(async () => ({ ok: true, latencyMs: 5 })),
  dispatchInvalidate: vi.fn(async () => undefined),
}));

import { dispatchTest, dispatchInvalidate } from "../lib/connectorDispatch.js";

type FakeConnectionRow = {
  id: string;
  connector_id: string;
  handle: string;
  display_name: string;
  owner_user_id: string;
  config: Record<string, unknown>;
  vault_secret_ref: string;
  cred_version: number;
  last_test_status: null;
  last_test_latency_ms: null;
  last_test_at: null;
  last_used_at: null;
  created_at: string;
  updated_at: string;
  org_id: string | null;
  owner_id: string | null;
};

function baseRow(overrides: Partial<FakeConnectionRow> = {}): FakeConnectionRow {
  return {
    id: "conn-1",
    connector_id: "mysql",
    handle: "@mysql-x",
    display_name: "X",
    owner_user_id: "user-1",
    config: { host: "old-host", port: 3306, database: "sandbox" },
    vault_secret_ref: "old-ref",
    cred_version: 1,
    last_test_status: null,
    last_test_latency_ms: null,
    last_test_at: null,
    last_used_at: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    org_id: "org-A",
    owner_id: null,
    ...overrides,
  };
}

/**
 * Records rpc calls and services connections.ts's select-existing /
 * update-and-return chains, matching the real query shape it builds (see
 * updateConnection's body). Also backs a minimal in-memory nia_secrets
 * table for getSecretStore's put/get/delete (packages/secrets/src/store.ts)
 * — baseRow's "old-ref" is treated as a pre-migration ref never present in
 * nia_secrets, so a get() on it falls through to legacyResolve
 * (decrypt_connector_secret_for_edit), mirroring
 * apps/api/src/lib/secretStore.ts's real wiring exactly.
 */
function createFakeClient(row: FakeConnectionRow) {
  const rpcCalls: { name: string; args: unknown }[] = [];
  const secretRows = new Map<string, Record<string, unknown>>();
  let nextSecretId = 1;

  function chain(kind: "existing" | "update", patch?: Record<string, unknown>): unknown {
    return {
      eq: () => chain(kind, patch),
      is: () => chain(kind, patch),
      maybeSingle: async () => ({ data: row, error: null }),
      select: () => ({
        single: async () => ({ data: { ...row, ...patch }, error: null }),
      }),
    };
  }

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
          select: () => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: async () => {
                const stored = secretRows.get(id);
                return { data: stored ? { id, ...stored } : null, error: null };
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
      if (table !== "connections") throw new Error(`unexpected table "${table}" in fake`);
      return {
        select: () => chain("existing"),
        update: (patch: Record<string, unknown>) => chain("update", patch),
      };
    },
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      if (name === "log_connection_audit") return { data: null, error: null };
      if (name === "decrypt_connector_secret_for_edit") {
        return { data: { user: "old-user", password: "old-password" }, error: null };
      }
      throw new Error(`unexpected rpc "${name}" in fake`);
    },
  } as unknown as SupabaseClient;

  return { supabase, rpcCalls, secretRows };
}

describe("updateConnection — edit flow", () => {
  beforeEach(() => {
    vi.mocked(dispatchTest).mockClear();
    vi.mocked(dispatchInvalidate).mockClear();
  });

  it("leaves the stored secret untouched when user/password are left blank", async () => {
    const row = baseRow();
    const { supabase, secretRows } = createFakeClient(row);

    const result = await updateConnection(supabase, { orgId: "org-A" }, "conn-1", "actor-1", {
      fields: { host: "new-host", port: 3306, database: "sandbox", user: "", password: "" },
      confirmed: true,
    });

    // An empty secretPatch means updateConnection never touches the
    // SecretStore at all (see connections.ts's `if (Object.keys(secretPatch).length > 0)` guard).
    expect(secretRows.size).toBe(0);
    expect(result.config).toMatchObject({ host: "new-host" });
    // config changed (host) -> cred_version still bumps and the pool is invalidated,
    // even though no secret field was touched.
    expect(dispatchInvalidate).toHaveBeenCalledTimes(1);
  });

  it("rotates only the provided secret field and invalidates the pool", async () => {
    const row = baseRow();
    const { supabase, rpcCalls, secretRows } = createFakeClient(row);

    await updateConnection(supabase, { orgId: "org-A" }, "conn-1", "actor-1", {
      fields: { host: "old-host", port: 3306, database: "sandbox", user: "", password: "new-password" },
      confirmed: true,
    });

    // The merge-in-API path (docs/plans/secret-storage.md's update-path
    // report): the old secret is read via legacyResolve (asserted via the
    // decrypt_connector_secret_for_edit rpc call below), merged with the
    // patch in memory, and written as a brand-new nia_secrets row — decrypt
    // it to confirm only "password" changed and "user" carried over.
    expect(secretRows.size).toBe(1);
    const [storedRow] = [...secretRows.values()] as [Record<string, unknown>];
    const encrypted = {
      ciphertext: storedRow.ciphertext as string,
      encryptedDataKey: storedRow.encrypted_data_key as string,
      iv: storedRow.iv as string,
      authTag: storedRow.auth_tag as string,
      algorithm: storedRow.algorithm as string,
      keyVersion: storedRow.key_version as number,
    };
    expect(decryptSecret(TEST_MASTER_KEY, encrypted)).toEqual({ user: "old-user", password: "new-password" });
    expect(rpcCalls.find((c) => c.name === "decrypt_connector_secret_for_edit")?.args).toEqual({ p_ref: "old-ref" });
    expect(dispatchInvalidate).toHaveBeenCalledTimes(1);

    const auditCall = rpcCalls.find((c) => c.name === "log_connection_audit");
    expect(auditCall?.args).toMatchObject({ p_action: "connection.updated", p_detail: { changedFields: ["password"] } });
  });

  it("does not call dispatchInvalidate when only the display name changes", async () => {
    const row = baseRow();
    const { supabase } = createFakeClient(row);

    await updateConnection(supabase, { orgId: "org-A" }, "conn-1", "actor-1", {
      displayName: "New name",
      fields: { host: "old-host", port: 3306, database: "sandbox", user: "", password: "" },
      confirmed: true,
    });

    expect(dispatchInvalidate).not.toHaveBeenCalled();
  });
});

/**
 * Item 4.2 fix (fix-chain plan): `splitFields`/`splitFieldsForEdit` never
 * trimmed or validated `host` server-side — only the web form did
 * (apps/web/src/lib/connections/actions.ts), which isn't the trust
 * boundary. This exercises createConnection's rejection path directly; the
 * fake client only implements the `connector_installs` install-check query
 * since the invalid-field rejection happens before any other query runs.
 */
describe("createConnection — Item 4.2 server-side host validation", () => {
  function fakeInstallCheckClient(): SupabaseClient {
    const installsStub: { eq: () => typeof installsStub; is: () => typeof installsStub; then: (resolve: (v: { count: number; data: null; error: null }) => void) => void } = {
      eq: () => installsStub,
      is: () => installsStub,
      then: (resolve) => resolve({ count: 1, data: null, error: null }),
    };
    return {
      from: (table: string) => {
        if (table !== "connector_installs") {
          throw new Error(`unexpected table "${table}" — this fake only supports the install-check query.`);
        }
        return { select: () => installsStub };
      },
      rpc: vi.fn(),
    } as unknown as SupabaseClient;
  }

  it("rejects a host value containing whitespace with INVALID_FIELD", async () => {
    const supabase = fakeInstallCheckClient();
    await expect(
      createConnection(supabase, { orgId: "org-A" }, "user-1", {
        connectorId: "postgres",
        displayName: "Test",
        fields: { host: "db .example.com", port: 5432, database: "postgres", user: "nia_ro", password: "pw" },
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_FIELD" });
  });

  it("rejects a host value containing characters outside [a-zA-Z0-9.-]", async () => {
    const supabase = fakeInstallCheckClient();
    await expect(
      createConnection(supabase, { orgId: "org-A" }, "user-1", {
        connectorId: "postgres",
        displayName: "Test",
        fields: { host: "db.example.com/../etc", port: 5432, database: "postgres", user: "nia_ro", password: "pw" },
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_FIELD" });
  });
});

/**
 * Item 6.1 (fix-chain plan): connections_scope_display_name_unique_idx
 * (0029_connection_name_unique.sql) raises 23505 on a duplicate display_name
 * within the same scope. createConnection's handle-collision retry loop
 * (MAX_HANDLE_ATTEMPTS) also catches 23505, so this must be surfaced as
 * NAME_TAKEN on the very first attempt rather than being misdiagnosed as a
 * handle collision and retried until HANDLE_EXHAUSTED — the fake's insert
 * always returns this error, so a passing test proves no retry happened
 * (only one insert attempt is wired up).
 */
describe("createConnection — Item 6.1 NAME_TAKEN", () => {
  function fakeNameTakenClient(): SupabaseClient {
    const installsStub: { eq: () => typeof installsStub; is: () => typeof installsStub; then: (resolve: (v: { count: number; data: null; error: null }) => void) => void } = {
      eq: () => installsStub,
      is: () => installsStub,
      then: (resolve) => resolve({ count: 1, data: null, error: null }),
    };
    return {
      from: (table: string) => {
        if (table === "connector_installs") return { select: () => installsStub };
        if (table === "nia_secrets") {
          // createConnection's getSecretStore(supabase).put(...) runs before
          // the connections insert below — this test only cares about the
          // NAME_TAKEN error path that follows, so a bare insert stub is enough.
          return {
            insert: () => ({
              select: () => ({
                single: async () => ({ data: { id: "secret-1" }, error: null }),
              }),
            }),
          };
        }
        if (table === "connections") {
          return {
            insert: () => ({
              select: () => ({
                single: async () => ({
                  data: null,
                  error: {
                    code: "23505",
                    message: 'duplicate key value violates unique constraint "connections_scope_display_name_unique_idx"',
                  },
                }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table "${table}" in fake`);
      },
      rpc: async (name: string) => {
        throw new Error(`unexpected rpc "${name}" in fake`);
      },
    } as unknown as SupabaseClient;
  }

  it("surfaces a display-name-uniqueness violation as NAME_TAKEN, not HANDLE_EXHAUSTED", async () => {
    const supabase = fakeNameTakenClient();
    await expect(
      createConnection(supabase, { orgId: "org-A" }, "user-1", {
        connectorId: "mysql",
        displayName: "Duplicate Name",
        fields: { host: "db.example.com", port: 3306, database: "sandbox", user: "nia_ro", password: "pw" },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "NAME_TAKEN" });
  });
});
