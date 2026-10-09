import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addConnection } from "../core/connections.js";
import { loadConfig, saveConfig } from "../config/store.js";
import { loadOrCreateMasterKey } from "../secrets/keyfile.js";
import { LocalSecretStore } from "../secrets/store.js";
import { Logger } from "../ops/logger.js";
import { buildDiagnosticsRoutes } from "./routes/diagnostics.js";
import { buildConnectionsRoutes } from "./routes/connections.js";
import { buildStatusRoutes } from "./routes/status.js";
import type { LocalApiDeps } from "./deps.js";
import type { RouteContext } from "./router.js";

const PASSWORD = "Sup3rSecretPassword!";
const AGENT_KEY = "super-secret-agent-key-abc123";

const EMPTY_CTX: RouteContext = { params: {}, query: new URLSearchParams(), body: undefined };

describe("local API routes never leak secrets", () => {
  let dir: string;
  let deps: LocalApiDeps;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-localapi-diag-"));
    deps = { dir, agentVersion: "0.0.0-test", logger: new Logger(dir) };

    addConnection(
      { id: "conn-1", label: "Test", host: "sql.local", database: "db", user: "sa", password: PASSWORD, sourceTimeZone: "UTC" },
      dir,
    );

    const masterKey = loadOrCreateMasterKey(dir);
    const secrets = new LocalSecretStore(masterKey, dir);
    const agentKeyRef = secrets.put({ agentKey: AGENT_KEY });
    const config = loadConfig(dir);
    saveConfig({ ...config, link: { platformUrl: "https://platform.example", agentId: "agent-1", agentKeyRef } }, dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("GET /diagnostics never includes the password or the agent key", async () => {
    const route = buildDiagnosticsRoutes(deps).find((r) => r.path === "/diagnostics")!;
    const result = await route.handler!(EMPTY_CTX);
    const text = JSON.stringify(result);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(AGENT_KEY);
    expect(text).not.toContain("agentKeyRef");
  });

  it("GET /connections never includes the password", async () => {
    const route = buildConnectionsRoutes(deps).find((r) => r.method === "GET" && r.path === "/connections")!;
    const result = await route.handler!(EMPTY_CTX);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it("GET /status never includes the agent key", async () => {
    const route = buildStatusRoutes(deps).find((r) => r.path === "/status")!;
    const result = await route.handler!(EMPTY_CTX);
    expect(JSON.stringify(result)).not.toContain(AGENT_KEY);
  });
});
