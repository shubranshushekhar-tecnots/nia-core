import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorConfig, CredentialRef } from "@nia/schemas";

// Fixed 32-byte test key for @nia/secrets' createEnvKeySecretStore, which
// pool-manager.ts constructs at module load — must be set before the first
// dynamic import() below.
process.env.NIA_SECRET_MASTER_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

// Mock the external dependencies pool-manager.ts talks to over the
// network: the Supabase RPC (legacy vault secret resolution), the
// nia_secrets table read (dual-read — mocked here to always miss so
// existing tests keep exercising the legacy RPC fallback path), and pg
// itself. Nothing here should ever touch a real socket.

const mockRpc = vi.fn();
const mockMaybeSingle = vi.fn(async () => ({ data: null, error: null }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: mockRpc,
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }) }),
  }),
}));

const endMock = vi.fn(async () => undefined);
const constructedOptions: Array<{ max?: number; ssl?: unknown }> = [];
let instanceCount = 0;

function MockPool(options: { max?: number; ssl?: unknown }) {
  instanceCount++;
  constructedOptions.push(options);
  return { end: endMock, query: vi.fn(), on: vi.fn() };
}

vi.mock("pg", () => ({
  default: { Pool: MockPool, types: { setTypeParser: vi.fn() } },
}));

const config: ConnectorConfig = { host: "localhost", port: 5432, database: "testdb" };
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

describe("connector-supabase pool-manager", () => {
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
    expect(constructedOptions[0]).toMatchObject({ max: 3 });
  });

  it("enables ssl with rejectUnauthorized:false when config.ssl is true", async () => {
    const { getPool } = await freshPoolManager();
    await getPool(cred(), { ...config, ssl: true });
    expect(constructedOptions[0]?.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("leaves ssl undefined when config.ssl is not set on a sandbox host (localhost)", async () => {
    const { getPool } = await freshPoolManager();
    await getPool(cred(), config);
    expect(constructedOptions[0]?.ssl).toBeUndefined();
  });

  // Item 4.1/4A fix: TLS now defaults ON for real hosts, OFF for known
  // local/sandbox hosts (unchanged dev-container workflow), and is forced ON
  // for known managed-Postgres providers regardless of the stored value.
  it("defaults ssl on for a non-sandbox host with no explicit ssl value", async () => {
    const { getPool } = await freshPoolManager();
    await getPool(cred(), { ...config, host: "db.mycompany.com" });
    expect(constructedOptions[0]?.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("defaults ssl off for other known sandbox hosts with no explicit ssl value", async () => {
    const { getPool } = await freshPoolManager();
    await getPool(cred(), { ...config, host: "127.0.0.1" });
    expect(constructedOptions[0]?.ssl).toBeUndefined();
    const { getPool: getPool2 } = await freshPoolManager();
    await getPool2(cred(), { ...config, host: "host.docker.internal" });
    expect(constructedOptions[1]?.ssl).toBeUndefined();
  });

  it("defaults ssl off for a bare (dot-less) docker-compose service-name host, e.g. dev-postgres", async () => {
    const { getPool } = await freshPoolManager();
    await getPool(cred(), { ...config, host: "dev-postgres" });
    expect(constructedOptions[0]?.ssl).toBeUndefined();
  });

  it("respects an explicit ssl:false for a non-sandbox, non-managed host", async () => {
    const { getPool } = await freshPoolManager();
    await getPool(cred(), { ...config, host: "db.mycompany.com", ssl: false });
    expect(constructedOptions[0]?.ssl).toBeUndefined();
  });

  it("forces ssl on for known managed-Postgres hosts even when ssl is explicitly false", async () => {
    const { getPool } = await freshPoolManager();
    await getPool(cred(), { ...config, host: "ep-cool-name-123456.us-east-2.aws.neon.tech", ssl: false });
    expect(constructedOptions[0]?.ssl).toEqual({ rejectUnauthorized: false });
    const { getPool: getPool2 } = await freshPoolManager();
    await getPool2(cred(), { ...config, host: "db.abcxyz.supabase.co", ssl: false });
    expect(constructedOptions[1]?.ssl).toEqual({ rejectUnauthorized: false });
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
