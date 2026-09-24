import type {
  AssertionSpec,
  QuarantinedRow,
  SourceDestConfig,
  StepFailureReport,
  TransformStep,
  WriteEntityRef,
  WriteResponse,
} from "@nia/schemas";
import { opForStep, resolveWriteMode } from "@nia/schemas";
import { dispatchWrite } from "../writeDispatch.js";
import { dispatchStage, dispatchPreflight } from "../stagedWriteDispatch.js";
import {
  deriveStagingEntity,
  deriveQuarantineEntity,
  registerStagingObject,
  registerQuarantineObject,
  markStagingDropped,
  persistStagingTable,
} from "./stagingRegistry.js";
import type { WorkspaceScope } from "@nia/db";
import type { DispatchResult } from "../errors.js";

/**
 * Phase 11 — the staging-lifecycle orchestration runEtl.ts calls into,
 * built entirely on top of stagedWriteDispatch.ts (signed /stage,
 * /preflight requests) and stagingRegistry.ts (deterministic naming +
 * worker-side bookkeeping). Kept separate from runEtl.ts itself so the
 * runner's own control flow (cursor/chunk/stateful-accumulator logic)
 * doesn't have to interleave with staging bookkeeping line by line.
 *
 * `resolveStagedWriteTarget` is the one entry point that decides staged vs.
 * direct for a run — computed once, threaded through every other function
 * here and every call site in runEtl.ts, so a run can never accidentally
 * mix staged writes for some chunks and direct writes for others.
 */
export type StagedWriteTarget = {
  mode: "staged" | "direct";
  stagingEntity: WriteEntityRef | null;
  quarantineEntity: WriteEntityRef | null;
};

export function resolveStagedWriteTarget(runId: string, destConfig: SourceDestConfig): StagedWriteTarget {
  const mode = resolveWriteMode(destConfig.writeMode);
  if (mode === "direct") return { mode, stagingEntity: null, quarantineEntity: null };
  return { mode, stagingEntity: deriveStagingEntity(runId), quarantineEntity: deriveQuarantineEntity() };
}

type SimpleResult = { ok: true } | { ok: false; message: string };

/**
 * Called once per run (job.cursor === null), before extraction starts —
 * staged mode only. A no-op for direct mode (never called there, but kept
 * defensive at the call site rather than here — see runEtl.ts).
 */
export async function runPreflight(
  connectionId: string,
  destConfig: SourceDestConfig,
  scope: WorkspaceScope,
): Promise<SimpleResult> {
  const result = await dispatchPreflight(
    connectionId,
    { entity: destConfig.entity as WriteEntityRef, upsertKeys: destConfig.upsertKeys! },
    scope,
  );
  if (!result.ok) return { ok: false, message: `Preflight check failed: ${result.error.message}` };
  if (!result.value.ok) {
    const failing = result.value.checks.filter((c) => !c.ok);
    const detail = failing
      .map((c) => (c.grantSql ? `${c.name}: ${c.message ?? "failed"} (grant with: ${c.grantSql})` : `${c.name}: ${c.message ?? "failed"}`))
      .join("; ");
    return { ok: false, message: `Preflight check failed: ${detail}` };
  }
  return { ok: true };
}

/**
 * Called once per run (job.cursor === null), right after a passing
 * preflight — staged mode only. Idempotent on both the connector side
 * (`CREATE TABLE IF NOT EXISTS`) and the registry side
 * (registerStagingObject), so a redelivered stalled first-chunk job is
 * safe to call again.
 */
