import { describe, it, expect, beforeEach } from "vitest";
import { confirmPendingAction, consumePendingAction, hashToolArgs } from "./pendingActions.js";

/**
 * Required test (docs/plans/copilot-agent.md, "Tests" section): "every
 * execute-tier tool refuses without a matching confirmed pending action."
 *
 * registry.test.ts covers the tool-handler side of this (start_run refuses
 * when consume_pending_action reports failure). This file covers the other
 * half: that "matching" and "not expired" are actually load-bearing, not
 * just that *some* rejection reason exists. `consume_pending_action`/
 * `confirm_pending_action` (supabase/migrations/0031_copilot_agent.sql) are
 * real Postgres functions — this fake reimplements their exact WHERE-clause
 * semantics (confirmed_at, consumed_at, expires_at, args_hash equality) so
 * the JS wrapper's behavior is verified against that real contract, not
 * against a mock that always succeeds or always fails.
 */

type FakeRow = {
  id: string;
  tool: string;
  argsHash: string;
  confirmedAt: string | null;
  consumedAt: string | null;
  expiresAt: string;
};

function makeFakeDb() {
  const rows = new Map<string, FakeRow>();

  function insert(row: FakeRow) {
    rows.set(row.id, row);
  }

  const supabase = {
    rpc(fn: string, args: Record<string, unknown>) {
      return {
        single: async () => {
          const row = rows.get(args.p_id as string);
          if (!row) return { data: null, error: { message: "not found" } };
          const now = Date.now();
          const notExpired = new Date(row.expiresAt).getTime() > now;

          if (fn === "confirm_pending_action") {
            if (row.confirmedAt !== null || row.consumedAt !== null || !notExpired) {
              return { data: null, error: { message: "cannot be confirmed (already confirmed, consumed, or expired)" } };
            }
            row.confirmedAt = new Date().toISOString();
            return { data: { ...toDbRow(row) }, error: null };
          }

          if (fn === "consume_pending_action") {
            const hashMatches = row.tool === args.p_tool && row.argsHash === args.p_args_hash;
            const eligible = row.confirmedAt !== null && row.consumedAt === null && notExpired && hashMatches;
            if (!eligible) {
              return { data: null, error: { message: "not confirmed, already consumed, expired, or its arguments no longer match" } };
            }
            row.consumedAt = new Date().toISOString();
            return { data: { ...toDbRow(row) }, error: null };
          }

          throw new Error(`unexpected rpc: ${fn}`);
        },
      };
    },
  };

  function toDbRow(row: FakeRow) {
    return {
      id: row.id,
      workflow_id: "22222222-2222-2222-2222-222222222222",
      tool: row.tool,
      args_hash: row.argsHash,
      args: {},
      created_at: new Date(0).toISOString(),
      expires_at: row.expiresAt,
      confirmed_at: row.confirmedAt,
      confirmed_by: row.confirmedAt ? "11111111-1111-1111-1111-111111111111" : null,
      consumed_at: row.consumedAt,
    };
  }

  return { supabase, insert };
}

const TEN_MIN_FROM_NOW = new Date(Date.now() + 10 * 60_000).toISOString();
const ONE_MIN_AGO = new Date(Date.now() - 60_000).toISOString();

describe("hashToolArgs", () => {
  it("is stable regardless of key order (canonical)", () => {
    const a = hashToolArgs("start_run", { workflowId: "wf-1", destNodeIds: ["d1"] });
    const b = hashToolArgs("start_run", { destNodeIds: ["d1"], workflowId: "wf-1" });
    expect(a).toBe(b);
  });

  it("changes when the arguments actually change", () => {
    const a = hashToolArgs("start_run", { workflowId: "wf-1", destNodeIds: ["d1"] });
    const b = hashToolArgs("start_run", { workflowId: "wf-1", destNodeIds: ["d2"] });
    expect(a).not.toBe(b);
  });

  it("changes when the tool name changes for identical args", () => {
    const a = hashToolArgs("start_run", { workflowId: "wf-1" });
    const b = hashToolArgs("cancel_run", { workflowId: "wf-1" });
    expect(a).not.toBe(b);
  });
});

