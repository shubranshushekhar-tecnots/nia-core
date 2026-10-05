import { createServer } from "node:http";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WithUser } from "../lib/withUser.js";
import { CURRENT_KEY_VERSION, decryptSecret, encryptSecret, parseMasterKey } from "@nia/secrets";
import { createConnection, getConnectionSchema, testConnection, updateConnection } from "./connections.js";

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
    ...overrides,
  };
}

/**
 * Extracts `col = $N` assignments from a raw `update ... set ... where`
 * statement and resolves each against `params`, mirroring what Postgres
 * itself would apply. Written generically (rather than hardcoding
 * connections.ts's exact SET clause list) so this fake stays correct as
 * updateConnection's set of conditionally-updated columns evolves.
 */
function parseSetClause(text: string, params: readonly unknown[]): Record<string, unknown> {
  const match = text.match(/set\s+([\s\S]+?)\s+where/i);
  if (!match?.[1]) return {};
  const patch: Record<string, unknown> = {};
  for (const assignment of match[1].split(",")) {
    const m = assignment.trim().match(/^(\w+)\s*=\s*\$(\d+)$/);
    if (!m?.[1] || !m[2]) continue;
    patch[m[1]] = params[Number(m[2]) - 1];
  }
  return patch;
}

/**
 * Fake WithUser backing both connections.ts's raw SQL AND
 * lib/secretStore.ts's getSecretStore (now withUser-based too, since
 * secretStore.ts no longer takes a SupabaseClient) — one fake in-memory
 * store per test, matching secretStore.ts's real nia_secrets SQL shapes
 * exactly: `... from nia_secrets where id = $1`, `insert into nia_secrets
 * (...) ... returning id`, `delete from nia_secrets where id = $1`.
 * baseRow's "old-ref" is pre-seeded into the fake's nia_secrets table below
 * (secretStore.ts no longer has a legacy-RPC fallback for pre-migration
 * refs — every ref must already live in nia_secrets, per the Vault-removal
 * backfill).
 */
function createFakeWithUser(row: FakeConnectionRow) {
  const queries: { text: string; params: readonly unknown[] }[] = [];
  const secretRows = new Map<string, Record<string, unknown>>();
  let nextSecretId = 1;

  const oldEncrypted = encryptSecret(TEST_MASTER_KEY, CURRENT_KEY_VERSION, { user: "old-user", password: "old-password" });
  secretRows.set(row.vault_secret_ref, {
    ciphertext: oldEncrypted.ciphertext,
    encrypted_data_key: oldEncrypted.encryptedDataKey,
    iv: oldEncrypted.iv,
    auth_tag: oldEncrypted.authTag,
    algorithm: oldEncrypted.algorithm,
    key_version: oldEncrypted.keyVersion,
  });

  const withUser: WithUser = (async (fn) =>
    fn({
      query: async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (text.includes("select") && text.includes("from connections where id")) {
          return { rows: [row] } as never;
        }
        if (text.includes("update connections set")) {
          const patch = parseSetClause(text, params);
          return { rows: [{ ...row, ...patch }] } as never;
        }
        if (text.includes("log_connection_audit")) {
          return { rows: [] } as never;
        }
        if (text.includes("insert into nia_secrets")) {
          const [ciphertext, encrypted_data_key, iv, auth_tag, algorithm, key_version] = params;
          const id = `secret-${nextSecretId++}`;
          secretRows.set(id, { ciphertext, encrypted_data_key, iv, auth_tag, algorithm, key_version });
          return { rows: [{ id }] } as never;
        }
        if (text.includes("from nia_secrets where id")) {
          const id = params[0] as string;
          const stored = secretRows.get(id);
          return { rows: stored ? [{ id, ...stored }] : [] } as never;
        }
        if (text.includes("delete from nia_secrets where id")) {
          secretRows.delete(params[0] as string);
          return { rows: [] } as never;
        }
        throw new Error(`unexpected query in fake: ${text}`);
      },
    })) as WithUser;
  return { withUser, queries, secretRows };
}