export async function ensureStaging(
  connectionId: string,
  target: StagedWriteTarget,
  destConfig: SourceDestConfig,
  destColumns: string[],
  scope: WorkspaceScope,
  actorUserId: string,
  runId: string,
): Promise<SimpleResult> {
  if (target.mode !== "staged" || !target.stagingEntity) return { ok: true };

  const result = await dispatchStage(
    connectionId,
    {
      op: "create",
      entity: destConfig.entity as WriteEntityRef,
      columns: destColumns,
      stagingEntity: target.stagingEntity,
      quarantineEntity: target.quarantineEntity,
      runId,
      mode: "upsert",
      upsertKeys: destConfig.upsertKeys!,
    },
    scope,
    actorUserId,
  );
  if (!result.ok) return { ok: false, message: `Staging create failed: ${result.error.message}` };

  await registerStagingObject(
    runId,
    connectionId,
    target.stagingEntity,
    destConfig.entity as WriteEntityRef,
    destColumns,
    destConfig.upsertKeys!,
  );
  await persistStagingTable(runId, target.stagingEntity);
  if (target.quarantineEntity) await registerQuarantineObject(connectionId, target.quarantineEntity);
  return { ok: true };
}

/**
 * The per-chunk write call site. Staged mode writes to `stagingEntity`
 * instead of `destConfig.entity` (still via the existing, unmodified
 * `dispatchWrite`/`/write` endpoint — only the target entity and the
 * signed context's run/staging/quarantine fields differ); direct mode is
 * byte-for-byte the pre-Phase-11 call (no runId/mode/stagingEntity/
 * quarantineEntity set — see WriteDispatchInput's doc comment).
 */
export async function writeChunkRows(
  connectionId: string,
  target: StagedWriteTarget,
  destConfig: SourceDestConfig,
  columns: string[],
  rows: unknown[][],
  scope: WorkspaceScope,
  actorUserId: string,
  runId: string,
): Promise<DispatchResult<WriteResponse>> {
  if (target.mode === "staged" && target.stagingEntity) {
    return dispatchWrite(
      connectionId,
      {
        entity: target.stagingEntity,
        columns,
        rows,
        upsertKeys: destConfig.upsertKeys!,
        runId,
        mode: "upsert",
        stagingEntity: target.stagingEntity,
        quarantineEntity: target.quarantineEntity,
        grantNamespace: (destConfig.entity as WriteEntityRef).namespace,
      },
      scope,
      actorUserId,
    );
  }
  return dispatchWrite(
    connectionId,
    { entity: destConfig.entity as WriteEntityRef, columns, rows, upsertKeys: destConfig.upsertKeys! },
    scope,
    actorUserId,
  );
}

const QUARANTINE_COLUMNS = ["run_id", "dest_table", "step_id", "function", "input_value", "source_row"];
const DEFAULT_QUARANTINE_ROW_CAP = 100_000;
function quarantineRowCap(): number {
  const raw = Number(process.env.QUARANTINE_ROW_CAP ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_QUARANTINE_ROW_CAP;
}

/**
 * Per onFailure.ts's computeFailureReport doc comment: "runEtl.ts is
 * responsible for truncating inputValue/sourceRow before persisting" — this
 * is that truncation.
 */
function truncateInputValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return str.length > 500 ? `${str.slice(0, 500)}…(truncated)` : str;
}
function truncateSourceRow(row: Record<string, unknown>): string {
  const json = JSON.stringify(row);
  return json.length > 2000 ? JSON.stringify({ truncated: true, preview: json.slice(0, 2000) }) : json;
}

/**
 * Writes this chunk's/step's quarantined rows to `nia_quarantine` with
 * status 'pending' — staged mode only (see docs/decisions.md's Phase 11
 * entry: quarantine sink persistence is tied to the apply/drop lifecycle,
 * which only exists for staged destinations; direct mode still computes
 * correct quarantine counts in the run's `done` event, it just can't
 * persist row-level detail without a staging/apply transaction to commit
 * against).
 *
 * The 100,000-row cap is enforced per call (per chunk, in the per-chunk
 * path; once, in the stateful path) rather than accumulated across a
 * multi-chunk run's separate BullMQ job invocations — the same documented
 * v1 scope limit as pushedPreCheckFailures' cross-chunk gap (see runEtl.ts).
 */
