import { describe, expect, it, vi, beforeEach } from "vitest";
import { parseExpression } from "@nia/schemas";
import type { GraphDoc, OnFailurePolicy, TransformStep } from "@nia/schemas";
import type { Queue } from "bullmq";

/**
 * Block 3.5 item 5 — the minimal runner test suite. Mocks only the I/O
 * boundary (resolveGraph/resolveConnection/getSchema/dispatch/dispatchWrite/
 * workflowRuns.js/publish.js), same pattern as runPreview.test.ts, so the
 * real findSourcePath/findPersistedEntity/resolveSourceEntity/
 * compilePushdown/manifestDialect/buildEtlReadQuery all run for real.
 *
 * Covers, per the Block 3.5 spec: chunk loop happy path (both the
 * not-last-chunk and last-chunk/done branches); failed write -> no cursor
 * advance; resume from mid-cursor (Postgres wins over the job payload's
 * cursor hint); cancel between chunks; unique-key-missing hard fail; and
 * keyset query shape per dialect (SQL WHERE/ORDER BY, Mongo _id $match).
 */

const resolveGraphMock = vi.fn();
vi.mock("../checks/runWorkflowChecks.js", () => ({
  resolveGraph: (...args: unknown[]) => resolveGraphMock(...args),
}));

const resolveConnectionMock = vi.fn();
vi.mock("../resolveConnection.js", () => ({
  resolveConnection: (...args: unknown[]) => resolveConnectionMock(...args),
}));

const getSchemaMock = vi.fn();
vi.mock("../introspection.js", () => ({
  getSchema: (...args: unknown[]) => getSchemaMock(...args),
}));

const dispatchMock = vi.fn();
vi.mock("../dispatch.js", () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args),
}));

const dispatchWriteMock = vi.fn();
vi.mock("../writeDispatch.js", () => ({
  dispatchWrite: (...args: unknown[]) => dispatchWriteMock(...args),
}));

const startRunMock = vi.fn();
const recordChunkProgressMock = vi.fn();
const finishRunMock = vi.fn();
const getRunCheckpointMock = vi.fn();
vi.mock("./workflowRuns.js", () => ({
  startRun: (...args: unknown[]) => startRunMock(...args),
  recordChunkProgress: (...args: unknown[]) => recordChunkProgressMock(...args),
  finishRun: (...args: unknown[]) => finishRunMock(...args),
  getRunCheckpoint: (...args: unknown[]) => getRunCheckpointMock(...args),
}));

const publishRunEventMock = vi.fn();
vi.mock("./publish.js", () => ({
  publishRunEvent: (...args: unknown[]) => publishRunEventMock(...args),
}));

const { runEtl } = await import("./runEtl.js");
type EtlRunJob = Parameters<typeof runEtl>[0];

const SCOPE = { orgId: "org-1" };
const SOURCE_CONN = "11111111-1111-1111-1111-111111111111";
const DEST_CONN = "22222222-2222-2222-2222-222222222222";
const RUN_ID = "33333333-3333-3333-3333-333333333333";

function baseJob(overrides: Partial<EtlRunJob> = {}): EtlRunJob {
  return {
    kind: "etl_run",
    scope: SCOPE,
    workflowId: "wf-1",
    runId: RUN_ID,
    nodeId: "dest",
    cursor: null,
    chunkSize: 10,
    triggeredByUserId: "user-1",
    ...overrides,
  };
}

function graph(opts: { dialect?: string } = {}): GraphDoc {
  const manifestId = opts.dialect ?? "mysql";
  return {
    nodes: [
      {
        id: "src",
        type: "source",
        manifestId,
        connectionId: SOURCE_CONN,
        position: { x: 0, y: 0 },
        config: { operation: "read", entity: { namespace: "public", name: "users" } },
      },
      {
        id: "dest",
        type: "destination",
        manifestId: "supabase",
        connectionId: DEST_CONN,
        position: { x: 0, y: 0 },
        config: {
          operation: "insert",
          entity: { namespace: "public", name: "users_dest" },
          mapping: { version: 1, entries: [{ from: "email", to: "email_address" }], approvedAt: "2026-01-01T00:00:00.000Z" },
          upsertKeys: ["email_address"],
          // This suite (Block 3.5) covers chunk-loop/cursor/resume mechanics
          // via dispatchWrite, predating Phase 11's staging lifecycle —
          // pinned to "direct" so it keeps exercising exactly that path
          // unaffected by the now-default "staged" mode's preflight/stage
          // calls (covered separately by stagedWrite's own tests).
          writeMode: "direct",
        },
      },
    ],
    edges: [{ id: "e0", source: "src", target: "dest" }],
  };
}

