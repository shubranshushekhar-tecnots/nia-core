import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ColumnStats } from "@nia/schemas";

// Fake db.query dispatched by the caller (cleanPlanDrift.ts) through the
// real withServiceRole — mocked here to skip the actual transaction/SET
// LOCAL ROLE machinery, mirroring resolveConnection.test.ts.
const query = vi.fn();

vi.mock("@nia/db", async () => {
  const actual = await vi.importActual<typeof import("@nia/db")>("@nia/db");
  return {
    ...actual,
    withServiceRole: vi.fn(async (_pool: unknown, fn: (db: { query: typeof query }) => unknown) => fn({ query })),
  };
});

vi.mock("../dbPool.js", () => ({ dbPool: {} }));

const profileEntity = vi.fn();
vi.mock("../profile/profileEntity.js", () => ({
  profileEntity: (...args: unknown[]) => profileEntity(...args),
}));

const computeSchemaHash = vi.fn();
vi.mock("../profile/signature.js", () => ({
  computeSchemaHash: (...args: unknown[]) => computeSchemaHash(...args),
}));

const { checkCleanPlanDrift } = await import("./cleanPlanDrift.js");

const WORKFLOW_ID = "11111111-1111-1111-1111-111111111111";
const NODE_ID = "node-1";
const CONNECTION_ID = "22222222-2222-2222-2222-222222222222";
const scope = { orgId: "org-1" };
const entity = { namespace: "public", name: "customers" };
const triggeredByUserId = "33333333-3333-3333-3333-333333333333";

const boundRow = {
  source_schema_hash: "schema-hash-a",
  profile_hash: "profile-hash-a",
  op_catalog_version: 1,
  adapter_version: 1,
  profile_signature_version: 1,
};

function callArgs() {
  return {
    scope,
    workflowId: WORKFLOW_ID,
    nodeId: NODE_ID,
    sourceConnectionId: CONNECTION_ID,
    entity,
    triggeredByUserId,
  };
}

describe("checkCleanPlanDrift", () => {
  beforeEach(() => {
    query.mockReset();
    profileEntity.mockReset();
    computeSchemaHash.mockReset();
  });

  it("passes through ok when the node has no CleanPlan binding at all", async () => {
    query.mockResolvedValue({ rows: [] });

    const result = await checkCleanPlanDrift(callArgs());

    expect(result).toEqual({ ok: true });
    expect(profileEntity).not.toHaveBeenCalled();
  });

  it("refuses the run and names the binding when the source schema hash has drifted", async () => {
    query.mockResolvedValue({ rows: [boundRow] });
    profileEntity.mockResolvedValue({ columns: [] as ColumnStats[], profileHash: "profile-hash-a" });
    computeSchemaHash.mockReturnValue("schema-hash-CHANGED");

    const result = await checkCleanPlanDrift(callArgs());

    expect(result).toEqual({
      ok: false,
      nodeId: NODE_ID,
      reason: "schema-changed",
      message: expect.stringContaining(NODE_ID),
    });
  });

  it("refuses the run and names the binding when the profile hash has drifted", async () => {
    query.mockResolvedValue({ rows: [boundRow] });
    profileEntity.mockResolvedValue({ columns: [] as ColumnStats[], profileHash: "profile-hash-CHANGED" });
    computeSchemaHash.mockReturnValue("schema-hash-a");

    const result = await checkCleanPlanDrift(callArgs());

    expect(result).toEqual({
      ok: false,
      nodeId: NODE_ID,
      reason: "profile-changed",
      message: expect.stringContaining(NODE_ID),
    });
  });

  it("refuses the run and says the profile format changed (not that the data drifted) when the profile signature version has moved on, even if the profile hash would also mismatch", async () => {
    query.mockResolvedValue({ rows: [{ ...boundRow, profile_signature_version: 0 }] });
    profileEntity.mockResolvedValue({ columns: [] as ColumnStats[], profileHash: "profile-hash-CHANGED" });
    computeSchemaHash.mockReturnValue("schema-hash-a");

    const result = await checkCleanPlanDrift(callArgs());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("profile-signature-version-changed");
      expect(result.nodeId).toBe(NODE_ID);
      expect(result.message).toContain("format changed");
      expect(result.message).not.toContain("data drifted");
    }
  });

  it("refuses the run when the op catalog version has moved on", async () => {
    query.mockResolvedValue({ rows: [{ ...boundRow, op_catalog_version: 0 }] });
    profileEntity.mockResolvedValue({ columns: [] as ColumnStats[], profileHash: "profile-hash-a" });
    computeSchemaHash.mockReturnValue("schema-hash-a");

    const result = await checkCleanPlanDrift(callArgs());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("catalog-version-changed");
      expect(result.nodeId).toBe(NODE_ID);
    }
  });

  it("refuses the run when the connector adapter version has moved on", async () => {
    query.mockResolvedValue({ rows: [{ ...boundRow, adapter_version: 0 }] });
    profileEntity.mockResolvedValue({ columns: [] as ColumnStats[], profileHash: "profile-hash-a" });
    computeSchemaHash.mockReturnValue("schema-hash-a");

    const result = await checkCleanPlanDrift(callArgs());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("adapter-version-changed");
      expect(result.nodeId).toBe(NODE_ID);
    }
  });

  it("returns ok when every binding still matches", async () => {
    query.mockResolvedValue({ rows: [boundRow] });
    profileEntity.mockResolvedValue({ columns: [] as ColumnStats[], profileHash: "profile-hash-a" });
    computeSchemaHash.mockReturnValue("schema-hash-a");

    const result = await checkCleanPlanDrift(callArgs());

    expect(result).toEqual({ ok: true });
  });
});