export async function writeQuarantineRows(
  connectionId: string,
  target: StagedWriteTarget,
  runId: string,
  destEntity: WriteEntityRef,
  failures: StepFailureReport[],
  scope: WorkspaceScope,
  actorUserId: string,
): Promise<DispatchResult<{ written: number }>> {
  if (target.mode !== "staged" || !target.quarantineEntity) return { ok: true, value: { written: 0 } };

  const destTable = `${destEntity.namespace}.${destEntity.name}`;
  const cap = quarantineRowCap();
  const pending: unknown[][] = [];
  outer: for (const report of failures) {
    if (!report.quarantinedRows || report.quarantinedRows.length === 0) continue;
    for (const row of report.quarantinedRows as QuarantinedRow[]) {
      if (pending.length >= cap) break outer;
      pending.push([runId, destTable, report.label, row.fn, truncateInputValue(row.inputValue), truncateSourceRow(row.sourceRow)]);
    }
  }
  if (pending.length === 0) return { ok: true, value: { written: 0 } };

  const result = await dispatchWrite(
    connectionId,
    {
      entity: target.quarantineEntity,
      columns: QUARANTINE_COLUMNS,
      rows: pending,
      // Not used for conflict resolution by the connector's quarantine
      // branch (a plain INSERT, no ON CONFLICT — see stagingSql.ts's
      // buildQuarantineInsertSql) — just needs to be a real column so
      // WriteRequest's upsertKeys.min(1) + subset-of-columns checks pass.
      upsertKeys: ["run_id"],
      runId,
      mode: "upsert",
      stagingEntity: target.stagingEntity,
      quarantineEntity: target.quarantineEntity,
      grantNamespace: destEntity.namespace,
    },
    scope,
    actorUserId,
  );
  if (!result.ok) return result;
  return { ok: true, value: { written: result.value.written } };
}

/**
 * Picks the step whose `OpModule.stagingAssertions` (if any) should be
 * added to the always-on `noNullKeys` assertion for `/stage apply`. For a
 * single-transform-node run, falls back from `residualSteps` (fully or
 * partially residual) to `cursorPushdownConfig.steps` (fully pushed, e.g. a
 * pushed aggregate) — a pushed step never appears in residualSteps but its
 * stagingAssertions (aggregate's groupBy uniqueColumns) must still apply.
 * For a multi-transform-node run, cursorPushdownConfig is always `{steps:
 * []}` (pushdown never chains across nodes — see runEtl.ts), so
 * residualSteps alone is authoritative there.
 */
export function lastStepForAssertions(
  residualSteps: TransformStep[],
  pushdownSteps: TransformStep[],
): TransformStep | undefined {
  if (residualSteps.length > 0) return residualSteps[residualSteps.length - 1];
  return pushdownSteps.length > 0 ? pushdownSteps[pushdownSteps.length - 1] : undefined;
}

// Bug fix (all-rows-quarantined): whole-run circuit breaker, independent
// of any per-step onFailure/quarantine tolerance. maxFailureRate is fully
// implemented connector-side (evaluated mid-transaction from the run's
// real quarantine/staging counts — see contract.ts's AssertionSpec doc
// comment) but nothing ever constructed one, so a run where every row was
// quarantined (e.g. by the implicit conformance step) still reported
// success with an empty destination. Set just under 1.0 (not exactly
// 1.0) so it only trips the reported 100%-quarantined case and any other
// near-total failure, without narrowing the failure tolerance of any
// currently-passing partial-failure run.
const MAX_ACCEPTABLE_FAILURE_RATE = 0.999;

/**
 * Called once, on the run's last chunk (or once, at the end of the
 * stateful-residual path) — staged mode only. Runs `noNullKeys` and
 * `maxFailureRate` (always) plus the last step's declared assertions
 * against staging, and only on success applies staging to the
 * destination and commits this run's pending quarantine rows, all in one
 * connector-side transaction (see contract.ts's StageResponse doc
 * comment).
 */