function schema(primaryKey: string | null = "id") {
  return {
    ok: true as const,
    value: {
      entities: [
        {
          namespace: "public",
          name: "users",
          fields: [{ name: "id", type: "string" }, { name: "email", type: "string" }],
          primaryKey,
        },
      ],
    },
  };
}

function tabularResult(
  rows: unknown[][] = [["1", "a@example.com"], ["2", "b@example.com"]],
  columns: { name: string; type: "string" }[] = [{ name: "id", type: "string" }, { name: "email", type: "string" }],
) {
  return {
    ok: true as const,
    value: {
      columns,
      rows,
      meta: { executedQuery: "SELECT 1", connectionId: SOURCE_CONN, durationMs: 1, rowCount: rows.length, truncated: false },
    },
  };
}

function queueStub() {
  return { add: vi.fn() } as unknown as Queue;
}

beforeEach(() => {
  resolveGraphMock.mockReset();
  resolveConnectionMock.mockReset();
  getSchemaMock.mockReset();
  dispatchMock.mockReset();
  dispatchWriteMock.mockReset();
  startRunMock.mockReset();
  recordChunkProgressMock.mockReset();
  finishRunMock.mockReset();
  getRunCheckpointMock.mockReset();
  publishRunEventMock.mockReset();

  resolveGraphMock.mockResolvedValue(graph());
  resolveConnectionMock.mockImplementation(async (connectionId: string) => ({
    ok: true,
    value: { id: connectionId, manifest: {}, credential: {}, config: {} },
  }));
  getSchemaMock.mockResolvedValue(schema());
  dispatchMock.mockResolvedValue(tabularResult());
  dispatchWriteMock.mockResolvedValue({ ok: true, value: { written: 2, durationMs: 1 } });
  startRunMock.mockResolvedValue(undefined);
  recordChunkProgressMock.mockResolvedValue(2);
  finishRunMock.mockResolvedValue(1234);
  getRunCheckpointMock.mockResolvedValue({ status: "running", cursor: null });
  publishRunEventMock.mockResolvedValue(undefined);
});

