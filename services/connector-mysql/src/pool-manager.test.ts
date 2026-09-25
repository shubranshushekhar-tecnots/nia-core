import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorConfig, CredentialRef } from "@nia/schemas";
import { encryptSecret } from "@nia/secrets";

// Fixed 32-byte test key for @nia/secrets' createEnvKeySecretStore, which
// pool-manager.ts constructs at module load — must be set before the first
// dynamic import() below.
const MASTER_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
process.env.NIA_SECRET_MASTER_KEY = MASTER_KEY;

function encryptedRow(secret: Record<string, unknown>) {
  const encrypted = encryptSecret(Buffer.from(MASTER_KEY, "base64"), 1, secret);
  return {
    id: "vault-ref-1",
    ciphertext: encrypted.ciphertext,
    encrypted_data_key: encrypted.encryptedDataKey,
    iv: encrypted.iv,
    auth_tag: encrypted.authTag,
    algorithm: encrypted.algorithm,
    key_version: encrypted.keyVersion,
  };
}

// Mock the external dependencies pool-manager.ts talks to over the
// network: the nia_secrets read (@nia/secrets's createEnvKeySecretStore,
// via .from().select().eq().maybeSingle()) and mysql2 itself. Nothing here
// should ever touch a real socket.

const mockMaybeSingle = vi.fn(async () => ({ data: encryptedRow({ user: "u", password: "p" }), error: null }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }) }),
  }),
}));

const endMock = vi.fn(async () => undefined);
const constructedOptions: Array<{ connectionLimit?: number }> = [];
let instanceCount = 0;
// Captured per constructed pool, in construction order, so a test can
// simulate mysql2's Pool "connection" event firing on a fresh connection.
let connectionHandlers: Array<(conn: { query: ReturnType<typeof vi.fn> }) => void> = [];

vi.mock("mysql2/promise", () => ({
  default: {
    createPool: (options: { connectionLimit?: number }) => {
      instanceCount++;
      constructedOptions.push(options);
      return {
        end: endMock,
        query: vi.fn(),
        on: (event: string, cb: (conn: { query: ReturnType<typeof vi.fn> }) => void) => {
          if (event === "connection") connectionHandlers.push(cb);
        },
      };
    },
  },
}));

const config: ConnectorConfig = { host: "localhost", port: 3306, database: "testdb" };
const cred = (overrides: Partial<CredentialRef> = {}): CredentialRef => ({
  connectionId: "conn-1",
  credVersion: 1,
  vaultRef: "vault-ref-1",
  ...overrides,
});

/** Fresh module instance per test so the module-level `pools` Map (and its
 * setInterval) don't leak state or timers across tests. */
async function freshPoolManager() {
  vi.resetModules();
  return import("./pool-manager.js");
}

describe("connector-mysql pool-manager", () => {
  beforeEach(() => {
    mockMaybeSingle.mockReset().mockResolvedValue({ data: encryptedRow({ user: "u", password: "p" }), error: null });
    endMock.mockClear();
    constructedOptions.length = 0;
    instanceCount = 0;
    connectionHandlers = [];
  });

  it("reuses the same pool for repeated calls with the same credVersion", async () => {
    const { getPool, poolCount } = await freshPoolManager();
    const c = cred();
    const pool1 = await getPool(c, config);
    const pool2 = await getPool(c, config);
    expect(pool1).toBe(pool2);
    expect(instanceCount).toBe(1);
    expect(poolCount()).toBe(1);
  });

  it("creates a new pool when credVersion is bumped", async () => {
    const { getPool, poolCount } = await freshPoolManager();
    const pool1 = await getPool(cred({ credVersion: 1 }), config);
    const pool2 = await getPool(cred({ credVersion: 2 }), config);
    expect(pool1).not.toBe(pool2);
    expect(instanceCount).toBe(2);
    // The old credVersion's pool isn't evicted immediately on rotation —
    // by design (see contract.ts's CredentialRef comment), it just ages
    // out via idle eviction once nothing hits it anymore.
    expect(poolCount()).toBe(2);
  });

  it("respects the configured per-connection pool size cap", async () => {
    const { getPool } = await freshPoolManager();
    await getPool(cred(), config);
    expect(constructedOptions[0]).toMatchObject({ connectionLimit: 3 });
  });

  it("evicts idle pools after the idle window", async () => {
    vi.useFakeTimers();
    try {
      const { getPool, poolCount } = await freshPoolManager();
      await getPool(cred(), config);
      expect(poolCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      expect(poolCount()).toBe(0);
      expect(endMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not create duplicate pools for concurrent first calls with the same key", async () => {
    const { getPool } = await freshPoolManager();
    const c = cred();
    const [pool1, pool2, pool3] = await Promise.all([
      getPool(c, config),
      getPool(c, config),
      getPool(c, config),
    ]);
    expect(instanceCount).toBe(1);
    expect(pool1).toBe(pool2);
    expect(pool2).toBe(pool3);
  });

  it("removes the cache entry on a rejected resolve so the next call retries cleanly", async () => {
    const { getPool, poolCount } = await freshPoolManager();
    mockMaybeSingle.mockReset().mockResolvedValueOnce({ data: null, error: { message: "network unreachable" } });
    const c = cred();

    await expect(getPool(c, config)).rejects.toThrow("nia_secrets read failed");
    expect(poolCount()).toBe(0);

    // Next call should retry from scratch, not replay the cached rejection.
    mockMaybeSingle.mockResolvedValue({ data: encryptedRow({ user: "u", password: "p" }), error: null });
    const pool = await getPool(c, config);
    expect(pool).toBeTruthy();
    expect(instanceCount).toBe(1);
    expect(poolCount()).toBe(1);
  });

  // Follow-up item 1: strict sql_mode must be set on every write-pool
  // connection (staging + apply share this same pool), but never on the
  // read pool — a read-only session has no need for it.
  it("sets a strict sql_mode on every write-pool connection, and not on the read pool", async () => {
    const { getPool, getWritePool } = await freshPoolManager();
    const c = cred();

    await getPool(c, config);
    expect(connectionHandlers).toHaveLength(0);

    await getWritePool(c, config);
    expect(connectionHandlers).toHaveLength(1);

    const fakeConn = { query: vi.fn().mockResolvedValue(undefined) };
    connectionHandlers[0]!(fakeConn);
    expect(fakeConn.query).toHaveBeenCalledWith(
      "SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO'",
    );
  });
});
