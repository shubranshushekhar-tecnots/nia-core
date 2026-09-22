import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import {
  applyResidualTransforms,
  applyResidualTransformsChunk,
  compileFailurePreChecks,
  compilePushdown,
  findPersistedEntity,
  manifestDialect,
  objRowsToArrays,
  OnFailureAbortError,
  opForStep,
  parseNodeConfig,
  resolveSourceEntity,
  rowsToObjects,
  type DialectQuery,
  type EtlRunJob,
  type SchemaEntity,
  type SourceDestConfig,
  type SourceDialect,
  type SqlGroupKeyCursor,
  type SqlKeysetCursor,
  type StepFailureReport,
  type TransformConfig,
  type TransformStep,
  type WriteEntityRef,
} from "@nia/schemas";
import { resolveGraph } from "../checks/runWorkflowChecks.js";
import { resolveConnection } from "../resolveConnection.js";
import { getSchema } from "../introspection.js";
import { dispatch } from "../dispatch.js";
import { findSourcePath } from "../preview/runPreview.js";
import { checkCleanPlanDrift } from "./cleanPlanDrift.js";
import { buildEtlReadQuery, buildFailurePreCheckQuery, MAX_CHUNK_ROWS } from "./queryBuilder.js";
import { startRun, recordChunkProgress, finishRun, getRunCheckpoint } from "./workflowRuns.js";
import { publishRunEvent } from "./publish.js";
import type { WorkspaceScope } from "../workspaceScope.js";
import {
  resolveStagedWriteTarget,
  runPreflight,
  ensureStaging,
  writeChunkRows,
  writeQuarantineRows,
  applyStaging,
  dropStaging,
  lastStepForAssertions,
  type StagedWriteTarget,
} from "./stagedWrite.js";

/**
 * Block 3.5: keyset cursor — the last key value read so far, or null before
 * the first chunk. Deliberately not `{offset}` anymore (see queryBuilder.ts's
 * header comment).
 *
 * Phase 9 Part 3: `groupKey` is the pushed-aggregate sibling of `lastKey` —
 * the last emitted group's group-by column values, in `groupBy` order, used
 * to build a `SqlGroupKeyCursor` for the next chunk. Mutually exclusive with
 * `lastKey` in practice (a chunk is either row-keyset or group-keyset, never
 * both — see pushdown.ts's `SqlGroupKeyCursor` doc comment), but kept as a
 * sibling field rather than a union so old persisted cursors (pre-Part-3,
 * `{lastKey}` only) still parse correctly (`groupKey` just defaults to null).
 */
type Cursor = { lastKey: string | number | null; groupKey?: (string | number | null)[] | null };

