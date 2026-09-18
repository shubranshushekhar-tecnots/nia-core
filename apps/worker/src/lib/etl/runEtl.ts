import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import {
  applyResidualTransforms,
  compilePushdown,
  findPersistedEntity,
  manifestDialect,
  parseNodeConfig,
  resolveSourceEntity,
  type DialectQuery,
  type EtlRunJob,
  type TransformStep,
  type WriteEntityRef,
} from "@nia/schemas";
import { resolveGraph } from "../checks/runWorkflowChecks.js";
import { resolveConnection } from "../resolveConnection.js";
import { getSchema } from "../introspection.js";
import { dispatch } from "../dispatch.js";
import { dispatchWrite } from "../writeDispatch.js";
import { findSourcePath } from "../preview/runPreview.js";
import { buildEtlReadQuery, MAX_CHUNK_ROWS } from "./queryBuilder.js";
import { startRun, recordChunkProgress, finishRun, getRunCheckpoint } from "./workflowRuns.js";
import { publishRunEvent } from "./publish.js";
import type { WorkspaceScope } from "../workspaceScope.js";

/** Block 3.5: keyset cursor — the last key value read so far, or null before the first chunk. Deliberately not `{offset}` anymore (see queryBuilder.ts's header comment). */
type Cursor = { lastKey: string | number | null };

function parseCursor(raw: string | null): Cursor {
  if (!raw) return { lastKey: null };
  try {
    const parsed = JSON.parse(raw) as Partial<Cursor>;
    const lastKey = parsed.lastKey;
    return { lastKey: typeof lastKey === "string" || typeof lastKey === "number" ? lastKey : null };
  } catch {
    return { lastKey: null };
  }
}

export type RunEtlResult = { status: "done" | "chunk" | "failed" | "cancelled"; nextCursor?: string | number | null; message?: string };

/**
 * Fails the run cleanly: marks `workflow_runs` failed, publishes an `error`
 * event, and returns normally (never throws) — a business/config failure
 * (missing mapping, unresolved entity, dispatch/write rejection) is
 * permanent for this run and must not trigger BullMQ's retry/backoff
 * policy, unlike a genuinely unexpected exception (which is left to
 * propagate naturally, same as every other index.ts job handler).
 */
async function fail(scope: WorkspaceScope, runId: string, nodeId: string, message: string): Promise<RunEtlResult> {
  await finishRun(runId, "failed");
  await publishRunEvent(scope, runId, { type: "error", nodeId, message });
  return { status: "failed", message };
}

/**
 * Phase 6 Block 3 (chunked/resumable shape) / Block 3.5 (checkpoint
 * soundness) — the real ETL runner. Chunked, checkpointed (keyset cursor
 * persisted in `workflow_runs.cursor_json` in the same step as progress —
 * see workflowRuns.ts's recordChunkProgress/getRunCheckpoint and
 * 0017_run_checkpoints.sql's header comment: "Redis is transport, Postgres
 * is checkpoint truth"), resumable (a fresh job with the same runId
 * re-derives everything from the graph + connections, consulting the
 * persisted Postgres cursor rather than trusting its own payload's cursor
 * hint), and idempotent on its one stateful write (`workflow_runs` row
 * creation, via startRun's upsert) — a BullMQ stalled-job retry
 * redelivering the exact same job is safe to fully re-run (the destination
 * upsert is itself idempotent by upsertKeys, and the read re-fetches from
 * whichever cursor Postgres says is truth, never further back).
 *
 * `queue` is the caller's own heavy-queue BullMQ Queue instance (index.ts's
 * `heavyQueue`), used to self-enqueue the next chunk's job — passed in
 * rather than constructed here so there is exactly one BullMQ Queue/Redis
 * connection for the heavy queue across the whole worker process.
 */
