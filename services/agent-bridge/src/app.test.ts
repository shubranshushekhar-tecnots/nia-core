import { describe, expect, it, vi } from "vitest";

// Mocks @nia/db entirely — no real socket, no real Postgres. Same shape as
// services/connector-mysql/src/pool-manager.test.ts's @nia/db mock.
const mockQuery = vi.fn();
vi.mock("@nia/db", () => ({
  createDbPool: () => ({}),
  withServiceRole: (_pool: unknown, fn: (db: { query: typeof mockQuery }) => unknown) => fn({ query: mockQuery }),
}));

// Phase 6 polish — GET /agent-api/update reads the download manifest via
// @nia/schemas's shared loader; mocked here so these tests never touch the
// real apps/agent/packaging/manifest.json on disk (which exists in this
// checkout but is stale/unrelated to what these tests assert).
const mockLoadDownloadManifest = vi.fn();
const mockGetDownloadsBaseUrl = vi.fn<[], string | undefined>(() => undefined);
vi.mock("@nia/schemas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@nia/schemas")>();
  return {
    ...actual,
    getDownloadsBaseUrl: () => mockGetDownloadsBaseUrl(),
    loadDownloadManifest: (root: string) => mockLoadDownloadManifest(root),
  };
});

async function freshApp() {
  vi.resetModules();
  mockQuery.mockReset();
  mockLoadDownloadManifest.mockReset();
  mockGetDownloadsBaseUrl.mockReset();
  mockGetDownloadsBaseUrl.mockReturnValue(undefined);
  const { buildApp } = await import("./app.js");
  return buildApp;
}

