import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteContext } from "../router.js";
import type { LocalApiDeps } from "../deps.js";
import { LinkRevokedError, LinkTransientError } from "../../link/transport.js";
import { MassDeleteGuardError, WorkflowNotFoundError, type WorkflowSummary, type WorkflowsClient } from "../../link/workflowsClient.js";

const { Logger } = await import("../../ops/logger.js");
const { buildWorkflowsRoutes } = await import("./workflows.js");
const { ApiError, NotFoundError, OfflineError } = await import("../errors.js");

function ctx(overrides: Partial<RouteContext> = {}): RouteContext {
  return { params: {}, query: new URLSearchParams(), body: undefined, ...overrides };
}

const WORKFLOW: WorkflowSummary = {
  workflowId: "wf-1",
  setupId: "setup-1",
  name: "ETL kill-resume smoke",
  status: "ok",
  errorClass: null,
  rejectionReason: null,
  nextRunAt: null,
  lastRun: null,
};

function fakeClient(overrides: Partial<WorkflowsClient> = {}): WorkflowsClient {
  return {
    listWorkflows: vi.fn(async () => [WORKFLOW]),
    listRuns: vi.fn(async () => []),
    getGraph: vi.fn(async () => ({ workflowId: "wf-1", version: 1, nodes: [], edges: [] })),
    postAction: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as WorkflowsClient;
}

describe("workflows routes — offline fallback + error mapping", () => {
  let dir: string;
  let deps: LocalApiDeps;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-localapi-workflows-"));
    deps = { dir, agentVersion: "0.0.0-test", logger: new Logger(dir) };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("GET /workflows throws OfflineError when unpaired (no client) and nothing has ever been cached", async () => {
    deps.getWorkflowsClient = () => undefined;
    const route = buildWorkflowsRoutes(deps).find((r) => r.method === "GET" && r.path === "/workflows")!;

    await expect(route.handler!(ctx())).rejects.toBeInstanceOf(OfflineError);
  });

  it("GET /workflows returns last-known data tagged offline:true when a live call fails transiently", async () => {
    const client = fakeClient();
    deps.getWorkflowsClient = () => client;
    const route = buildWorkflowsRoutes(deps).find((r) => r.method === "GET" && r.path === "/workflows")!;

    // First call succeeds and populates the in-process cache.
    const first = (await route.handler!(ctx())) as { workflows: unknown[]; offline: boolean };
    expect(first.offline).toBe(false);
    expect(first.workflows).toHaveLength(1);

    // Second call: the link is now down (transient failure) -- must fall back
    // to the cached response instead of a 500.
    (client.listWorkflows as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new LinkTransientError("network error"));
    const second = (await route.handler!(ctx())) as { workflows: unknown[]; offline: boolean };
    expect(second.offline).toBe(true);
    expect(second.workflows).toHaveLength(1);
  });

  it("GET /workflows still falls back to cached data once unpaired, after an earlier successful call", async () => {
    const client = fakeClient();
    let current: WorkflowsClient | undefined = client;
    deps.getWorkflowsClient = () => current;
    const route = buildWorkflowsRoutes(deps).find((r) => r.method === "GET" && r.path === "/workflows")!;

    await route.handler!(ctx()); // populates cache
    current = undefined; // simulate unpair

    const result = (await route.handler!(ctx())) as { workflows: unknown[]; offline: boolean };
    expect(result.offline).toBe(true);
    expect(result.workflows).toHaveLength(1);
  });

  it("GET /workflows propagates a revoked link as a 401 ApiError, never swallowed into a stale fallback", async () => {
    const client = fakeClient({ listWorkflows: vi.fn(async () => { throw new LinkRevokedError(); }) });
    deps.getWorkflowsClient = () => client;
    const route = buildWorkflowsRoutes(deps).find((r) => r.method === "GET" && r.path === "/workflows")!;

    await expect(route.handler!(ctx())).rejects.toMatchObject({ statusCode: 401 });
  });

  it("GET /workflows/:workflowId/graph maps a not-found workflow to NotFoundError (404)", async () => {
    const client = fakeClient({
      getGraph: vi.fn(async () => {
        throw new WorkflowNotFoundError();
      }),
    });
    deps.getWorkflowsClient = () => client;
    const route = buildWorkflowsRoutes(deps).find((r) => r.method === "GET" && r.path === "/workflows/:workflowId/graph")!;

    await expect(route.handler!(ctx({ params: { workflowId: "wf-1" } }))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("POST /workflows/:workflowId/actions throws OfflineError (503) when there's no live link at all -- mutations are never served from cache", async () => {
    deps.getWorkflowsClient = () => undefined;
    const route = buildWorkflowsRoutes(deps).find((r) => r.method === "POST" && r.path === "/workflows/:workflowId/actions")!;

    await expect(
      route.handler!(ctx({ params: { workflowId: "wf-1" }, body: { kind: "run_now" } })),
    ).rejects.toBeInstanceOf(OfflineError);
  });

  it("POST /workflows/:workflowId/actions maps a transient failure to OfflineError instead of a 500", async () => {
    const client = fakeClient({
      postAction: vi.fn(async () => {
        throw new LinkTransientError("network error");
      }),
    });
    deps.getWorkflowsClient = () => client;
    const route = buildWorkflowsRoutes(deps).find((r) => r.method === "POST" && r.path === "/workflows/:workflowId/actions")!;

    await expect(
      route.handler!(ctx({ params: { workflowId: "wf-1" }, body: { kind: "run_now" } })),
    ).rejects.toBeInstanceOf(OfflineError);
  });

  it("POST /workflows/:workflowId/actions maps the mass-delete guard to a 403 ApiError", async () => {
    const client = fakeClient({
      postAction: vi.fn(async () => {
        throw new MassDeleteGuardError();
      }),
    });
    deps.getWorkflowsClient = () => client;
    const route = buildWorkflowsRoutes(deps).find((r) => r.method === "POST" && r.path === "/workflows/:workflowId/actions")!;

    const err = await route.handler!(ctx({ params: { workflowId: "wf-1" }, body: { kind: "resume" } })).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).statusCode).toBe(403);
  });

  it("POST /workflows/:workflowId/actions never forwards an allowMassDelete key the caller sends -- the bridge would reject it anyway", async () => {
    const client = fakeClient();
    deps.getWorkflowsClient = () => client;
    const route = buildWorkflowsRoutes(deps).find((r) => r.method === "POST" && r.path === "/workflows/:workflowId/actions")!;

    await route.handler!(ctx({ params: { workflowId: "wf-1" }, body: { kind: "run_now", allowMassDelete: true } }));

    const [, sentBody] = (client.postAction as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sentBody).not.toHaveProperty("allowMassDelete");
  });
});