export async function runEtl(job: EtlRunJob, queue: Queue): Promise<RunEtlResult> {
  const scope: WorkspaceScope = { orgId: job.orgId };

  if (job.cursor === null) {
    await startRun(job.runId, job.workflowId, job.orgId);
    await publishRunEvent(scope, job.runId, { type: "started", nodeId: job.nodeId });
  }

  // Block 3.5: one read, consulted for both cancel (cooperative, checked
  // between every chunk) and checkpoint truth (persisted cursor always
  // wins over the job payload's own cursor when present — see
  // workflowRuns.ts's getRunCheckpoint doc comment for why that's safe).
  const checkpoint = await getRunCheckpoint(job.runId);
  if (checkpoint.status === "cancelled") {
    await publishRunEvent(scope, job.runId, { type: "cancel", nodeId: job.nodeId });
    return { status: "cancelled" };
  }
  const effectiveCursorRaw = checkpoint.cursor ?? job.cursor;

  const graph = await resolveGraph(job.workflowId, scope);
  if (!graph) return fail(scope, job.runId, job.nodeId, "Workflow not found in the given workspace.");

  const dest = graph.nodes.find((n) => n.id === job.nodeId && n.type === "destination");
  if (!dest || !dest.connectionId) {
    return fail(scope, job.runId, job.nodeId, `No destination node "${job.nodeId}" with a connection selected exists in this workflow.`);
  }

  const parsedDest = parseNodeConfig(dest.type, dest.config);
  const destConfig = !parsedDest.unrecognized && parsedDest.type !== "transform" ? parsedDest.value : undefined;
  const mapping = destConfig?.mapping;
  if (!mapping || !mapping.approvedAt || mapping.entries.length === 0) {
    return fail(scope, job.runId, job.nodeId, "Destination has no approved field mapping for this path yet.");
  }
  if (!destConfig?.entity) {
    return fail(scope, job.runId, job.nodeId, "Destination has no target table/collection selected yet.");
  }
  if (!destConfig.upsertKeys || destConfig.upsertKeys.length === 0) {
    return fail(scope, job.runId, job.nodeId, "Destination has no upsert key(s) selected yet.");
  }

  const path = findSourcePath(dest.id, graph);
  const sourceConnectionId = path?.source.connectionId;
  if (!path || !sourceConnectionId) {
    return fail(scope, job.runId, job.nodeId, "Destination node has no upstream source node with a connection selected.");
  }
  const { source, transforms } = path;

  const resolvedSource = await resolveConnection(sourceConnectionId, scope);
  if (!resolvedSource.ok) return fail(scope, job.runId, job.nodeId, `Source connection: ${resolvedSource.error.message}`);
  const sourceSchema = await getSchema(resolvedSource.value);
  if (!sourceSchema.ok) return fail(scope, job.runId, job.nodeId, `Source schema: ${sourceSchema.error.message}`);

  const parsedSource = parseNodeConfig(source.type, source.config);
  const persistedEntity = !parsedSource.unrecognized && parsedSource.type !== "transform" ? parsedSource.value.entity : undefined;
  // Block 3.5 item 2: unlike preview (runPreview.ts), which happily infers
  // the source table from the mapping's field names when no entity is
  // persisted, the authoritative run path hard-fails instead of guessing —
  // restores the Block 1a(1) ledger line ("source entity is required to
  // run") that checkConfig's own entity check never actually enforced (see
  // packages/schemas/src/checks.ts's amended comment on that check: it
  // stays a pre-flight `warn`, this is the real gate). Checked before
  // findPersistedEntity/resolveSourceEntity below even run, so a run never
  // silently succeeds against an inferred table the user never picked.
  if (!persistedEntity) {
    return fail(scope, job.runId, job.nodeId, `Source node "${source.id}" has no target table/collection selected yet.`);
  }
  let entity = findPersistedEntity(sourceSchema.value, persistedEntity);
  if (!entity) {
    const entityResult = resolveSourceEntity(sourceSchema.value, mapping.entries.map((e) => e.from));
    if (!entityResult.ok) return fail(scope, job.runId, job.nodeId, entityResult.message);
    entity = entityResult.entity;
  }

  const dialect = manifestDialect(source.manifestId);
  if (!dialect) {
    return fail(scope, job.runId, job.nodeId, `Source connector "${source.manifestId ?? "unknown"}" has no supported query dialect.`);
  }

  // Block 3.5 item 1a: SQL keyset pagination requires a verified single-
  // column unique key (IntrospectResponse.primaryKey — contract.ts). Mongo
  // always keys off `_id` (queryBuilder.ts), so this only gates SQL
  // dialects. Mirrors the upsertKeys-missing precondition above.
  if (dialect !== "mongo" && !entity.primaryKey) {
    return fail(
      scope,
      job.runId,
      job.nodeId,
      `Source table "${entity.namespace}.${entity.name}" has no single-column primary/unique key — the ETL runner requires one for reliable pagination. Add a primary key (or a unique constraint on one column) to this table to run this workflow.`,
    );
  }

  // Same >1-transform-node degrade-to-residual boundary as runPreview.ts's
  // compilePushdown call (never designed to chain pushdown across multiple
  // nodes) — but unlike preview, which only *counts* residual steps for
  // that case, this actually executes every step from every node in order,
  // since correctness (not a preview honesty notice) is the requirement.
  let dialectQuery: DialectQuery | null = null;
  let residualSteps: TransformStep[] = [];
  if (transforms.length === 1) {
    const parsedTransform = parseNodeConfig("transform", transforms[0]!.config);
    const transformConfig = !parsedTransform.unrecognized && parsedTransform.type === "transform" ? parsedTransform.value : { steps: [] };
    const plan = compilePushdown(dialect, transformConfig);
    dialectQuery = plan.dialectQuery;
    residualSteps = plan.residualTransforms;
  } else if (transforms.length > 1) {
    for (const t of transforms) {
      const parsed = parseNodeConfig("transform", t.config);
      if (!parsed.unrecognized && parsed.type === "transform") residualSteps.push(...parsed.value.steps);
    }
  }

  const { lastKey } = parseCursor(effectiveCursorRaw);
  const requestedLimit = Math.min(job.chunkSize, MAX_CHUNK_ROWS);
  const keyColumn = dialect === "mongo" ? "_id" : entity.primaryKey!;
  const query = buildEtlReadQuery(dialect, entity, dialectQuery, dialect === "mongo" ? undefined : keyColumn, lastKey, requestedLimit);

  const result = await dispatch(sourceConnectionId, query, scope, job.triggeredByUserId, { rowCap: requestedLimit });
  if (!result.ok) return fail(scope, job.runId, job.nodeId, `Source read failed: ${result.error.message}`);

  const sourceRowsFetched = result.value.rows.length;
  const keyColumnIndex = result.value.columns.findIndex((c) => c.name === keyColumn);
  const lastRow = sourceRowsFetched > 0 ? result.value.rows[sourceRowsFetched - 1] : undefined;
  const nextKey = lastRow && keyColumnIndex !== -1 ? (lastRow[keyColumnIndex] as string | number) : lastKey;
  const { columns: residualColumns, rows: residualRows } = applyResidualTransforms(
    result.value.columns.map((c) => c.name),
    result.value.rows,
    residualSteps,
  );

  const indices = mapping.entries.map((e) => residualColumns.indexOf(e.from));
  const missing = mapping.entries.find((_, i) => indices[i] === -1);
  if (missing) {
    return fail(scope, job.runId, job.nodeId, `Mapping references field "${missing.from}" not present after transforms.`);
  }
  const finalColumns = mapping.entries.map((e) => e.to);
  const finalRows = residualRows.map((row) => indices.map((i) => row[i] ?? null));

  let rowsWritten = 0;
  if (finalRows.length > 0) {
    const writeResult = await dispatchWrite(
      dest.connectionId,
      { entity: destConfig.entity as WriteEntityRef, columns: finalColumns, rows: finalRows, upsertKeys: destConfig.upsertKeys },
      scope,
      job.triggeredByUserId,
    );
    if (!writeResult.ok) return fail(scope, job.runId, job.nodeId, `Destination write failed: ${writeResult.error.message}`);
    rowsWritten = writeResult.value.written;
  }

  const totalRowsProcessed = await recordChunkProgress(job.runId, rowsWritten, JSON.stringify({ lastKey: nextKey } satisfies Cursor));
  const isLastChunk = sourceRowsFetched < requestedLimit;

  if (isLastChunk) {
    const durationMs = await finishRun(job.runId, "succeeded");
    await publishRunEvent(scope, job.runId, {
      type: "done",
      nodeId: job.nodeId,
      totalRowsProcessed,
      durationMs,
    });
    return { status: "done" };
  }

  await publishRunEvent(scope, job.runId, {
    type: "progress",
    nodeId: job.nodeId,
    rowsReadThisChunk: sourceRowsFetched,
    rowsWrittenThisChunk: rowsWritten,
    totalRowsProcessed,
  });

  // Block 4 kill-test instrumentation only: an optional, env-gated pause in
  // exactly the window Block 3.5's own race note flagged — cursor already
  // persisted (recordChunkProgress above), next chunk's job not yet
  // enqueued. Unset (every real deployment, and every other test) this is a
  // no-op; apps/worker/scripts/kill-test.ts sets it to give a `kill -9` a
  // wide, deterministic target instead of guessing when a sub-millisecond
  // in-memory hop happens to land.
  const raceDelayMs = Number(process.env.ETL_KILL_TEST_RACE_DELAY_MS ?? 0);
  if (raceDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, raceDelayMs));

  const nextJob: EtlRunJob = { ...job, cursor: JSON.stringify({ lastKey: nextKey } satisfies Cursor) };
  await queue.add("etl_run", nextJob, { jobId: randomUUID() });
  return { status: "chunk", nextCursor: nextKey };
}