describe("agent-bridge /check-in (route-level)", () => {
  it("a check-in with a valid key updates last check-in and returns an empty task list after the hold", async () => {
    const buildApp = await freshApp();

    mockQuery.mockResolvedValueOnce({ rows: [{ id: "agent-1", status: "active" }] });
    // Slice R3a (commit deec997) added a setups poll to every check-in —
    // this agent has none published, so the lookup returns no rows.
    mockQuery.mockResolvedValue({ rows: [] });

    // Injected transport stands in for the real 25s hold (LongPollTransport)
    // — buildApp's factory signature (src/app.ts) accepts any AgentTransport.
    const waitForTasks = vi.fn(async () => []);
    const app = buildApp({ waitForTasks });

    const response = await app.inject({
      method: "POST",
      url: "/agent-api/check-in",
      headers: { authorization: "Bearer test-agent-key" },
      payload: { agentVersion: "1.0.0", hostName: "test-host" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tasks: [], acknowledgedRunIds: [], setups: [] });
    expect(waitForTasks).toHaveBeenCalledWith("agent-1", 25_000);

    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("update public.platform_agents");
    expect(params[1]).toBe("1.0.0");
    expect(params[2]).toBe("test-host");
  });

  it("a check-in with noHold:true skips the hold entirely", async () => {
    const buildApp = await freshApp();

    mockQuery.mockResolvedValue({ rows: [{ id: "agent-1", status: "active" }] });

    const waitForTasks = vi.fn(async () => []);
    const app = buildApp({ waitForTasks });

    const response = await app.inject({
      method: "POST",
      url: "/agent-api/check-in",
      headers: { authorization: "Bearer test-agent-key" },
      payload: { agentVersion: "1.0.0", hostName: "test-host", noHold: true },
    });

    expect(response.statusCode).toBe(200);
    expect(waitForTasks).toHaveBeenCalledWith("agent-1", 0);
  });
});

describe("agent-bridge GET /agent-api/update (route-level)", () => {
  const sampleManifest = {
    version: "0.0.7",
    generatedAt: "2026-01-01T00:00:00.000Z",
    files: [
      { name: "NiaCoreAgent-Setup-0.0.7.exe", os: "windows" as const, kind: "primary" as const, size: 123, sha256: "abc123" },
      { name: "nia-agent-0.0.7.pkg", os: "macos" as const, kind: "primary" as const, size: 456, sha256: "def456" },
    ],
  };

  it("401s a request with no Bearer key at all", async () => {
    const buildApp = await freshApp();
    const app = buildApp({ waitForTasks: vi.fn(async () => []) });

    const response = await app.inject({ method: "GET", url: "/agent-api/update?os=windows" });

    expect(response.statusCode).toBe(401);
    expect(mockLoadDownloadManifest).not.toHaveBeenCalled();
  });

  it("401s an unknown or revoked agent key", async () => {
    const buildApp = await freshApp();
    mockQuery.mockResolvedValue({ rows: [] });
    const app = buildApp({ waitForTasks: vi.fn(async () => []) });

    const response = await app.inject({
      method: "GET",
      url: "/agent-api/update?os=windows",
      headers: { authorization: "Bearer not-a-real-key" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("404s an unknown os", async () => {
    const buildApp = await freshApp();
    mockQuery.mockResolvedValue({ rows: [{ id: "agent-1" }] });
    const app = buildApp({ waitForTasks: vi.fn(async () => []) });

    const response = await app.inject({
      method: "GET",
      url: "/agent-api/update?os=amiga",
      headers: { authorization: "Bearer test-agent-key" },
    });

    expect(response.statusCode).toBe(404);
    expect(mockLoadDownloadManifest).not.toHaveBeenCalled();
  });

  it("404s a known os with no primary build in the manifest", async () => {
    const buildApp = await freshApp();
    mockQuery.mockResolvedValue({ rows: [{ id: "agent-1" }] });
    mockLoadDownloadManifest.mockResolvedValue(sampleManifest);
    const app = buildApp({ waitForTasks: vi.fn(async () => []) });

    const response = await app.inject({
      method: "GET",
      url: "/agent-api/update?os=linux",
      headers: { authorization: "Bearer test-agent-key" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("404s when no manifest is available at all (load throws)", async () => {
    const buildApp = await freshApp();
    mockQuery.mockResolvedValue({ rows: [{ id: "agent-1" }] });
    mockLoadDownloadManifest.mockRejectedValue(new Error("ENOENT"));
    const app = buildApp({ waitForTasks: vi.fn(async () => []) });

    const response = await app.inject({
      method: "GET",
      url: "/agent-api/update?os=windows",
      headers: { authorization: "Bearer test-agent-key" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns the primary build's download info on the happy path (dev fallback URL)", async () => {
    const buildApp = await freshApp();
    mockQuery.mockResolvedValue({ rows: [{ id: "agent-1" }] });
    mockLoadDownloadManifest.mockResolvedValue(sampleManifest);
    const app = buildApp({ waitForTasks: vi.fn(async () => []) });

    const response = await app.inject({
      method: "GET",
      url: "/agent-api/update?os=windows&version=0.0.6",
      headers: { authorization: "Bearer test-agent-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      latestVersion: "0.0.7",
      url: "http://localhost:3100/api/agent-downloads/NiaCoreAgent-Setup-0.0.7.exe",
      sha256: "abc123",
      minVersion: "0.0.1",
    });
  });

  it("prefixes the download URL with AGENT_DOWNLOADS_BASE_URL when configured", async () => {
    const buildApp = await freshApp();
    mockQuery.mockResolvedValue({ rows: [{ id: "agent-1" }] });
    mockLoadDownloadManifest.mockResolvedValue(sampleManifest);
    mockGetDownloadsBaseUrl.mockReturnValue("https://downloads.example.com/agent");
    const app = buildApp({ waitForTasks: vi.fn(async () => []) });

    const response = await app.inject({
      method: "GET",
      url: "/agent-api/update?os=macos",
      headers: { authorization: "Bearer test-agent-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().url).toBe("https://downloads.example.com/agent/nia-agent-0.0.7.pkg");
  });
});