export async function applyStaging(
  connectionId: string,
  target: StagedWriteTarget,
  destConfig: SourceDestConfig,
  destColumns: string[],
  lastStep: TransformStep | undefined,
  scope: WorkspaceScope,
  actorUserId: string,
  runId: string,
): Promise<SimpleResult> {
  if (target.mode !== "staged" || !target.stagingEntity) return { ok: true };

  const assertions: AssertionSpec[] = [
    { kind: "noNullKeys", columns: destConfig.upsertKeys! },
    { kind: "maxFailureRate", maxRate: MAX_ACCEPTABLE_FAILURE_RATE },
  ];
  if (lastStep) {
    const op = opForStep(lastStep);
    if (op.stagingAssertions) assertions.push(...op.stagingAssertions(lastStep));
  }

  const result = await dispatchStage(
    connectionId,
    {
      op: "apply",
      entity: destConfig.entity as WriteEntityRef,
      columns: destColumns,
      stagingEntity: target.stagingEntity,
      quarantineEntity: target.quarantineEntity,
      runId,
      mode: "upsert",
      upsertKeys: destConfig.upsertKeys!,
      assertions,
    },
    scope,
    actorUserId,
  );
  if (!result.ok) return { ok: false, message: `Staging apply failed: ${result.error.message}` };
  if (!result.value.ok) {
    const detail = result.value.assertionResults
      .filter((a) => !a.ok)
      .map((a) => `${a.spec.kind}: ${a.detail ?? "failed"}`)
      .join("; ");
    return { ok: false, message: `Staging assertions failed: ${detail || "unknown assertion failure"}` };
  }
  return { ok: true };
}

/**
 * Best-effort cleanup — called on both success (after a successful apply)
 * and terminal failure (assertion failure, or any earlier fail() in this
 * run). Deliberately swallows a drop failure rather than failing the run
 * over it: staging is already orphaned-but-registered at that point (the
 * registry row stays 'active'), and the 24h sweeper (item 12) is the real
 * backstop for a drop that didn't go through — see docs/decisions.md.
 */
export async function dropStaging(
  connectionId: string,
  target: StagedWriteTarget,
  destConfig: SourceDestConfig,
  destColumns: string[],
  scope: WorkspaceScope,
  actorUserId: string,
  runId: string,
): Promise<void> {
  if (target.mode !== "staged" || !target.stagingEntity) return;
  await dropStagingByEntity(
    connectionId,
    target.stagingEntity,
    target.quarantineEntity,
    destConfig.entity as WriteEntityRef,
    destColumns,
    destConfig.upsertKeys!,
    runId,
    scope,
    actorUserId,
  );
}

/**
 * The entity-level primitive `dropStaging` delegates to — split out so the
 * 24h sweeper (stagingSweeper.ts) can drop a stale staging row it only
 * knows about via `staging_objects` (no live `SourceDestConfig`/
 * `StagedWriteTarget` from an in-flight run) without duplicating the
 * dispatchStage + markStagingDropped shape.
 */
export async function dropStagingByEntity(
  connectionId: string,
  stagingEntity: WriteEntityRef,
  quarantineEntity: WriteEntityRef | null,
  destEntity: WriteEntityRef,
  destColumns: string[],
  destUpsertKeys: string[],
  runId: string,
  scope: WorkspaceScope,
  actorUserId: string,
): Promise<void> {
  await dispatchStage(
    connectionId,
    {
      op: "drop",
      entity: destEntity,
      columns: destColumns,
      stagingEntity,
      quarantineEntity,
      runId,
      mode: "upsert",
      upsertKeys: destUpsertKeys,
    },
    scope,
    actorUserId,
  ).catch(() => undefined);
  await markStagingDropped(runId);
}
