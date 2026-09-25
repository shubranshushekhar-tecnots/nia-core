import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorConfig, CredentialRef } from "@nia/schemas";
import { encryptSecret } from "@nia/secrets";

// Fixed 32-byte test key for @nia/secrets' createEnvKeySecretStore, which
// pool-manager.ts constructs at module load — must be set before the first
// dynamic import() below.
const MASTER_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
process.env.NIA_SECRET_MASTER_KEY = MASTER_KEY;
process.env.DATABASE_URL = "postgres://test";

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
// via @nia/db's withServiceRole) and the mongodb driver itself. Nothing
// here should ever touch a real socket.

const mockQuery = vi.fn(async () => ({ rows: [encryptedRow({ user: "u", password: "p" })] }));
vi.mock("@nia/db", () => ({
  createDbPool: () => ({}),
  withServiceRole: (_pool: unknown, fn: (db: { query: typeof mockQuery }) => unknown) => fn({ query: mockQuery }),
}));

const connectMock = vi.fn(async () => undefined);
const closeMock = vi.fn(async () => undefined);
const constructedOptions: Array<{ maxPoolSize?: number }> = [];
let instanceCount = 0;

vi.mock("mongodb", () => {
  class FakeMongoClient {
    constructor(_uri: string, options: { maxPoolSize?: number }) {
      instanceCount++;
      constructedOptions.push(options);
    }
    connect = connectMock;
    close = closeMock;
    db(name: string) {
      return { __fakeDbName: name };
    }
  }
  return { MongoClient: FakeMongoClient };
});

const config: ConnectorConfig = { host: "localhost", port: 27017, database: "testdb" };
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

describe("connector-mongodb pool-manager", () => {
  beforeEach(() => {
    mockQuery.mockReset().mockResolvedValue({ rows: [encryptedRow({ user: "u", password: "p" })] });
    connectMock.mockClear();
    closeMock.mockClear();
    constructedOptions.length = 0;
    instanceCount = 0;
  });

  it("reuses the same pool for repeated calls with the same credVersion", async () => {
    const { getDb, poolCount } = await freshPoolManager();
    const c = cred();
    const db1 = await getDb(c, config);
    const db2 = await getDb(c, config);
    expect(db1).toBe(db2);
    expect(instanceCount).toBe(1);
    expect(poolCount()).toBe(1);
  });

  it("creates a new pool when credVersion is bumped", async () => {
    const { getDb, poolCount } = await freshPoolManager();
    const db1 = await getDb(cred({ credVersion: 1 }), config);
    const db2 = await getDb(cred({ credVersion: 2 }), config);
    expect(db1).not.toBe(db2);
    expect(instanceCount).toBe(2);
    // The old credVersion's pool isn't evicted immediately on rotation —
    // by design (see contract.ts's CredentialRef comment), it just ages
    // out via idle eviction once nothing hits it anymore.
    expect(poolCount()).toBe(2);
  });

  it("respects the configured per-connection pool size cap", async () => {
    const { getDb } = await freshPoolManager();
    await getDb(cred(), config);
    expect(constructedOptions[0]).toEqual({ maxPoolSize: 3 });
  });

  it("evicts idle pools after the idle window", async () => {
    vi.useFakeTimers();
    try {
      const { getDb, poolCount } = await freshPoolManager();
      await getDb(cred(), config);
      expect(poolCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      expect(poolCount()).toBe(0);
      expect(closeMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not create duplicate pools for concurrent first calls with the same key", async () => {
    const { getDb } = await freshPoolManager();
    const c = cred();
    const [db1, db2, db3] = await Promise.all([
      getDb(c, config),
      getDb(c, config),
      getDb(c, config),
    ]);
    expect(instanceCount).toBe(1);
    expect(db1).toBe(db2);
    expect(db2).toBe(db3);
  });

  it("removes the cache entry on a rejected resolve so the next call retries cleanly", async () => {
    const { getDb, poolCount } = await freshPoolManager();
    mockQuery.mockReset().mockRejectedValueOnce(new Error("network unreachable"));
    const c = cred();

    await expect(getDb(c, config)).rejects.toThrow("network unreachable");
    expect(poolCount()).toBe(0);

    // Next call should retry from scratch, not replay the cached rejection.
    mockQuery.mockResolvedValue({ rows: [encryptedRow({ user: "u", password: "p" })] });
    const db = await getDb(c, config);
    expect(db).toBeTruthy();
    expect(instanceCount).toBe(1);
    expect(poolCount()).toBe(1);
  });
});
