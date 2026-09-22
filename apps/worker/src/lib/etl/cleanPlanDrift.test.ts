import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ColumnStats } from "@nia/schemas";

// Chainable mock query builder mimicking the subset of the supabase-js
// fluent API checkCleanPlanDrift actually calls:
// .from("clean_plans").select().eq().eq().maybeSingle().
const maybeSingle = vi.fn();
const builder: Record<string, unknown> = {};
builder.select = vi.fn(() => builder);
builder.eq = vi.fn(() => builder);
builder.maybeSingle = maybeSingle;
const from = vi.fn((..._args: unknown[]) => builder);

vi.mock("../supabaseClient.js", () => ({
  supabase: { from: (...args: unknown[]) => from(...args) },
}));

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
    maybeSingle.mockReset();
    from.mockClear();
    profileEntity.mockReset();
    computeSchemaHash.mockReset();
  });

  it("passes through ok when the node has no CleanPlan binding at all", async () => {
    maybeSingle.mockResolvedValue({ data: null });

    const result = await checkCleanPlanDrift(callArgs());

    expect(result).toEqual({ ok: true });
    expect(profileEntity).not.toHaveBeenCalled();
  });

  it("refuses the run and names the binding when the source schema hash has drifted", async () => {
    maybeSingle.mockResolvedValue({ data: boundRow });
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
    maybeSingle.mockResolvedValue({ data: boundRow });
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
    maybeSingle.mockResolvedValue({ data: { ...boundRow, profile_signature_version: 0 } });
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
    maybeSingle.mockResolvedValue({ data: { ...boundRow, op_catalog_version: 0 } });
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
    maybeSingle.mockResolvedValue({ data: { ...boundRow, adapter_version: 0 } });
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
    maybeSingle.mockResolvedValue({ data: boundRow });
    profileEntity.mockResolvedValue({ columns: [] as ColumnStats[], profileHash: "profile-hash-a" });
    computeSchemaHash.mockReturnValue("schema-hash-a");

    const result = await checkCleanPlanDrift(callArgs());

    expect(result).toEqual({ ok: true });
  });
});