describe("runEtl — chunk loop happy path", () => {
  it("writes the mapped rows, advances the cursor, and self-enqueues the next chunk when the source page is full", async () => {
    dispatchMock.mockResolvedValueOnce(tabularResult([["1", "a@example.com"], ["2", "b@example.com"]]));
    const queue = queueStub();
    const job = baseJob({ chunkSize: 2 });

    const result = await runEtl(job, queue);

    expect(result).toEqual({ status: "chunk", nextCursor: "2" });
    expect(startRunMock).toHaveBeenCalledWith(job.runId, job.workflowId, job.scope);

    expect(dispatchWriteMock).toHaveBeenCalledTimes(1);
    const [connId, input] = dispatchWriteMock.mock.calls[0]!;
    expect(connId).toBe(DEST_CONN);
    expect(input.entity).toEqual({ namespace: "public", name: "users_dest" });
    expect(input.columns).toEqual(["email_address"]);
    expect(input.rows).toEqual([["a@example.com"], ["b@example.com"]]);
    expect(input.upsertKeys).toEqual(["email_address"]);

    expect(recordChunkProgressMock).toHaveBeenCalledWith(job.runId, 2, JSON.stringify({ lastKey: "2", groupKey: null }));
    expect(finishRunMock).not.toHaveBeenCalled();

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [, nextJob] = (queue.add as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(nextJob.cursor).toBe(JSON.stringify({ lastKey: "2", groupKey: null }));
    expect(publishRunEventMock).toHaveBeenCalledWith(SCOPE, job.runId, expect.objectContaining({ type: "progress" }));
  });

  it("finishes the run and publishes done when the source returns fewer rows than requested", async () => {
    const queue = queueStub();
    const job = baseJob({ chunkSize: 10 });

    const result = await runEtl(job, queue);

    expect(result).toEqual({ status: "done" });
    expect(finishRunMock).toHaveBeenCalledWith(job.runId, "succeeded");
    expect(publishRunEventMock).toHaveBeenCalledWith(SCOPE, job.runId, expect.objectContaining({ type: "done" }));
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("does not call startRun on a resumed (non-first) chunk", async () => {
    const queue = queueStub();
    await runEtl(baseJob({ cursor: JSON.stringify({ lastKey: "1" }) }), queue);
    expect(startRunMock).not.toHaveBeenCalled();
    expect(publishRunEventMock).not.toHaveBeenCalledWith(SCOPE, RUN_ID, expect.objectContaining({ type: "started" }));
  });
});

describe("runEtl — failed write", () => {
  it("does not advance the cursor or self-enqueue, and marks the run failed", async () => {
    dispatchWriteMock.mockResolvedValueOnce({ ok: false, error: { kind: "write-rejected", message: "boom" } });
    const queue = queueStub();
    const job = baseJob();

    const result = await runEtl(job, queue);

    expect(result.status).toBe("failed");
    expect(result.message).toContain("boom");
    expect(recordChunkProgressMock).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(finishRunMock).toHaveBeenCalledWith(job.runId, "failed");
    expect(publishRunEventMock).toHaveBeenCalledWith(SCOPE, job.runId, expect.objectContaining({ type: "error" }));
  });
});

describe("runEtl — aggregate pagination (Phase 9 Part 3)", () => {
  it("pages by group key instead of failing when a pushed aggregate's fetched rows hit the cap", async () => {
    const aggregateGraph: GraphDoc = {
      nodes: [
        graph().nodes[0]!,
        {
          id: "agg",
          type: "transform",
          position: { x: 200, y: 0 },
          config: { steps: [{ kind: "aggregate", groupBy: ["cohort"], aggregations: [{ fn: "count", field: null, alias: "n" }] }] },
        },
        {
          id: "dest",
          type: "destination",
          manifestId: "supabase",
          connectionId: DEST_CONN,
          position: { x: 400, y: 0 },
          config: {
            operation: "insert",
            entity: { namespace: "public", name: "users_dest" },
            mapping: {
              version: 1,
              entries: [
                { from: "cohort", to: "cohort" },
                { from: "n", to: "n" },
              ],
              approvedAt: "2026-01-01T00:00:00.000Z",
            },
            upsertKeys: ["cohort"],
            writeMode: "direct",
          },
        },
      ],
      edges: [
        { id: "e0", source: "src", target: "agg" },
        { id: "e1", source: "agg", target: "dest" },
      ],
    };
    resolveGraphMock.mockResolvedValueOnce(aggregateGraph);

    const requestedLimit = 2;
    dispatchMock.mockResolvedValueOnce(
      tabularResult(
        [
          ["eng", "3", "eng"],
          ["sales", "2", "sales"],
        ],
        [
          { name: "cohort", type: "string" },
          { name: "n", type: "string" },
          { name: "__nia_group_cursor_0", type: "string" },
        ],
      ),
    );
    const queue = queueStub();
    const job = baseJob({ chunkSize: requestedLimit });

    const result = await runEtl(job, queue);

    // Phase 9 Part 3: hitting the cap no longer fails the run — it's
    // treated exactly like row-keyset hitting the cap, i.e. "there may be
    // more" so this is not the last chunk. This chunk's rows still write,
    // and the next job's cursor carries the last emitted group's group-by
    // values ("sales", the second/last row above) as the group-key cursor.
    expect(result).toEqual({ status: "chunk", nextCursor: null });
    expect(dispatchWriteMock).toHaveBeenCalledTimes(1);
    expect(recordChunkProgressMock).toHaveBeenCalledWith(
      job.runId,
      2,
      JSON.stringify({ lastKey: null, groupKey: ["sales"] }),
    );
    expect(queue.add).toHaveBeenCalledTimes(1);
    const [, nextJob] = (queue.add as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(nextJob.cursor).toBe(JSON.stringify({ lastKey: null, groupKey: ["sales"] }));
    expect(finishRunMock).not.toHaveBeenCalled();
    expect(publishRunEventMock).toHaveBeenCalledWith(SCOPE, job.runId, expect.objectContaining({ type: "progress" }));
  });

  it("does not fail when a pushed aggregate's fetched rows are under the cap", async () => {
    const aggregateGraph: GraphDoc = {
      nodes: [
        graph().nodes[0]!,
        {
          id: "agg",
          type: "transform",
          position: { x: 200, y: 0 },
          config: { steps: [{ kind: "aggregate", groupBy: ["cohort"], aggregations: [{ fn: "count", field: null, alias: "n" }] }] },
        },
        {
          id: "dest",
          type: "destination",
          manifestId: "supabase",
          connectionId: DEST_CONN,
          position: { x: 400, y: 0 },
          config: {
            operation: "insert",
            entity: { namespace: "public", name: "users_dest" },
            mapping: {
              version: 1,
              entries: [
                { from: "cohort", to: "cohort" },
                { from: "n", to: "n" },
              ],
              approvedAt: "2026-01-01T00:00:00.000Z",
            },
            upsertKeys: ["cohort"],
            writeMode: "direct",
          },
        },
      ],
      edges: [
        { id: "e0", source: "src", target: "agg" },
        { id: "e1", source: "agg", target: "dest" },
      ],
    };
    resolveGraphMock.mockResolvedValueOnce(aggregateGraph);

    dispatchMock.mockResolvedValueOnce(
      tabularResult(
        [["eng", "3"]],
        [
          { name: "cohort", type: "string" },
          { name: "n", type: "string" },
        ],
      ),
    );
    const queue = queueStub();
    const job = baseJob({ chunkSize: 10 });

    const result = await runEtl(job, queue);

    expect(result.status).toBe("done");
    expect(dispatchWriteMock).toHaveBeenCalledTimes(1);
    expect(finishRunMock).toHaveBeenCalledWith(job.runId, "succeeded");
  });

  it("resumes a pushed aggregate's second page from the persisted group-key cursor (Phase 9 Part 3 pagination resume)", async () => {
    const aggregateGraph: GraphDoc = {
      nodes: [
        graph().nodes[0]!,
        {
          id: "agg",
          type: "transform",
          position: { x: 200, y: 0 },
          config: { steps: [{ kind: "aggregate", groupBy: ["cohort"], aggregations: [{ fn: "count", field: null, alias: "n" }] }] },
        },
        {
          id: "dest",
          type: "destination",
          manifestId: "supabase",
          connectionId: DEST_CONN,
          position: { x: 400, y: 0 },
          config: {
            operation: "insert",
            entity: { namespace: "public", name: "users_dest" },
            mapping: {
              version: 1,
              entries: [
                { from: "cohort", to: "cohort" },
                { from: "n", to: "n" },
              ],
              approvedAt: "2026-01-01T00:00:00.000Z",
            },
            upsertKeys: ["cohort"],
            writeMode: "direct",
          },
        },
      ],
      edges: [
        { id: "e0", source: "src", target: "agg" },
        { id: "e1", source: "agg", target: "dest" },
      ],
    };
    resolveGraphMock.mockResolvedValue(aggregateGraph);

    const requestedLimit = 2;
    // First page: exactly chunkSize rows -> "chunk", cursor carries the
    // last emitted group's group-by tuple ("sales").
    dispatchMock.mockResolvedValueOnce(
      tabularResult(
        [
          ["eng", "3", "eng"],
          ["sales", "2", "sales"],
        ],
        [
          { name: "cohort", type: "string" },
          { name: "n", type: "string" },
          { name: "__nia_group_cursor_0", type: "string" },
        ],
      ),
    );
    const queue = queueStub();
    const job = baseJob({ chunkSize: requestedLimit });

    const firstResult = await runEtl(job, queue);
    expect(firstResult).toEqual({ status: "chunk", nextCursor: null });
    const [, firstNextJob] = (queue.add as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const persistedCursor = firstNextJob.cursor as string;
    expect(persistedCursor).toBe(JSON.stringify({ lastKey: null, groupKey: ["sales"] }));

    // Second invocation (self-enqueued resume): same job, cursor now set to
    // the first call's persisted group-key cursor. Under the cap -> "done".
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValueOnce(
      tabularResult(
        [["ops", "1", "ops"]],
        [
          { name: "cohort", type: "string" },
          { name: "n", type: "string" },
          { name: "__nia_group_cursor_0", type: "string" },
        ],
      ),
    );
    const resumedJob = baseJob({ chunkSize: requestedLimit, cursor: persistedCursor });

    const secondResult = await runEtl(resumedJob, queue);

    expect(secondResult).toEqual({ status: "done" });
    // Proves the second page's compiled query actually threaded the
    // persisted group-key cursor through (Part 2's ParamSink path), not
    // just that pagination happened to stop — the cursor's "sales" value
    // must appear as a bound param in the recompiled group-keyset WHERE.
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [, secondQuery] = dispatchMock.mock.calls[0]!;
    expect(secondQuery.params).toContain("sales");
    expect(dispatchWriteMock).toHaveBeenCalledTimes(2);
    expect(finishRunMock).toHaveBeenCalledWith(resumedJob.runId, "succeeded");
  });
});

describe("runEtl — onFailure abort / failure-count threading (Phase 8b-3)", () => {
  // Two chained transform nodes, not one: runEtl.ts only attempts pushdown
  // when `transforms.length === 1` (compilePushdown "never designed to
  // chain pushdown across multiple nodes" — see its header comment); with
  // two nodes every step runs fully residual regardless of its onFailure
  // policy's own pushability, which is what lets this suite observe
  // applyResidualTransforms's real abort/failure-count behavior without
  // also having to simulate a dialect actually computing the pushed column.
  function transformGraph(step: TransformStep, mapFrom = "y"): GraphDoc {
    return {
      nodes: [
        graph().nodes[0]!,
        { id: "noop", type: "transform", position: { x: 100, y: 0 }, config: { steps: [] } },
        {
          id: "cf",
          type: "transform",
          position: { x: 200, y: 0 },
          config: { steps: [step] },
        },
        {
          id: "dest",
          type: "destination",
          manifestId: "supabase",
          connectionId: DEST_CONN,
          position: { x: 400, y: 0 },
          config: {
            operation: "insert",
            entity: { namespace: "public", name: "users_dest" },
            mapping: { version: 1, entries: [{ from: mapFrom, to: mapFrom }], approvedAt: "2026-01-01T00:00:00.000Z" },
            upsertKeys: [mapFrom],
            writeMode: "direct",
          },
        },
      ],
      edges: [
        { id: "e0", source: "src", target: "noop" },
        { id: "e1", source: "noop", target: "cf" },
        { id: "e2", source: "cf", target: "dest" },
      ],
    };
  }

  function expr(source: string) {
    const parsed = parseExpression(source);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.expr;
  }

  function fallibleStep(onFailure: OnFailurePolicy): TransformStep {
    return { kind: "computed_field", name: "y", expression: expr("to_number(amount)"), onFailure };
  }

  function amountRows(rows: [string, string][]) {
    return tabularResult(
      rows.map(([id, amount]) => [id, amount]),
      [
        { name: "id", type: "string" },
        { name: "amount", type: "string" },
      ],
    );
  }

  it("aborts the run cleanly when onFailure: 'fail' hits an invalid row, without writing", async () => {
    resolveGraphMock.mockResolvedValueOnce(transformGraph(fallibleStep("fail")));
    dispatchMock.mockResolvedValueOnce(
      amountRows([
        ["1", "10"],
        ["2", "abc"],
      ]),
    );
    const queue = queueStub();
    const job = baseJob();

    const result = await runEtl(job, queue);

    expect(result.status).toBe("failed");
    expect(result.message).toBe('computed_field "y": to_number failed on 1 row(s).');
    expect(dispatchWriteMock).not.toHaveBeenCalled();
    expect(recordChunkProgressMock).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(finishRunMock).toHaveBeenCalledWith(job.runId, "failed");
    expect(publishRunEventMock).toHaveBeenCalledWith(SCOPE, job.runId, expect.objectContaining({ type: "error" }));
  });

  it("threads residual failure counts into the 'done' event when onFailure: 'null'", async () => {
    resolveGraphMock.mockResolvedValueOnce(transformGraph(fallibleStep("null")));
    dispatchMock.mockResolvedValueOnce(
      amountRows([
        ["1", "10"],
        ["2", "abc"],
      ]),
    );
    const queue = queueStub();
    const job = baseJob();

    const result = await runEtl(job, queue);

    expect(result.status).toBe("done");
    expect(dispatchWriteMock).toHaveBeenCalledTimes(1);
    expect(publishRunEventMock).toHaveBeenCalledWith(
      SCOPE,
      job.runId,
      expect.objectContaining({
        type: "done",
        failures: [{ label: 'computed_field "y"', fns: ["to_number"], policy: "null", count: 1 }],
      }),
    );
  });

  it("reports a zero count (not silence) when a fallible step's calls all succeed", async () => {
    // Per Step 2's "every policy reports per-step failure counts ... no
    // policy is silent": computeFailureReport (ops/onFailure.ts) always
    // contributes a report for a fallible-containing step, even count: 0,
    // and runEtl.ts threads every residual report straight into the
    // chunk's "done" event unfiltered. Contrast with the next test, where
    // the step has no fallible call at all and contributes no report.
    resolveGraphMock.mockResolvedValueOnce(transformGraph(fallibleStep("null")));
    dispatchMock.mockResolvedValueOnce(
      amountRows([
        ["1", "10"],
        ["2", "20"],
      ]),
    );
    const queue = queueStub();
    const job = baseJob();

    const result = await runEtl(job, queue);

    expect(result.status).toBe("done");
    expect(publishRunEventMock).toHaveBeenCalledWith(
      SCOPE,
      job.runId,
      expect.objectContaining({
        type: "done",
        failures: [{ label: 'computed_field "y"', fns: ["to_number"], policy: "null", count: 0 }],
      }),
    );
  });

  it("omits 'failures' entirely from the 'done' event for a step with no fallible calls", async () => {
    // A `filter` step never produces a `y` field (only `computed_field`
    // does) — transformGraph's dest mapping is rewritten here to map
    // `amount` instead, since that's the only field this step's output
    // actually carries.
    const noopFilterStep: TransformStep = { kind: "filter", expr: expr("amount > 0"), onFailure: "fail" };
    const g = transformGraph(noopFilterStep);
    resolveGraphMock.mockResolvedValueOnce({
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === "dest" && n.type === "destination"
          ? {
              ...n,
              config: {
                ...n.config,
                mapping: { version: 1, entries: [{ from: "amount", to: "amount" }], approvedAt: "2026-01-01T00:00:00.000Z" },
                upsertKeys: ["amount"],
              },
            }
          : n,
      ),
    });
    dispatchMock.mockResolvedValueOnce(
      amountRows([
        ["1", "10"],
        ["2", "20"],
      ]),
    );
    const queue = queueStub();
    const job = baseJob();

    const result = await runEtl(job, queue);

    expect(result.status).toBe("done");
    const doneCall = publishRunEventMock.mock.calls.find(([, , event]) => (event as { type: string }).type === "done");
    expect(doneCall).toBeDefined();
    expect((doneCall![2] as { failures?: unknown }).failures).toBeUndefined();
  });
});

describe("runEtl — resume from mid-cursor", () => {
  it("prefers the persisted Postgres checkpoint cursor over the job payload's own cursor hint", async () => {
    getRunCheckpointMock.mockResolvedValueOnce({ status: "running", cursor: JSON.stringify({ lastKey: "50" }) });
    const queue = queueStub();

    await runEtl(baseJob({ cursor: JSON.stringify({ lastKey: "5" }) }), queue);

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [, query] = dispatchMock.mock.calls[0]!;
    expect(query.params).toEqual(["50"]);
  });
});

describe("runEtl — cancel between chunks", () => {
  it("short-circuits before any read/write when the checkpoint reports cancelled, without re-enqueuing", async () => {
    getRunCheckpointMock.mockResolvedValueOnce({ status: "cancelled", cursor: null });
    const queue = queueStub();
    const job = baseJob({ cursor: JSON.stringify({ lastKey: "5" }) });

    const result = await runEtl(job, queue);

    expect(result).toEqual({ status: "cancelled" });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(dispatchWriteMock).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(publishRunEventMock).toHaveBeenCalledWith(SCOPE, job.runId, { type: "cancel", nodeId: job.nodeId });
  });
});

describe("runEtl — unique-key-missing hard fail", () => {
  it("fails at run start when a SQL source entity has no verified single-column key", async () => {
    getSchemaMock.mockResolvedValueOnce(schema(null));
    const queue = queueStub();
    const job = baseJob();

    const result = await runEtl(job, queue);

    expect(result.status).toBe("failed");
    expect(result.message).toContain("public.users");
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(finishRunMock).toHaveBeenCalledWith(job.runId, "failed");
  });
});

describe("runEtl — stateful residual op (Phase 9 Part 1)", () => {
  // Two chained transform nodes (not one), same reason as the onFailure
  // suite above: runEtl.ts only attempts pushdown when
  // `transforms.length === 1`, so with two nodes the `aggregate` step
  // always stays residual regardless of dialect support — exactly the
  // shape that needs the cross-chunk accumulator, never pushdown.
  function statefulAggregateGraph(): GraphDoc {
    return {
      nodes: [
        graph().nodes[0]!,
        { id: "noop", type: "transform", position: { x: 100, y: 0 }, config: { steps: [] } },
        {
          id: "agg",
          type: "transform",
          position: { x: 200, y: 0 },
          config: { steps: [{ kind: "aggregate", groupBy: ["cohort"], aggregations: [{ fn: "sum", field: "salary", alias: "total" }] }] },
        },
        {
          id: "dest",
          type: "destination",
          manifestId: "supabase",
          connectionId: DEST_CONN,
          position: { x: 400, y: 0 },
          config: {
            operation: "insert",
            entity: { namespace: "public", name: "users_dest" },
            mapping: {
              version: 1,
              entries: [
                { from: "cohort", to: "cohort" },
                { from: "total", to: "total" },
              ],
              approvedAt: "2026-01-01T00:00:00.000Z",
            },
            upsertKeys: ["cohort"],
            writeMode: "direct",
          },
        },
      ],
      edges: [
        { id: "e0", source: "src", target: "noop" },
        { id: "e1", source: "noop", target: "agg" },
        { id: "e2", source: "agg", target: "dest" },
      ],
    };
  }

  function chunkRows(rows: [string, string, number][]) {
    return tabularResult(
      rows.map(([id, cohort, salary]) => [id, cohort, salary]),
      [
        { name: "id", type: "string" },
        { name: "cohort", type: "string" },
        { name: "salary", type: "string" },
      ],
    );
  }

  function writtenTotalsByCohort(): Record<string, number> {
    const [, input] = dispatchWriteMock.mock.calls[dispatchWriteMock.mock.calls.length - 1]!;
    const cohortIdx = input.columns.indexOf("cohort");
    const totalIdx = input.columns.indexOf("total");
    return Object.fromEntries(input.rows.map((r: unknown[]) => [r[cohortIdx], r[totalIdx]]));
  }

  it("(a) matches the single-chunk result when the source spans 3+ fetched chunks", async () => {
    resolveGraphMock.mockResolvedValue(statefulAggregateGraph());
    dispatchMock
      .mockResolvedValueOnce(chunkRows([["1", "eng", 100], ["2", "sales", 50]]))
      .mockResolvedValueOnce(chunkRows([["3", "eng", 200], ["4", "sales", 30]]))
      .mockResolvedValueOnce(chunkRows([["5", "eng", 50]]));
    const queue = queueStub();
    const job = baseJob({ chunkSize: 2 });

    const result = await runEtl(job, queue);

    expect(result).toEqual({ status: "done" });
    expect(dispatchMock).toHaveBeenCalledTimes(3);
    expect(dispatchWriteMock).toHaveBeenCalledTimes(1);
    expect(writtenTotalsByCohort()).toEqual({ eng: 350, sales: 80 });
    // Never a per-chunk write mid-loop and never a next-chunk self-enqueue
    // — the whole run is one job invocation (see runStatefulResidual's doc
    // comment).
    expect(queue.add).not.toHaveBeenCalled();
    expect(recordChunkProgressMock).toHaveBeenCalledTimes(1);
    expect(finishRunMock).toHaveBeenCalledWith(job.runId, "succeeded");
    expect(publishRunEventMock).toHaveBeenCalledWith(SCOPE, job.runId, expect.objectContaining({ type: "done" }));
  });

  it("(b) a kill after chunk 1 and a resumed retry together match the full-data result", async () => {
    resolveGraphMock.mockResolvedValue(statefulAggregateGraph());
    const queue = queueStub();
    const job = baseJob({ chunkSize: 2 });

    // "Killed after chunk 1": chunk 1 reads fine, chunk 2's read never
    // comes back (the worker died mid-loop) — an unexpected rejection,
    // left to propagate rather than converted to a clean fail() (matches
    // this file's header comment on genuinely unexpected exceptions).
    dispatchMock
      .mockResolvedValueOnce(chunkRows([["1", "eng", 100], ["2", "sales", 50]]))
      .mockRejectedValueOnce(new Error("connection reset — simulated kill"));

    await expect(runEtl(job, queue)).rejects.toThrow("simulated kill");
    expect(dispatchWriteMock).not.toHaveBeenCalled();
    expect(recordChunkProgressMock).not.toHaveBeenCalled();
    expect(finishRunMock).not.toHaveBeenCalled();

    // "Resumed": BullMQ redelivers the exact same job (cursor: null,
    // nothing was ever persisted mid-loop). A stale/unrelated persisted
    // checkpoint cursor must still be ignored (per the plan: "resume
    // restarts extraction from the beginning ... when a stateful op is
    // present") — asserted below via the first read having no cursor
    // filter, not just via the final total.
    dispatchMock.mockReset();
    getRunCheckpointMock.mockReset();
    getRunCheckpointMock.mockResolvedValue({ status: "running", cursor: JSON.stringify({ lastKey: "999" }) });
    dispatchMock
      .mockResolvedValueOnce(chunkRows([["1", "eng", 100], ["2", "sales", 50]]))
      .mockResolvedValueOnce(chunkRows([["3", "eng", 200], ["4", "sales", 30]]))
      .mockResolvedValueOnce(chunkRows([["5", "eng", 50]]));

    const resumedResult = await runEtl(job, queue);

    expect(resumedResult).toEqual({ status: "done" });
    const [, firstQuery] = dispatchMock.mock.calls[0]!;
    expect(firstQuery.sql).not.toContain("WHERE");
    expect(firstQuery.params).toEqual([]);
    expect(writtenTotalsByCohort()).toEqual({ eng: 350, sales: 80 });
  });

  it("(c) fails loudly, without writing, once the group cap is exceeded", async () => {
    resolveGraphMock.mockResolvedValue(statefulAggregateGraph());
    dispatchMock.mockResolvedValueOnce(
      chunkRows([
        ["1", "eng", 100],
        ["2", "sales", 50],
        ["3", "ops", 10],
      ]),
    );
    const queue = queueStub();
    const job = baseJob({ chunkSize: 10 });

    const previousCap = process.env.RESIDUAL_GROUP_CAP;
    process.env.RESIDUAL_GROUP_CAP = "2";
    try {
      const result = await runEtl(job, queue);

      expect(result.status).toBe("failed");
      expect(result.message).toContain("2");
      expect(result.message!.toLowerCase()).toContain("cap");
      expect(dispatchWriteMock).not.toHaveBeenCalled();
      expect(recordChunkProgressMock).not.toHaveBeenCalled();
      expect(finishRunMock).toHaveBeenCalledWith(job.runId, "failed");
      expect(publishRunEventMock).toHaveBeenCalledWith(SCOPE, job.runId, expect.objectContaining({ type: "error" }));
    } finally {
      if (previousCap === undefined) delete process.env.RESIDUAL_GROUP_CAP;
      else process.env.RESIDUAL_GROUP_CAP = previousCap;
    }
  });
});

describe("runEtl — keyset query shape per dialect", () => {
  it("builds a keyset SQL query with no WHERE clause on the first chunk", async () => {
    const queue = queueStub();
    await runEtl(baseJob(), queue);

    const [, query] = dispatchMock.mock.calls[0]!;
    expect(query.kind).toBe("sql");
    expect(query.sql).toBe("SELECT * FROM `public`.`users` ORDER BY `id` LIMIT 10");
    expect(query.params).toEqual([]);
  });

  it("adds a keyed WHERE > cursor clause once a cursor is present", async () => {
    getRunCheckpointMock.mockResolvedValueOnce({ status: "running", cursor: JSON.stringify({ lastKey: "50" }) });
    const queue = queueStub();
    await runEtl(baseJob({ cursor: JSON.stringify({ lastKey: "5" }) }), queue);

    const [, query] = dispatchMock.mock.calls[0]!;
    // Phase 9 Part 2: the cursor condition now resolves through the same
    // ParamSink/combineAnd path as every other pushed WHERE fragment
    // (packages/schemas/src/ops/dialects/sqlShared.ts's combineAnd wraps
    // each fragment in parens) instead of being hand-appended as bare
    // text — same semantics, this is just the now-consistent shape.
    expect(query.sql).toBe("SELECT * FROM `public`.`users` WHERE (`id` > ?) ORDER BY `id` LIMIT 10");
    expect(query.params).toEqual(["50"]);
  });

  it("keys a Mongo source off _id (ignoring the entity's primaryKey) with no $match on the first chunk", async () => {
    resolveGraphMock.mockResolvedValueOnce(graph({ dialect: "mongodb" }));
    getSchemaMock.mockResolvedValueOnce(schema(null));
    dispatchMock.mockResolvedValueOnce(
      tabularResult([["m1", "a@example.com"]], [{ name: "_id", type: "string" }, { name: "email", type: "string" }]),
    );
    const queue = queueStub();

    await runEtl(baseJob(), queue);

    const [, query] = dispatchMock.mock.calls[0]!;
    expect(query.kind).toBe("mongo");
    expect(query.collection).toBe("users");
    expect(query.pipeline).toEqual([{ $sort: { _id: 1 } }, { $limit: 10 }]);
  });

  it("adds a $match _id $gt stage to the Mongo pipeline once a cursor is present", async () => {
    resolveGraphMock.mockResolvedValueOnce(graph({ dialect: "mongodb" }));
    getSchemaMock.mockResolvedValueOnce(schema(null));
    getRunCheckpointMock.mockResolvedValueOnce({ status: "running", cursor: JSON.stringify({ lastKey: "abc123" }) });
    dispatchMock.mockResolvedValueOnce(
      tabularResult([["m2", "b@example.com"]], [{ name: "_id", type: "string" }, { name: "email", type: "string" }]),
    );
    const queue = queueStub();

    await runEtl(baseJob({ cursor: JSON.stringify({ lastKey: "abc000" }) }), queue);

    const [, query] = dispatchMock.mock.calls[0]!;
    expect(query.pipeline).toEqual([{ $match: { _id: { $gt: "abc123" } } }, { $sort: { _id: 1 } }, { $limit: 10 }]);
  });
});
