import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncCatalogIfNeeded } from "./catalogSync.js";
import { computeCatalogFingerprint } from "./catalogFingerprint.js";
import { PlanometryClient } from "./client.js";
import { FakePlanometryServer } from "../testing/fakePlanometryServer.js";
import type { Catalog } from "@nia/extract";

const catalog: Catalog = { generatedAt: "now", sourceTimeZone: "UTC", tables: [] };

describe("syncCatalogIfNeeded", () => {
  let server: FakePlanometryServer;
  let client: PlanometryClient;

  beforeEach(async () => {
    server = await FakePlanometryServer.start();
    client = new PlanometryClient({ baseUrl: server.baseUrl, agentKey: "k", agentVersion: "0.0.1" });
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("pushes at pairing (no last fingerprint)", async () => {
    const fingerprint = await syncCatalogIfNeeded(client, "conn-1", catalog, undefined, false);
    expect(fingerprint).toBe(computeCatalogFingerprint(catalog));
    expect(server.getCatalogPush("conn-1")).toBeDefined();
  });

  it("does not push when the fingerprint is unchanged and not requested", async () => {
    const fingerprint = computeCatalogFingerprint(catalog);
    await syncCatalogIfNeeded(client, "conn-1", catalog, fingerprint, false);
    expect(server.getCatalogPush("conn-1")).toBeUndefined();
  });

  it("pushes when catalogRequested is true even if unchanged", async () => {
    const fingerprint = computeCatalogFingerprint(catalog);
    await syncCatalogIfNeeded(client, "conn-1", catalog, fingerprint, true);
    expect(server.getCatalogPush("conn-1")).toBeDefined();
  });
});
