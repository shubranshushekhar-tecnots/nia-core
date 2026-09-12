import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorConfig, CredentialRef } from "@nia/schemas";

// Mock the two external dependencies pool-manager.ts talks to over the
// network: the Supabase RPC (vault secret resolution) and mysql2 itself.
// Nothing here should ever touch a real socket.

const mockRpc = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: mockRpc }),
}));

const endMock = vi.fn(async () => undefined);
const constructedOptions: Array<{ connectionLimit?: number }> = [];
let instanceCount = 0;

vi.mock("mysql2/promise", () => ({
  default: {
    createPool: (options: { connectionLimit?: number }) => {
      instanceCount++;
      constructedOptions.push(options);
      return { end: endMock, query: vi.fn() };
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
    mockRpc.mockReset().mockResolvedValue({ data: { user: "u", password: "p" }, error: null });
    endMock.mockClear();
    constructedOptions.length = 0;
    instanceCount = 0;
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
    mockRpc.mockReset().mockResolvedValueOnce({ data: null, error: { message: "vault unreachable" } });
    const c = cred();

    await expect(getPool(c, config)).rejects.toThrow("vault unreachable");
    expect(poolCount()).toBe(0);

    // Next call should retry from scratch, not replay the cached rejection.
    mockRpc.mockResolvedValue({ data: { user: "u", password: "p" }, error: null });
    const pool = await getPool(c, config);
    expect(pool).toBeTruthy();
    expect(instanceCount).toBe(1);
    expect(poolCount()).toBe(1);
  });
});
