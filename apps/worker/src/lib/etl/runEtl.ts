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
import { startRun, recordChunkProgress, finishRun } from "./workflowRuns.js";
import { publishRunEvent } from "./publish.js";
import type { WorkspaceScope } from "../workspaceScope.js";

type Cursor = { offset: number };

function parseCursor(raw: string | null): Cursor {
  if (!raw) return { offset: 0 };
  try {
    const parsed = JSON.parse(raw) as Partial<Cursor>;
    return { offset: typeof parsed.offset === "number" && parsed.offset >= 0 ? parsed.offset : 0 };
  } catch {
    return { offset: 0 };
  }
}

export type RunEtlResult = { status: "done" | "chunk" | "failed"; nextOffset?: number; message?: string };

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
 * Phase 6 Block 3 — the real ETL runner. Chunked, checkpointed (offset
 * cursor persisted in the next BullMQ job's payload, not in Postgres —
 * `workflow_runs` only tracks aggregate progress/status), resumable (a
 * fresh job with the same runId/cursor re-derives everything from the
 * graph + connections, no in-memory state carried between chunks), and
 * idempotent on its one stateful write (`workflow_runs` row creation, via
 * startRun's upsert) — a BullMQ stalled-job retry redelivering the exact
 * same job is safe to fully re-run (the destination upsert is itself
 * idempotent by upsertKeys, and the read is a pure re-fetch of the same
 * offset window).
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
  let entity = persistedEntity ? findPersistedEntity(sourceSchema.value, persistedEntity) : undefined;
  if (!entity) {
    const entityResult = resolveSourceEntity(sourceSchema.value, mapping.entries.map((e) => e.from));
    if (!entityResult.ok) return fail(scope, job.runId, job.nodeId, entityResult.message);
    entity = entityResult.entity;
  }

  const dialect = manifestDialect(source.manifestId);
  if (!dialect) {
    return fail(scope, job.runId, job.nodeId, `Source connector "${source.manifestId ?? "unknown"}" has no supported query dialect.`);
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

  const { offset } = parseCursor(job.cursor);
  const requestedLimit = Math.min(job.chunkSize, MAX_CHUNK_ROWS);
  const orderColumn = entity.fields[0]?.name;
  const query = buildEtlReadQuery(dialect, entity, dialectQuery, orderColumn, offset, requestedLimit);

  const result = await dispatch(sourceConnectionId, query, scope, job.triggeredByUserId, { rowCap: requestedLimit });
  if (!result.ok) return fail(scope, job.runId, job.nodeId, `Source read failed: ${result.error.message}`);

  const sourceRowsFetched = result.value.rows.length;
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

  const totalRowsProcessed = await recordChunkProgress(job.runId, rowsWritten);
  const nextOffset = offset + sourceRowsFetched;
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

  const nextJob: EtlRunJob = { ...job, cursor: JSON.stringify({ offset: nextOffset } satisfies Cursor) };
  await queue.add("etl_run", nextJob, { jobId: randomUUID() });
  return { status: "chunk", nextOffset };
}