describe("updateConnection — edit flow", () => {
  beforeEach(() => {
    vi.mocked(dispatchTest).mockClear();
    vi.mocked(dispatchInvalidate).mockClear();
  });

  it("leaves the stored secret untouched when user/password are left blank", async () => {
    const row = baseRow();
    const { withUser, secretRows } = createFakeWithUser(row);

    const result = await updateConnection(withUser, { orgId: "org-A" }, "conn-1", "actor-1", {
      fields: { host: "new-host", port: 3306, database: "sandbox", user: "", password: "" },
      confirmed: true,
    });

    // An empty secretPatch means updateConnection never touches the
    // SecretStore at all (see connections.ts's `if (Object.keys(secretPatch).length > 0)` guard)
    // — secretRows still holds just the one pre-seeded row.vault_secret_ref entry.
    expect(secretRows.size).toBe(1);
    expect(result.config).toMatchObject({ host: "new-host" });
    // config changed (host) -> cred_version still bumps and the pool is invalidated,
    // even though no secret field was touched.
    expect(dispatchInvalidate).toHaveBeenCalledTimes(1);
  });

  it("rotates only the provided secret field and invalidates the pool", async () => {
    const row = baseRow();
    const { withUser, queries, secretRows } = createFakeWithUser(row);

    await updateConnection(withUser, { orgId: "org-A" }, "conn-1", "actor-1", {
      fields: { host: "old-host", port: 3306, database: "sandbox", user: "", password: "new-password" },
      confirmed: true,
    });

    // The merge-in-API path (docs/plans/secret-storage.md's update-path
    // report): the old secret is read from nia_secrets (pre-seeded by
    // createFakeWithUser under row.vault_secret_ref), merged with the patch
    // in memory, and written as a brand-new nia_secrets row — decrypt it to
    // confirm only "password" changed and "user" carried over.
    expect(secretRows.size).toBe(2);
    const storedRow = secretRows.get("secret-1") as Record<string, unknown>;
    const encrypted = {
      ciphertext: storedRow.ciphertext as string,
      encryptedDataKey: storedRow.encrypted_data_key as string,
      iv: storedRow.iv as string,
      authTag: storedRow.auth_tag as string,
      algorithm: storedRow.algorithm as string,
      keyVersion: storedRow.key_version as number,
    };
    expect(decryptSecret(TEST_MASTER_KEY, encrypted)).toEqual({ user: "old-user", password: "new-password" });
    expect(queries.some((q) => q.text.includes("from nia_secrets where id") && q.params[0] === row.vault_secret_ref)).toBe(true);
    expect(dispatchInvalidate).toHaveBeenCalledTimes(1);

    const auditQuery = queries.find((q) => q.text.includes("log_connection_audit"));
    expect(auditQuery?.params).toEqual(["conn-1", "connection.updated", { changedFields: ["password"] }, "actor-1"]);
  });

  it("does not call dispatchInvalidate when only the display name changes", async () => {
    const row = baseRow();
    const { withUser } = createFakeWithUser(row);

    await updateConnection(withUser, { orgId: "org-A" }, "conn-1", "actor-1", {
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
 * fake withUser only implements the `connector_installs` install-check
 * query since the invalid-field rejection happens before any other query
 * runs (and thus before secretStore is ever touched).
 */
describe("createConnection — Item 4.2 server-side host validation", () => {
  function createFakeWithUserInstallOnly(): WithUser {
    return (async (fn) =>
      fn({
        query: async (text: string) => {
          if (text.includes("from connector_installs")) return { rows: [{ count: 1 }] } as never;
          throw new Error(`unexpected query in fake — this fake only supports the install-check query: ${text}`);
        },
      })) as WithUser;
  }

  it("rejects a host value containing whitespace with INVALID_FIELD", async () => {
    const withUser = createFakeWithUserInstallOnly();
    await expect(
      createConnection(withUser, { orgId: "org-A" }, "user-1", {
        connectorId: "postgres",
        displayName: "Test",
        fields: { host: "db .example.com", port: 5432, database: "postgres", user: "nia_ro", password: "pw" },
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_FIELD" });
  });

  it("rejects a host value containing characters outside [a-zA-Z0-9.-]", async () => {
    const withUser = createFakeWithUserInstallOnly();
    await expect(
      createConnection(withUser, { orgId: "org-A" }, "user-1", {
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
 * always throws this error, so a passing test proves no retry happened
 * (only one insert attempt is wired up).
 */
describe("createConnection — Item 6.1 NAME_TAKEN", () => {
  function createFakeWithUserNameTaken(): WithUser {
    return (async (fn) =>
      fn({
        query: async (text: string) => {
          if (text.includes("from connector_installs")) return { rows: [{ count: 1 }] } as never;
          // createConnection's getSecretStore(withUser).put(...) runs
          // before the connections insert below — this test only cares
          // about the NAME_TAKEN error path that follows, so a bare
          // insert-id stub is enough.
          if (text.includes("insert into nia_secrets")) return { rows: [{ id: "secret-1" }] } as never;
          if (text.includes("insert into connections")) {
            const err = new Error(
              'duplicate key value violates unique constraint "connections_scope_display_name_unique_idx"',
            ) as Error & { code: string };
            err.code = "23505";
            throw err;
          }
          throw new Error(`unexpected query in fake: ${text}`);
        },
      })) as WithUser;
  }

  it("surfaces a display-name-uniqueness violation as NAME_TAKEN, not HANDLE_EXHAUSTED", async () => {
    const withUser = createFakeWithUserNameTaken();
    await expect(
      createConnection(withUser, { orgId: "org-A" }, "user-1", {
        connectorId: "mysql",
        displayName: "Duplicate Name",
        fields: { host: "db.example.com", port: 3306, database: "sandbox", user: "nia_ro", password: "pw" },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "NAME_TAKEN" });
  });
});

/**
 * Slice R1 — planometry-table's Test/Browse never go through
 * connectorDispatch.ts (see connections.ts's testConnection/
 * getConnectionSchema header comments); this exercises the real
 * createConnection -> testConnection -> getConnectionSchema path end to
 * end against a tiny in-process stub standing in for Planometry's own
 * HTTPS API — never importing anything from apps/agent, which owns the
 * real wire client this stub's shape is modeled on (see
 * apps/api/src/lib/planometryClient.ts's header comment).
 */
describe("Slice R1 — planometry-table", () => {
  const PUSH_KEY = "test-push-key-do-not-leak";

  /**
   * Same fake-withUser shape as createFakeWithUser above, but general
   * enough for a brand-new connection (createConnection's insert) rather
   * than pre-seeding an existing one for updateConnection — this fake
   * backs createConnection, testConnection, AND getConnectionSchema in the
   * same test, all against one in-memory connections/nia_secrets table.
   */
  function createFakePlanometryWithUser() {
    const queries: { text: string; params: readonly unknown[] }[] = [];
    const secretRows = new Map<string, Record<string, unknown>>();
    const connectionRows = new Map<string, Record<string, unknown>>();
    let nextSecretId = 1;

    const withUser: WithUser = (async (fn) =>
      fn({
        query: async (text: string, params: readonly unknown[] = []) => {
          queries.push({ text, params });
          if (text.includes("from connector_installs")) return { rows: [{ count: 1 }] } as never;
          if (text.includes("insert into nia_secrets")) {
            const [ciphertext, encrypted_data_key, iv, auth_tag, algorithm, key_version] = params;
            const id = `secret-${nextSecretId++}`;
            secretRows.set(id, { ciphertext, encrypted_data_key, iv, auth_tag, algorithm, key_version });
            return { rows: [{ id }] } as never;
          }
          if (text.includes("from nia_secrets where id")) {
            const id = params[0] as string;
            const stored = secretRows.get(id);
            return { rows: stored ? [{ id, ...stored }] : [] } as never;
          }
          if (text.includes("insert into connections")) {
            const [, , connectorId, handle, displayName, ownerUserId, config, vaultRef] = params;
            // ExecutionAuditInput (testConnection's audit call) requires a
            // real uuid for connectionId, not a readable fixture string
            // like the other fakes in this file use — those never exercise
            // the audit path.
            const id = crypto.randomUUID();
            const row = {
              id,
              connector_id: connectorId,
              handle,
              display_name: displayName,
              owner_user_id: ownerUserId,
              config,
              vault_secret_ref: vaultRef,
              cred_version: 1,
              last_test_status: null,
              last_test_latency_ms: null,
              last_test_at: null,
              last_used_at: null,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            };
            connectionRows.set(id, row);
            return { rows: [row] } as never;
          }
          if (text.includes("from connections where id")) {
            const id = params[0] as string;
            const row = connectionRows.get(id);
            return { rows: row ? [row] : [] } as never;
          }
          if (text.includes("update connections set")) {
            const id = params[params.length - 1] as string;
            const row = connectionRows.get(id) as Record<string, unknown> | undefined;
            if (row) {
              row.last_test_status = params[0];
              row.last_test_latency_ms = params[1];
              row.last_test_at = params[2];
            }
            return { rows: [] } as never;
          }
          if (text.includes("log_execution_audit")) return { rows: [] } as never;
          throw new Error(`unexpected query in fake: ${text}`);
        },
      })) as WithUser;
    return { withUser, queries };
  }

  // Lets the stub's plain-http loopback address past createConnection's
  // real HTTPS/private-range check — the one override point
  // addressSafety.ts's header comment calls out for tests.
  const allowAnyAddress = { assertAddressSafe: async () => {} };

  it("Allowed: a planometry_table connection tests ok and browsing returns the table's columns with key flags", async () => {
    const server = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${PUSH_KEY}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "bad push key" }));
        return;
      }
      if (req.url === "/schema") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            data: {
              dataSourceId: "ds-1",
              dataSourceName: "Revenue",
              columns: [
                { name: "id", type: "Number", isKey: true },
                { name: "amount", type: "Number", isKey: false },
              ],
              keyColumns: ["id"],
            },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          data: { status: "ok", dataSourceId: "ds-1", dataSourceName: "Revenue", serverTime: new Date().toISOString() },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    const url = `http://127.0.0.1:${port}`;

    try {
      const { withUser } = createFakePlanometryWithUser();

      // Real uuids (not the readable "user-1"/"actor-1" fixtures the other
      // describe blocks use) — testConnection's logExecutionAudit call
      // validates both as uuids (ExecutionAuditInput), and none of those
      // other blocks exercise that audit path.
      const ownerUserId = "00000000-0000-0000-0000-000000000001";
      const actorUserId = "00000000-0000-0000-0000-00000000000a";

      const connection = await createConnection(
        withUser,
        { orgId: "org-A" },
        ownerUserId,
        { connectorId: "planometry-table", displayName: "Revenue table", fields: { address: url, pushKey: PUSH_KEY } },
        allowAnyAddress,
      );
      // The push key is a secret field -> split into nia_secrets, never
      // part of the connection row/config this (or any) API response
      // returns.
      expect(connection.config).not.toHaveProperty("pushKey");
      expect(JSON.stringify(connection)).not.toContain(PUSH_KEY);

      const testResult = await testConnection(withUser, { orgId: "org-A" }, connection.id, actorUserId);
      expect(testResult.ok).toBe(true);
      expect(typeof testResult.latencyMs).toBe("number");
      expect(JSON.stringify(testResult)).not.toContain(PUSH_KEY);

      const schema = await getConnectionSchema(withUser, { orgId: "org-A" }, connection.id);
      expect(schema.entities).toHaveLength(1);
      expect(schema.entities[0]!.name).toBe("Revenue");
      expect(schema.entities[0]!.fields.map((f) => f.name)).toEqual(["id", "amount"]);
      expect(schema.entities[0]!.primaryKey).toBe("id");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("Refused: a non-HTTPS or private address is rejected at create, and the push key never appears in any API response", async () => {
    const { withUser, queries } = createFakePlanometryWithUser();

    const plainHttp = createConnection(withUser, { orgId: "org-A" }, "user-1", {
      connectorId: "planometry-table",
      displayName: "Plain HTTP",
      fields: { address: "http://example.com/push/abc", pushKey: PUSH_KEY },
    });
    await expect(plainHttp).rejects.toMatchObject({ statusCode: 400, code: "UNSAFE_ADDRESS" });
    await plainHttp.catch((err) => expect(String(err)).not.toContain(PUSH_KEY));

    const privateHttps = createConnection(withUser, { orgId: "org-A" }, "user-1", {
      connectorId: "planometry-table",
      displayName: "Private HTTPS",
      fields: { address: "https://127.0.0.1/push/abc", pushKey: PUSH_KEY },
    });
    await expect(privateHttps).rejects.toMatchObject({ statusCode: 400, code: "UNSAFE_ADDRESS" });
    await privateHttps.catch((err) => expect(String(err)).not.toContain(PUSH_KEY));

    // The address check runs before getSecretStore(...).put(...) in
    // createConnection — neither rejection above ever reached nia_secrets,
    // so the push key was never persisted anywhere it could later leak from.
    expect(queries.some((q) => q.text.includes("insert into nia_secrets"))).toBe(false);
  });
});
