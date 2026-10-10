import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../../ops/logger.js";
import type { UpdateChecker } from "../../link/updateChecker.js";
import { ApiError } from "../errors.js";
import type { LocalApiDeps } from "../deps.js";
import type { RouteContext } from "../router.js";
import { buildUpdateRoutes } from "./update.js";

function ctx(overrides: Partial<RouteContext> = {}): RouteContext {
  return { params: {}, query: new URLSearchParams(), body: undefined, ...(overrides as object) } as RouteContext;
}

describe("update routes", () => {
  let dir: string;
  let deps: LocalApiDeps;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-localapi-update-"));
    deps = { dir, agentVersion: "1.0.0", logger: new Logger(dir) };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("POST /update/check returns available:false when unpaired (no checker)", async () => {
    deps.getUpdateChecker = () => undefined;
    const route = buildUpdateRoutes(deps).find((r) => r.method === "POST" && r.path === "/update/check")!;

    await expect(route.handler!(ctx())).resolves.toEqual({ available: false, reason: "not paired" });
  });

  it("POST /update/check calls checkManually() on the live checker and returns its result", async () => {
    const checkManually = vi.fn(async () => ({ available: true, version: "1.1.0" }));
    deps.getUpdateChecker = () => ({ checkManually } as unknown as UpdateChecker);
    const route = buildUpdateRoutes(deps).find((r) => r.method === "POST" && r.path === "/update/check")!;

    await expect(route.handler!(ctx())).resolves.toEqual({ available: true, version: "1.1.0" });
    expect(checkManually).toHaveBeenCalledTimes(1);
  });

  it("POST /update/install returns started:false when unpaired (no checker)", async () => {
    deps.getUpdateChecker = () => undefined;
    const route = buildUpdateRoutes(deps).find((r) => r.method === "POST" && r.path === "/update/install")!;

    await expect(route.handler!(ctx())).resolves.toEqual({ started: false, reason: "not paired" });
  });

  it("POST /update/install calls installManually() on the live checker and returns its result", async () => {
    const installManually = vi.fn(async () => ({ started: true }));
    deps.getUpdateChecker = () => ({ installManually } as unknown as UpdateChecker);
    const route = buildUpdateRoutes(deps).find((r) => r.method === "POST" && r.path === "/update/install")!;

    await expect(route.handler!(ctx())).resolves.toEqual({ started: true });
    expect(installManually).toHaveBeenCalledTimes(1);
  });

  it("GET /update/settings defaults to enabled:false when nothing is configured yet", async () => {
    const route = buildUpdateRoutes(deps).find((r) => r.method === "GET" && r.path === "/update/settings")!;
    expect(await route.handler!(ctx())).toEqual({ enabled: false });
  });

  it("POST /update/settings persists the toggle, GET reflects it afterward", async () => {
    const routes = buildUpdateRoutes(deps);
    const post = routes.find((r) => r.method === "POST" && r.path === "/update/settings")!;
    const get = routes.find((r) => r.method === "GET" && r.path === "/update/settings")!;

    expect(await post.handler!(ctx({ body: { enabled: false } }))).toEqual({ enabled: false });
    expect(await get.handler!(ctx())).toEqual({ enabled: false });

    expect(await post.handler!(ctx({ body: { enabled: true } }))).toEqual({ enabled: true });
    expect(await get.handler!(ctx())).toEqual({ enabled: true });
  });

  it("POST /update/settings rejects a non-boolean enabled field", () => {
    const route = buildUpdateRoutes(deps).find((r) => r.method === "POST" && r.path === "/update/settings")!;
    expect(() => route.handler!(ctx({ body: { enabled: "yes" } }))).toThrow(ApiError);
  });
});