describe("consumePendingAction: matching hash + confirmed + not expired", () => {
  let db: ReturnType<typeof makeFakeDb>;
  const args = { workflowId: "wf-1", destNodeIds: ["d1"] };

  beforeEach(() => {
    db = makeFakeDb();
  });

  it("succeeds when confirmed, not expired, and the args hash matches exactly what was confirmed", async () => {
    db.insert({ id: "p1", tool: "start_run", argsHash: hashToolArgs("start_run", args), confirmedAt: new Date().toISOString(), consumedAt: null, expiresAt: TEN_MIN_FROM_NOW });

    const result = await consumePendingAction(db.supabase as never, "p1", "start_run", args);
    expect(result.id).toBe("p1");
    expect(result.consumedAt).not.toBeNull();
  });

  it("refuses when the pending action was never confirmed", async () => {
    db.insert({ id: "p1", tool: "start_run", argsHash: hashToolArgs("start_run", args), confirmedAt: null, consumedAt: null, expiresAt: TEN_MIN_FROM_NOW });

    await expect(consumePendingAction(db.supabase as never, "p1", "start_run", args)).rejects.toThrow(/not confirmed/i);
  });

  it("refuses when the execution-time arguments differ from what was confirmed (hash mismatch)", async () => {
    // Confirmed for destNodeIds ["d1"], but the tool is about to execute
    // with ["d2"] — a bait-and-switch this must reject, since the pending
    // action's args_hash only matches the originally-confirmed arguments.
    db.insert({ id: "p1", tool: "start_run", argsHash: hashToolArgs("start_run", args), confirmedAt: new Date().toISOString(), consumedAt: null, expiresAt: TEN_MIN_FROM_NOW });

    const tamperedArgs = { workflowId: "wf-1", destNodeIds: ["d2"] };
    await expect(consumePendingAction(db.supabase as never, "p1", "start_run", tamperedArgs)).rejects.toThrow(
      /not confirmed|arguments no longer match/i,
    );
  });

  it("refuses when the pending action has expired, even though it was confirmed with a matching hash", async () => {
    db.insert({ id: "p1", tool: "start_run", argsHash: hashToolArgs("start_run", args), confirmedAt: new Date().toISOString(), consumedAt: null, expiresAt: ONE_MIN_AGO });

    await expect(consumePendingAction(db.supabase as never, "p1", "start_run", args)).rejects.toThrow(/not confirmed/i);
  });

  it("refuses on replay: a pending action already consumed once cannot be consumed again", async () => {
    db.insert({ id: "p1", tool: "start_run", argsHash: hashToolArgs("start_run", args), confirmedAt: new Date().toISOString(), consumedAt: null, expiresAt: TEN_MIN_FROM_NOW });

    await consumePendingAction(db.supabase as never, "p1", "start_run", args);
    await expect(consumePendingAction(db.supabase as never, "p1", "start_run", args)).rejects.toThrow(/not confirmed/i);
  });
});

describe("confirmPendingAction", () => {
  it("refuses to confirm an already-expired pending action", async () => {
    const db = makeFakeDb();
    db.insert({ id: "p1", tool: "start_run", argsHash: "irrelevant", confirmedAt: null, consumedAt: null, expiresAt: ONE_MIN_AGO });

    await expect(confirmPendingAction(db.supabase as never, "p1")).rejects.toThrow(/already confirmed, consumed, or expired/i);
  });

  it("refuses to confirm an already-consumed pending action", async () => {
    const db = makeFakeDb();
    db.insert({ id: "p1", tool: "start_run", argsHash: "irrelevant", confirmedAt: new Date().toISOString(), consumedAt: new Date().toISOString(), expiresAt: TEN_MIN_FROM_NOW });

    await expect(confirmPendingAction(db.supabase as never, "p1")).rejects.toThrow(/already confirmed, consumed, or expired/i);
  });
});