function parseCursor(raw: string | null): Cursor {
  if (!raw) return { lastKey: null, groupKey: null };
  try {
    const parsed = JSON.parse(raw) as Partial<Cursor>;
    const lastKey = parsed.lastKey;
    const groupKey = parsed.groupKey;
    return {
      lastKey: typeof lastKey === "string" || typeof lastKey === "number" ? lastKey : null,
      groupKey: Array.isArray(groupKey) ? groupKey : null,
    };
  } catch {
    return { lastKey: null, groupKey: null };
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
 * Phase 9 Part 1: bounds a stateful residual op's (aggregate's) in-memory
 * group accumulator — see types.ts's ResidualAccumulator doc comment and
 * the stateful branch below. Configurable via env var so tests don't need
 * 100,000 real groups to exercise the cap (same convention as
 * ETL_KILL_TEST_RACE_DELAY_MS below). Spill-to-disk once the cap is hit is
 * deferred — see TODO.md.
 */
const DEFAULT_RESIDUAL_GROUP_CAP = 100_000;
function residualGroupCap(): number {
  const raw = Number(process.env.RESIDUAL_GROUP_CAP ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RESIDUAL_GROUP_CAP;
}

/**
 * Phase 9 Part 1: the stateful branch's row-local prefix steps run once
 * per fetched chunk (applyResidualTransformsChunk), each producing its own
 * StepFailureReport[] — chunk-scoped, same as the non-stateful path's
 * single-chunk failures today. Unlike the non-stateful path (which reports
 * only "this chunk's" counts because each chunk really is its own
 * complete run), the stateful path's chunks are all part of ONE logical
 * run that only ever emits a single `done` event — so those per-chunk
 * counts must be summed, not overwritten. Positional (not label-keyed):
 * every op's applyResidual reports exactly one entry per fallible-
 * containing step, in step order, even at count: 0 ("no policy is
 * silent" — see runEtl.ts's existing `done` event comment) — so index i
 * always refers to the same step across chunks.
 */
function mergeFailureReports(a: StepFailureReport[], b: StepFailureReport[]): StepFailureReport[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  return a.map((report, i) => (b[i] ? { ...report, count: report.count + b[i]!.count } : report));
}

/**
 * Phase 9 Part 1: the stateful-residual-op path. Runs entirely within this
 * one job invocation — never self-enqueues a next-chunk job, and never
 * consults or persists the keyset checkpoint used by the per-chunk path
 * below (per the plan: "resume restarts extraction from the beginning and
 * ignores the checkpoint when a stateful op is present" — the accumulator
 * is in-memory only, so a re-run must refeed it from row 1; persisted
 * accumulator state is deferred, see TODO.md). Cancellation is still
 * checked cooperatively between internally-fetched chunks.
 *
 * `preSteps` (row-local, safe per chunk) feed the stateful op's
 * cross-chunk `ResidualAccumulator` one fetched chunk at a time;
 * `postSteps` (also row-local — a second stateful op is out of scope, see
 * ops/types.ts) run once, after `finalize()`, against the accumulator's
 * complete output. The destination write happens exactly once, after the
 * last chunk, mirroring the per-chunk path's mapping/write/finish/publish
 * tail below but never the `chunk`/`progress`-then-reenqueue branch (there
 * is no "next chunk" job to enqueue — this function IS every chunk).
 */
async function runStatefulResidual(args: {
  scope: WorkspaceScope;
  job: EtlRunJob;
  dialect: SourceDialect;
  sourceConnectionId: string;
  entity: SchemaEntity;
  cursorPushdownConfig: TransformConfig;
  isAggregatePushdown: boolean;
  preSteps: TransformStep[];
  statefulStep: TransformStep;
  postSteps: TransformStep[];
  mapping: NonNullable<SourceDestConfig["mapping"]>;
  destConfig: SourceDestConfig;
  destConnectionId: string;
  /** Phase 9 Part 4 — already-computed pushed-step pre-check counts (see the caller's own doc comment on the pre-check block). This function always completes within one invocation (its own doc comment), so these are simply concatenated into the "done" event's failures, unconditionally. */
  pushedPreCheckFailures: StepFailureReport[];
  /** Phase 11 — computed once by the caller (resolveStagedWriteTarget), before either branch is chosen, so a run can never straddle staged/direct mid-flight. */
  stagedTarget: StagedWriteTarget;
}): Promise<RunEtlResult> {
  const {
    scope,
    job,
    dialect,
    sourceConnectionId,
    entity,
    cursorPushdownConfig,
    isAggregatePushdown,
    preSteps,
    statefulStep,
    postSteps,
    mapping,
    destConfig,
    destConnectionId,
    pushedPreCheckFailures,
    stagedTarget,
  } = args;

  const mappedDestColumns = mapping.entries.map((e) => e.to);
  const failStaged = (message: string): Promise<RunEtlResult> =>
    dropStaging(destConnectionId, stagedTarget, destConfig, mappedDestColumns, scope, job.triggeredByUserId, job.runId)
      .catch(() => undefined)
      .then(() => fail(scope, job.runId, job.nodeId, message));

  const acc = opForStep(statefulStep).createAccumulator!(statefulStep);
  const cap = residualGroupCap();
  const requestedLimit = Math.min(job.chunkSize, MAX_CHUNK_ROWS);
  const keyColumn = dialect === "mongo" ? "_id" : isAggregatePushdown ? undefined : entity.primaryKey!;

  let preFailures: StepFailureReport[] = [];
  let lastKey: string | number | null = null;
  let totalRowsRead = 0;

  for (;;) {
    // Cooperative cancel only — never consulted for a resume cursor here
    // (see this function's doc comment above).
    const checkpoint = await getRunCheckpoint(job.runId);
    if (checkpoint.status === "cancelled") {
      await publishRunEvent(scope, job.runId, { type: "cancel", nodeId: job.nodeId });
      return { status: "cancelled" };
    }

    // Phase 9 Part 2: recompiled fresh every iteration (cheap, pure, no
    // I/O) so this chunk's cursor value resolves through the same
    // ParamSink pass as the pushed prefix's own literals, in real
    // physical text order — never appended after the fact. `lastKey` is
    // this loop's own internal cursor (always starts null — see this
    // function's doc comment on why the persisted checkpoint is ignored),
    // never the outer job/checkpoint cursor.
    const cursorCondition: SqlKeysetCursor | undefined =
      dialect !== "mongo" && keyColumn && lastKey !== null ? { column: keyColumn, value: lastKey } : undefined;
    const dialectQuery = compilePushdown(dialect, cursorPushdownConfig, cursorCondition).dialectQuery;
    const query = buildEtlReadQuery(dialect, entity, dialectQuery, dialect === "mongo" ? undefined : keyColumn, lastKey, requestedLimit);
    const result = await dispatch(sourceConnectionId, query, scope, job.triggeredByUserId, { rowCap: requestedLimit });
    if (!result.ok) return failStaged(`Source read failed: ${result.error.message}`);

    const sourceRowsFetched = result.value.rows.length;
    totalRowsRead += sourceRowsFetched;

    const keyColumnIndex = result.value.columns.findIndex((c) => c.name === keyColumn);
    const lastRow = sourceRowsFetched > 0 ? result.value.rows[sourceRowsFetched - 1] : undefined;
    lastKey = lastRow && keyColumnIndex !== -1 ? (lastRow[keyColumnIndex] as string | number) : lastKey;

    if (sourceRowsFetched > 0) {
      let chunkColumns: string[];
      let chunkRows: unknown[][];
      let chunkFailures: StepFailureReport[];
      try {
        ({ columns: chunkColumns, rows: chunkRows, failures: chunkFailures } = applyResidualTransformsChunk(
          result.value.columns.map((c) => c.name),
          result.value.rows,
          preSteps,
        ));
      } catch (err) {
        if (err instanceof OnFailureAbortError) return failStaged(err.message);
        throw err;
      }
      preFailures = mergeFailureReports(preFailures, chunkFailures);
      acc.feed(rowsToObjects(chunkColumns, chunkRows));

      if (acc.size() > cap) {
        return failStaged(
          `Residual aggregate exceeded the ${cap}-group cap (set RESIDUAL_GROUP_CAP to raise it) — refine the group-by to produce fewer groups.`,
        );
      }

      await publishRunEvent(scope, job.runId, {
        type: "progress",
        nodeId: job.nodeId,
        rowsReadThisChunk: sourceRowsFetched,
        rowsWrittenThisChunk: 0,
        totalRowsProcessed: totalRowsRead,
      });
    }

    // Phase 9 Part 3: deliberately NOT unified with the main per-chunk
    // path's now-plain `sourceRowsFetched < requestedLimit` below — a
    // pushed aggregate prefix feeding a residual stateful step would need
    // its own group-keyset pagination loop here (recompiling
    // cursorPushdownConfig per iteration with a SqlGroupKeyCursor, the
    // same way the row-keyset branch above does with a SqlKeysetCursor)
    // to correctly stream multiple aggregate pages into the accumulator.
    // Not built: pushdown removes an aggregate step from residualSteps
    // entirely, so `isAggregatePushdown && statefulIndex !== -1` is
    // vanishingly rare in practice (it would require a *different*
    // residual stateful op stacked after an already-pushed aggregate
    // prefix). Treating any pushed-aggregate prefix here as always
    // single-page (this line's `isAggregatePushdown ||`) is the same
    // honest v1 scope-limit as before Part 3, just without the loud
    // truncation guard (removed above) — a truncated aggregate prefix
    // silently under-feeds the accumulator instead of failing loudly.
    // Revisit if this combination ever shows up in a real workflow.
    const isLastChunk = isAggregatePushdown || sourceRowsFetched < requestedLimit;
    if (isLastChunk) break;
  }

  let finalColumns: string[];
  let finalObjRows: Record<string, unknown>[];
  let finalFailures: StepFailureReport[];
  try {
    const finalized = acc.finalize();
    finalColumns = finalized.cols;
    finalObjRows = finalized.rows;
    finalFailures = finalized.failures ? mergeFailureReports(preFailures, finalized.failures) : preFailures;

    if (postSteps.length > 0) {
      const post = applyResidualTransforms(finalColumns, objRowsToArrays(finalColumns, finalObjRows), postSteps);
      finalColumns = post.columns;
      finalObjRows = rowsToObjects(finalColumns, post.rows);
      finalFailures = mergeFailureReports(finalFailures, post.failures);
    }
  } catch (err) {
    if (err instanceof OnFailureAbortError) return failStaged(err.message);
    throw err;
  }

  const finalRowsArr = objRowsToArrays(finalColumns, finalObjRows);
  const indices = mapping.entries.map((e) => finalColumns.indexOf(e.from));
  const missing = mapping.entries.find((_, i) => indices[i] === -1);
  if (missing) {
    return failStaged(`Mapping references field "${missing.from}" not present after transforms.`);
  }
  const mappedColumns = mapping.entries.map((e) => e.to);
  const mappedRows = finalRowsArr.map((row) => indices.map((i) => row[i] ?? null));

  let rowsWritten = 0;
  if (mappedRows.length > 0) {
    const writeResult = await writeChunkRows(
      destConnectionId,
      stagedTarget,
      destConfig,
      mappedColumns,
      mappedRows,
      scope,
      job.triggeredByUserId,
      job.runId,
    );
    if (!writeResult.ok) return failStaged(`Destination write failed: ${writeResult.error.message}`);
    rowsWritten = writeResult.value.written;
  }

  // Phase 11: quarantine rows are written (status 'pending') before apply —
  // the apply transaction (below) is what marks them committed, or a
  // terminal failure here leaves them for dropStaging/the sweeper. No-op
  // in direct mode (writeQuarantineRows returns {written:0} immediately).
  const quarantineResult = await writeQuarantineRows(
    destConnectionId,
    stagedTarget,
    job.runId,
    destConfig.entity as WriteEntityRef,
    finalFailures,
    scope,
    job.triggeredByUserId,
  );
  if (!quarantineResult.ok) return failStaged(`Quarantine write failed: ${quarantineResult.error.message}`);

  // Phase 11: staging apply (assertions + atomic swap into destination),
  // then drop staging unconditionally — on success or failure alike (plan:
  // "Drop staging after a successful apply and on terminal failure").
  const lastStep = lastStepForAssertions(postSteps, [statefulStep]);
  const applyResult = await applyStaging(
    destConnectionId,
    stagedTarget,
    destConfig,
    mappedDestColumns,
    lastStep,
    scope,
    job.triggeredByUserId,
    job.runId,
  );
  await dropStaging(destConnectionId, stagedTarget, destConfig, mappedDestColumns, scope, job.triggeredByUserId, job.runId).catch(
    () => undefined,
  );
  if (!applyResult.ok) return fail(scope, job.runId, job.nodeId, applyResult.message);

  // No meaningful cursor for a completed stateful run — see this
  // function's doc comment (resume always restarts from the beginning).
  const totalRowsProcessed = await recordChunkProgress(job.runId, rowsWritten, JSON.stringify({ lastKey: null } satisfies Cursor));
  const durationMs = await finishRun(job.runId, "succeeded");
  // Phase 9 Part 4: pushedPreCheckFailures are separate steps' reports
  // (the pushed prefix), never the same steps finalFailures already
  // covers (residual) — concatenated, not merged/summed (mergeFailureReports
  // sums same-index reports across chunks of the SAME step list, which
  // doesn't apply here).
  const allFailures = [...finalFailures, ...pushedPreCheckFailures];
  await publishRunEvent(scope, job.runId, {
    type: "done",
    nodeId: job.nodeId,
    totalRowsProcessed,
    durationMs,
    failures: allFailures.length > 0 ? allFailures : undefined,
  });
  return { status: "done" };
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
  const scope: WorkspaceScope = job.scope;

  if (job.cursor === null) {
    await startRun(job.runId, job.workflowId, job.scope);
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

  // Phase 11: computed once per run, before any extraction — `stagedTarget`
  // is derived deterministically from job.runId, so a resumed job's later
  // invocations recompute the exact same staging/quarantine entities as the
  // first. `failStaged` below is only used for failures from this point
  // onward (staging may already exist by then); the checks above (workflow/
  // destination/mapping/upsertKeys missing) intentionally stay plain
  // `fail()` — nothing to drop yet.
  const destColumns = mapping.entries.map((e) => e.to);
  const stagedTarget = resolveStagedWriteTarget(job.runId, destConfig);
  const failStaged = (message: string): Promise<RunEtlResult> =>
    dropStaging(dest.connectionId!, stagedTarget, destConfig, destColumns, scope, job.triggeredByUserId, job.runId)
      .catch(() => undefined)
      .then(() => fail(scope, job.runId, job.nodeId, message));

  if (job.cursor === null && stagedTarget.mode === "staged") {
    const preflight = await runPreflight(dest.connectionId, destConfig, scope);
    if (!preflight.ok) return fail(scope, job.runId, job.nodeId, preflight.message);
    const staging = await ensureStaging(
      dest.connectionId,
      stagedTarget,
      destConfig,
      destColumns,
      scope,
      job.triggeredByUserId,
      job.runId,
    );
    if (!staging.ok) return fail(scope, job.runId, job.nodeId, staging.message);
  }

  const path = findSourcePath(dest.id, graph);
  const sourceConnectionId = path?.source.connectionId;
  if (!path || !sourceConnectionId) {
    return failStaged("Destination node has no upstream source node with a connection selected.");
  }
  const { source, transforms } = path;

  const resolvedSource = await resolveConnection(sourceConnectionId, scope);
  if (!resolvedSource.ok) return failStaged(`Source connection: ${resolvedSource.error.message}`);
  const sourceSchema = await getSchema(resolvedSource.value);
  if (!sourceSchema.ok) return failStaged(`Source schema: ${sourceSchema.error.message}`);

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
    return failStaged(`Source node "${source.id}" has no target table/collection selected yet.`);
  }
  let entity = findPersistedEntity(sourceSchema.value, persistedEntity);
  if (!entity) {
    const entityResult = resolveSourceEntity(sourceSchema.value, mapping.entries.map((e) => e.from));
    if (!entityResult.ok) return failStaged(entityResult.message);
    entity = entityResult.entity;
  }

  // Phase 13 Step 6: once per run, before any extraction, refuse if any
  // CleanPlan-bound transform node on this path has drifted from the
  // schema/profile/version it was proposed against. Checked here (not
  // earlier) because it needs the resolved source connection + entity;
  // checked before `dialect`/pushdown compilation so a stale binding
  // never gets a chance to execute even once. Never auto-re-proposes —
  // that's Phase 15 (phase13.md Step 6).
  if (job.cursor === null) {
    for (const t of transforms) {
      const drift = await checkCleanPlanDrift({
        scope,
        workflowId: job.workflowId,
        nodeId: t.id,
        sourceConnectionId,
        entity: { namespace: entity.namespace, name: entity.name },
        triggeredByUserId: job.triggeredByUserId,
      });
      if (!drift.ok) return failStaged(drift.message);
    }
  }

  const dialect = manifestDialect(source.manifestId);
  if (!dialect) {
    return failStaged(`Source connector "${source.manifestId ?? "unknown"}" has no supported query dialect.`);
  }

  // Same >1-transform-node degrade-to-residual boundary as runPreview.ts's
  // compilePushdown call (never designed to chain pushdown across multiple
  // nodes) — but unlike preview, which only *counts* residual steps for
  // that case, this actually executes every step from every node in order,
  // since correctness (not a preview honesty notice) is the requirement.
  //
  // Phase 9 Part 2: this first compile is deliberately cursor-free — its
  // only job is to determine SHAPE (residualSteps / statefulIndex /
  // isAggregatePushdown below), none of which depend on the cursor value.
  // `cursorPushdownConfig` is kept around so the actual per-chunk read
  // query (below, and inside runStatefulResidual's own loop) can
  // recompile fresh with the real cursor folded in via ParamSink, right
  // at the point a query is about to be built — never before.
  let dialectQuery: DialectQuery | null = null;
  let residualSteps: TransformStep[] = [];
  let cursorPushdownConfig: TransformConfig = { steps: [] };
  if (transforms.length === 1) {
    const parsedTransform = parseNodeConfig("transform", transforms[0]!.config);
    const transformConfig = !parsedTransform.unrecognized && parsedTransform.type === "transform" ? parsedTransform.value : { steps: [] };
    cursorPushdownConfig = transformConfig;
    const plan = compilePushdown(dialect, transformConfig);
    dialectQuery = plan.dialectQuery;
    residualSteps = plan.residualTransforms;
  } else if (transforms.length > 1) {
    for (const t of transforms) {
      const parsed = parseNodeConfig("transform", t.config);
      if (!parsed.unrecognized && parsed.type === "transform") residualSteps.push(...parsed.value.steps);
    }
  }

  // Phase 9 Part 3: a pushed `aggregate` step is paginated by GROUP-BY-
  // column keyset instead of row keyset — GROUP BY/$group collapses row
  // identity, eliminating the row primary key pagination normally pages on
  // (see queryBuilder.ts's header comment). This must be known BEFORE the
  // primary-key precondition below, since an aggregate pushdown has no use
  // for a source primary key at all.
  const isAggregatePushdown = dialectQuery !== null && dialectQuery.isAggregate === true;

  // Block 3.5 item 1a: SQL keyset pagination requires a verified single-
  // column unique key (IntrospectResponse.primaryKey — contract.ts). Mongo
  // always keys off `_id` (queryBuilder.ts), so this only gates SQL
  // dialects. Mirrors the upsertKeys-missing precondition above. Skipped
  // entirely for an aggregate pushdown (Block 6) — see isAggregatePushdown.
  if (dialect !== "mongo" && !entity.primaryKey && !isAggregatePushdown) {
    return failStaged(
      `Source table "${entity.namespace}.${entity.name}" has no single-column primary/unique key — the ETL runner requires one for reliable pagination. Add a primary key (or a unique constraint on one column) to this table to run this workflow.`,
    );
  }

  // Phase 9 Part 4: one pre-check per pushed step whose real expression
  // has a fallible call, run ONCE before extraction begins — gated on
  // `job.cursor === null`, the same gate `startRun` above uses, since this
  // queries the whole (upstream-filtered) source, not just one chunk, and
  // only needs to run once per run, not once per chunk. Runs against
  // `cursorPushdownConfig` (the single-transform-node pushdown config;
  // `{steps: []}`, and so an empty pre-check list, when pushdown never
  // applies — compileFailurePreChecks costs nothing extra in that case).
  //
  // A pushed "fail" step aborts here, before any write, with the exact
  // same message shape a residual "fail" abort uses (see
  // OnFailureAbortError) — this is what lets fallibleStepIsPushable now
  // allow "fail" to push (onFailure.ts). A pushed "null"/"drop" step's
  // count is collected into pushedPreCheckFailures and threaded into the
  // "done" event below — but only ever surfaces when this run's "done"
  // fires in THIS SAME job invocation (i.e. the whole run completes within
  // its first chunk): workflowRuns.ts has no column to persist this count
  // across separate chunk job invocations, and a pushed step (by
  // definition) never reaches applyResidual to recompute it on a later
  // chunk's invocation. Documented v1 gap for multi-chunk runs — see
  // docs/decisions.md's Phase 9 entry — not silently wrong: the count
  // itself, when it IS surfaced, is already exact over the whole source
  // (the pre-check query has no chunk LIMIT), it just can't cross a
  // separate BullMQ job invocation.
  let pushedPreCheckFailures: StepFailureReport[] = [];
  if (job.cursor === null) {
    const preChecks = compileFailurePreChecks(dialect, cursorPushdownConfig);
    for (const check of preChecks) {
      const preCheckQuery = buildFailurePreCheckQuery(dialect, entity, check.dialectQuery);
      const preCheckResult = await dispatch(sourceConnectionId, preCheckQuery, scope, job.triggeredByUserId, { rowCap: 1 });
      if (!preCheckResult.ok) {
        return failStaged(`Failure pre-check for ${check.label} failed: ${preCheckResult.error.message}`);
      }
      const raw = preCheckResult.value.rows[0]?.[0];
      const count = typeof raw === "number" ? raw : Number(raw ?? 0);
      if (check.policy === "fail" && count > 0) {
        return failStaged(`${check.label}: ${check.fns.join(", ")} failed on ${count} row(s).`);
      }
      pushedPreCheckFailures.push({ label: check.label, fns: check.fns, policy: check.policy, count });
    }
  }

  // Phase 9 Part 1: a stateful residual op (today: aggregate) needs every
  // input row before it can emit correct output — a group's rows can span
  // multiple fetched chunks. The per-chunk path below (unchanged from
  // Block 3/3.5) writes each fetched chunk's residual output immediately;
  // running a stateful op through it would run the op fresh per chunk and
  // write each chunk's chunk-local partial result, silently overwriting
  // (not combining with) earlier chunks — the exact Part 1 bug. Instead,
  // this loops internally over every chunk in one job invocation, feeding
  // the stateful op's cross-chunk accumulator, and writes exactly once,
  // after the last chunk.
  const statefulIndex = residualSteps.findIndex((s) => opForStep(s).residualExecution === "stateful");
  if (statefulIndex !== -1) {
    return runStatefulResidual({
      scope,
      job,
      dialect,
      sourceConnectionId,
      entity,
      cursorPushdownConfig,
      isAggregatePushdown,
      preSteps: residualSteps.slice(0, statefulIndex),
      statefulStep: residualSteps[statefulIndex]!,
      postSteps: residualSteps.slice(statefulIndex + 1),
      mapping,
      destConfig,
      destConnectionId: dest.connectionId!,
      pushedPreCheckFailures,
      stagedTarget,
    });
  }

  const { lastKey, groupKey } = parseCursor(effectiveCursorRaw);
  const requestedLimit = Math.min(job.chunkSize, MAX_CHUNK_ROWS);
  const keyColumn = dialect === "mongo" ? "_id" : isAggregatePushdown ? undefined : entity.primaryKey!;
  // Phase 9 Part 3: the pushed aggregate step's raw groupBy column names —
  // only present when cursorPushdownConfig actually contains an aggregate
  // step (i.e. isAggregatePushdown), used to build this chunk's
  // SqlGroupKeyCursor and, after the read below, to read the next one back
  // out of the last emitted row.
  const aggregateStep = cursorPushdownConfig.steps.find(
    (s): s is Extract<TransformStep, { kind: "aggregate" }> => s.kind === "aggregate",
  );
  const groupByColumns = aggregateStep?.groupBy ?? null;
  // Phase 9 Part 2: only recompile (with the cursor folded in via
  // ParamSink) when there actually is a cursor to apply — the first
  // chunk's already-cursor-free `dialectQuery` from the shape-only
  // compile above is already correct and reusable as-is.
  const cursorCondition: SqlKeysetCursor | undefined =
    dialect !== "mongo" && keyColumn && lastKey !== null ? { column: keyColumn, value: lastKey } : undefined;
  // Phase 9 Part 3: group-key sibling of cursorCondition above — built from
  // the persisted cursor's `groupKey` tuple once the first aggregate page
  // has been read. Mutually exclusive with cursorCondition in practice (see
  // Cursor's doc comment).
  const groupKeyCursor: SqlGroupKeyCursor | undefined =
    isAggregatePushdown && groupByColumns && groupByColumns.length > 0 && groupKey
      ? { columns: groupByColumns, values: groupKey }
      : undefined;
  if (cursorCondition || groupKeyCursor) {
    dialectQuery = compilePushdown(dialect, cursorPushdownConfig, cursorCondition, groupKeyCursor).dialectQuery;
  }
  const query = buildEtlReadQuery(dialect, entity, dialectQuery, dialect === "mongo" ? undefined : keyColumn, lastKey, requestedLimit);

  const result = await dispatch(sourceConnectionId, query, scope, job.triggeredByUserId, { rowCap: requestedLimit });
  if (!result.ok) return failStaged(`Source read failed: ${result.error.message}`);

  const sourceRowsFetched = result.value.rows.length;

  const keyColumnIndex = result.value.columns.findIndex((c) => c.name === keyColumn);
  const lastRow = sourceRowsFetched > 0 ? result.value.rows[sourceRowsFetched - 1] : undefined;
  const nextKey = lastRow && keyColumnIndex !== -1 ? (lastRow[keyColumnIndex] as string | number) : lastKey;
  // Fix (numeric group keys under MySQL pagination): the SqlDialectQuery
  // compiled for this chunk (mysql-only) carries the hidden byte-order
  // cursor-column alias list alongside groupByColumns — read the next
  // cursor tuple from THOSE columns, not the plain groupBy column, so a
  // numeric/DECIMAL column round-trips through the persisted cursor using
  // the exact byte order ORDER BY sorted by (see pushdown.ts's
  // SqlDialectQuery.groupCursorColumns doc comment). `null` for postgres/
  // mongo/non-aggregate — falls back to the plain column name unchanged.
  const groupCursorColumns: string[] | null =
    dialectQuery && dialectQuery.dialect !== "mongo" ? dialectQuery.groupCursorColumns : null;
  // Phase 9 Part 3: the row-keyset sibling above reads a single primary-key
  // column off the last row; this reads every groupBy column off the same
  // last row (by name, since an aggregate's SELECT list isn't in
  // entity-column order) to build the next chunk's group-key tuple. Only
  // meaningful once isAggregatePushdown && groupByColumns.length > 0 — kept
  // as `groupKey ?? null` otherwise so a non-aggregate run's cursor JSON
  // still round-trips a stable `groupKey: null`.
  const nextGroupKey: (string | number | null)[] | null =
    isAggregatePushdown && groupByColumns && groupByColumns.length > 0 && lastRow
      ? groupByColumns.map((col, i) => {
          const cursorCol = groupCursorColumns?.[i] ?? col;
          const idx = result.value.columns.findIndex((c) => c.name === cursorCol);
          return idx !== -1 ? (lastRow[idx] as string | number | null) : null;
        })
      : (groupKey ?? null);
  // Strip the hidden cursor columns before they ever reach residual
  // transforms/mapping/write — they exist purely to compute nextGroupKey
  // above and were never part of this node's logical output.
  const hiddenCursorCols = new Set(groupCursorColumns ?? []);
  const effectiveSourceColumns = hiddenCursorCols.size
    ? result.value.columns.filter((c) => !hiddenCursorCols.has(c.name))
    : result.value.columns;
  const effectiveSourceRows = hiddenCursorCols.size
    ? result.value.rows.map((row) => row.filter((_, i) => !hiddenCursorCols.has(result.value.columns[i]!.name)))
    : result.value.rows;
  // Phase 8b-3: a residual step whose onFailure policy is "fail" throws
  // OnFailureAbortError (via computeFailureReport, ops/onFailure.ts) once
  // it counts a failing row — caught here and converted into the same
  // clean, non-retrying run-failure path as every other business-rule
  // rejection above (never left to propagate as an unexpected exception,
  // and never triggers BullMQ's retry/backoff).
  let residualColumns: string[];
  let residualRows: unknown[][];
  let residualFailures: ReturnType<typeof applyResidualTransforms>["failures"];
  try {
    // statefulIndex === -1 here (the stateful branch above already
    // returned) — every step in residualSteps is row-local, safe against
    // this single fetched chunk.
    ({ columns: residualColumns, rows: residualRows, failures: residualFailures } = applyResidualTransformsChunk(
      effectiveSourceColumns.map((c) => c.name),
      effectiveSourceRows,
      residualSteps,
    ));
  } catch (err) {
    if (err instanceof OnFailureAbortError) {
      return failStaged(err.message);
    }
    throw err;
  }

  const indices = mapping.entries.map((e) => residualColumns.indexOf(e.from));
  const missing = mapping.entries.find((_, i) => indices[i] === -1);
  if (missing) {
    return failStaged(`Mapping references field "${missing.from}" not present after transforms.`);
  }
  const finalColumns = mapping.entries.map((e) => e.to);
  const finalRows = residualRows.map((row) => indices.map((i) => row[i] ?? null));

  let rowsWritten = 0;
  if (finalRows.length > 0) {
    const writeResult = await writeChunkRows(
      dest.connectionId,
      stagedTarget,
      destConfig,
      finalColumns,
      finalRows,
      scope,
      job.triggeredByUserId,
      job.runId,
    );
    if (!writeResult.ok) return failStaged(`Destination write failed: ${writeResult.error.message}`);
    rowsWritten = writeResult.value.written;
  }

  // Phase 11: quarantine rows for this chunk (staged mode only; a no-op in
  // direct mode) — written per chunk, same as the staging data rows, since
  // each chunk is a separate job invocation and residualFailures is
  // chunk-scoped. Apply/drop (below) only happens once, on the last chunk.
  const quarantineResult = await writeQuarantineRows(
    dest.connectionId,
    stagedTarget,
    job.runId,
    destConfig.entity as WriteEntityRef,
    residualFailures,
    scope,
    job.triggeredByUserId,
  );
  if (!quarantineResult.ok) return failStaged(`Quarantine write failed: ${quarantineResult.error.message}`);

  const totalRowsProcessed = await recordChunkProgress(
    job.runId,
    rowsWritten,
    JSON.stringify({ lastKey: nextKey, groupKey: nextGroupKey } satisfies Cursor),
  );
  // Phase 9 Part 3: a pushed aggregate is now paginated exactly like row
  // keyset — "last chunk" is detected the same well-known way (fewer rows
  // returned than requested), accepting the same edge case as row keyset:
  // an exact-multiple-of-page-size result triggers one extra, empty,
  // correctly-detected-as-last round-trip. A whole-table aggregate
  // (groupByColumns.length === 0) always returns exactly 1 row, which is
  // `< requestedLimit` for any real chunkSize, so it's correctly detected
  // as done in a single chunk without needing special-casing here.
  const isLastChunk = sourceRowsFetched < requestedLimit;

  if (isLastChunk) {
    // Phase 11: staging apply (assertions + atomic swap), then drop
    // unconditionally — same "apply, then always drop" shape as the
    // stateful path. No-op in direct mode.
    const lastStep = lastStepForAssertions(residualSteps, []);
    const applyResult = await applyStaging(
      dest.connectionId,
      stagedTarget,
      destConfig,
      destColumns,
      lastStep,
      scope,
      job.triggeredByUserId,
      job.runId,
    );
    await dropStaging(dest.connectionId, stagedTarget, destConfig, destColumns, scope, job.triggeredByUserId, job.runId).catch(
      () => undefined,
    );
    if (!applyResult.ok) return fail(scope, job.runId, job.nodeId, applyResult.message);

    const durationMs = await finishRun(job.runId, "succeeded");
    // Phase 9 Part 4: pushedPreCheckFailures is only ever non-empty when
    // job.cursor was null AND this is that same invocation — i.e. exactly
    // when it's safe to surface (see the pre-check block's own doc
    // comment above for the multi-chunk gap this doesn't cover).
    const allFailures = [...residualFailures, ...pushedPreCheckFailures];
    await publishRunEvent(scope, job.runId, {
      type: "done",
      nodeId: job.nodeId,
      totalRowsProcessed,
      durationMs,
      // Phase 8b-3: this chunk's residual failure counts only — see
      // runEvents.ts's `failures` doc comment for why cross-chunk
      // accumulation is out of scope. Every fallible-containing step
      // contributes a report even at count: 0 ("no policy is silent" —
      // see onFailure.test.ts / runEtl.test.ts) — unfiltered here.
      failures: allFailures.length > 0 ? allFailures : undefined,
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

  const nextJob: EtlRunJob = { ...job, cursor: JSON.stringify({ lastKey: nextKey, groupKey: nextGroupKey } satisfies Cursor) };
  // attempts: 3 — BullMQ's actual default when unset is 0 (see bullmq's
  // Job constructor), meaning a job that stalls (e.g. its worker is killed
  // mid-chunk) is moved to permanent failure on the *first* stall detection,
  // never redelivered. That silently defeats the whole point of this
  // runner's checkpoint-truth design (see this file's header comment: "a
  // BullMQ stalled-job retry redelivering the exact same job is safe to
  // fully re-run") — discovered via Block 4's kill test landing a kill
  // mid-lock and getting the run permanently stuck. Redelivery is safe here
  // specifically because every invocation re-derives from the persisted
  // Postgres cursor rather than trusting its own payload.
  await queue.add("etl_run", nextJob, { jobId: randomUUID(), attempts: 3 });
  return { status: "chunk", nextCursor: nextKey };
}
