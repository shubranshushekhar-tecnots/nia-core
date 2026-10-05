import fs from "node:fs";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/store.js";
import { loadOrCreateMasterKey } from "../secrets/keyfile.js";
import { LocalSecretStore } from "../secrets/store.js";
import { HttpAgentTransport } from "./transport.js";
import { InvalidPlatformUrlError, pair } from "./pairing.js";

interface CapturedPairRequest {
  body: { pairingCodeId: string; code: string };
}

interface CapturedCheckInRequest {
  authorization: string | undefined;
  body: { agentVersion: string; hostName: string };
}

/** Minimal stand-in for services/agent-bridge's `/agent-api/pair` + `/agent-api/check-in` routes — real `node:http` server on an ephemeral port, same fixture style as testing/fakePlanometryServer.ts. */
function startFakeBridge(): Promise<{
  url: string;
  server: Server;
  pairRequests: CapturedPairRequest[];
  checkInRequests: CapturedCheckInRequest[];
}> {
  const pairRequests: CapturedPairRequest[] = [];
  const checkInRequests: CapturedCheckInRequest[] = [];

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};

      if (req.url === "/agent-api/pair" && req.method === "POST") {
        pairRequests.push({ body });
        if (body.pairingCodeId === "pc1" && body.code === "secret123") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ agentId: "agent-xyz", agentKey: "agent-key-value" }));
        } else {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "pairing code not found" }));
        }
        return;
      }

      if (req.url === "/agent-api/check-in" && req.method === "POST") {
        checkInRequests.push({ authorization: req.headers.authorization, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ tasks: [] }));
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, server, pairRequests, checkInRequests });
    });
  });
}

describe("pairing", () => {
  let dir: string;
  let bridge: Awaited<ReturnType<typeof startFakeBridge>>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-pairing-"));
    bridge = await startFakeBridge();
  });

  afterEach(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
  });

  it("Allowed: after pairing, the key is in the encrypted store and not in the config file, and the loop sends authenticated check-ins", async () => {
    const result = await pair({ code: "pc1.secret123", url: bridge.url }, dir);
    expect(result.agentId).toBe("agent-xyz");
    expect(bridge.pairRequests).toEqual([{ body: { pairingCodeId: "pc1", code: "secret123" } }]);

    const config = loadConfig(dir);
    expect(config.link).toEqual({ platformUrl: bridge.url, agentId: "agent-xyz", agentKeyRef: config.link!.agentKeyRef });
    expect(JSON.stringify(config)).not.toContain("agent-key-value");

    const masterKey = loadOrCreateMasterKey(dir);
    const secrets = new LocalSecretStore(masterKey, dir);
    expect(secrets.get(config.link!.agentKeyRef)).toEqual({ agentKey: "agent-key-value" });

    const transport = new HttpAgentTransport({ platformUrl: bridge.url, agentKey: "agent-key-value" });
    try {
      const response = await transport.checkIn({ agentVersion: "1.2.3", hostName: "test-host" });
      expect(response).toEqual({ tasks: [] });
    } finally {
      await transport.close();
    }

    expect(bridge.checkInRequests).toEqual([
      { authorization: "Bearer agent-key-value", body: { agentVersion: "1.2.3", hostName: "test-host" } },
    ]);
  });

  it("Refused: pairing with a non-HTTPS URL that is not localhost", async () => {
    await expect(pair({ code: "pc1.secret123", url: "http://platform.example.com" }, dir)).rejects.toThrow(InvalidPlatformUrlError);
    expect(bridge.pairRequests).toHaveLength(0);
    expect(loadConfig(dir).link).toBeUndefined();
  });
});
