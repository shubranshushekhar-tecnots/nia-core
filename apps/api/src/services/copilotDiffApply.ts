import { randomUUID } from "node:crypto";
import {
  PlanDiff,
  type PlanDiff as PlanDiffType,
  type GraphDoc as GraphDocType,
  ensureGraphStepIds,
  validateDiffStructure,
  applyDiffToGraph,
  invertDiff,
  checkRevertConflicts,
  stampDiffStepProvenance,
  parseNodeConfig,
  type CleanBindingInput as CleanBindingInputType,
  OP_CATALOG_VERSION,
  ADAPTER_VERSION,
  PROFILE_SIGNATURE_VERSION,
} from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import type { WithUser } from "../lib/withUser.js";
import { AppError } from "../lib/appError.js";
import { computeStepsHash } from "../lib/cleanStepsHash.js";
import { getWorkflowGraph, putWorkflowGraph, type WorkflowGraphResult } from "./workflowGraphs.js";
import { assertWorkflowInScope } from "./checks.js";

/**
 * Phase 12 — the diff model's apply/revert service (docs/plans/phase12.md,
 * packages/schemas/src/planDiff.ts is the engine this wraps). Deliberately
 * a NEW, separate service from copilotApply.ts's applyPlan(), not an
 * extension of it — see planDiff.ts's header comment and
 * docs/decisions.md's Phase 12 entry for why the Phase 7 add-only Plan
 * contract is left untouched. Nothing in Copilot's propose path emits a
 * PlanDiff yet (Phase 13's specialists are the first) — this module is
 * exercised directly by copilotDiffApply.test.ts and, eventually, by
 * whatever UI/route calls it (routes/workflows.ts) in the meantime.
 */

export type ApplyPlanDiffResult = WorkflowGraphResult & { appliedPlanId: string };

export type AppliedPlanRow = {
  id: string;
  workflowId: string;
  summary: string;
  prompt: string;
  diff: PlanDiffType;
  graphVersionAfter: number;
  appliedAt: string;
  appliedBy: string | null;
  revertedAt: string | null;
  revertedBy: string | null;
  revertPlanId: string | null;
  revertsPlanId: string | null;
};

type RawAppliedPlanRow = {
  id: string;
  workflow_id: string;
  summary: string;
  prompt: string;
  diff: unknown;
  graph_version_after: number;
  applied_at: string;
  applied_by: string | null;
  reverted_at: string | null;
  reverted_by: string | null;
  revert_plan_id: string | null;
  reverts_plan_id: string | null;
};

function parseRow(row: RawAppliedPlanRow): AppliedPlanRow {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    summary: row.summary,
    prompt: row.prompt,
    diff: PlanDiff.parse(row.diff),
    graphVersionAfter: row.graph_version_after,
    appliedAt: row.applied_at,
    appliedBy: row.applied_by,
    revertedAt: row.reverted_at,
    revertedBy: row.reverted_by,
    revertPlanId: row.revert_plan_id,
    revertsPlanId: row.reverts_plan_id,
  };
}

/**
 * Applies a PlanDiff to a workflow's graph. Mirrors copilotApply.ts's
 * applyPlan() shape (fresh fetch, staleness check via baseGraphVersion,
 * re-validate before writing, putWorkflowGraph as the only real graph
 * mutation, then a separate best-effort-but-throws-on-failure audit
 * write) — see that file's header comment for why the graph write itself
 * is never a bespoke path. Two things this function does that applyPlan
 * doesn't: (1) ensureGraphStepIds backfills any missing step ids across
 * the whole graph before validating, so a diff addressing a pre-Phase-12
 * step's id can resolve; (2) it records a copilot_applied_plans row
 * (0023_copilot_applied_plans.sql), the row a later revertPlan() call
 * needs — applyPlan() has no equivalent since Phase 7 plans are never
 * revertible.
 */
export async function applyPlanDiff(
  withUser: WithUser,
  scope: WorkspaceScope,
  workflowId: string,
  input: { diff: unknown; prompt?: string; cleanBinding?: { nodeId: string } & CleanBindingInputType },
): Promise<ApplyPlanDiffResult> {
  const diff = PlanDiff.parse(input.diff);

  // Fresh fetch — never trust a client-cached graph as the apply base.
  const current = await getWorkflowGraph(withUser, scope, workflowId);

  if (current.version !== diff.baseGraphVersion) {
    throw new AppError(
      409,
      "PLAN_STALE",
      "This workflow changed since the plan was proposed. Discard the ghost preview and try again.",
    );
  }

  const backfilled = ensureGraphStepIds(current.graph);

  // Phase 12 — pre-generate the applied-plan id so provenance can be
  // stamped onto the diff's steps BEFORE it's validated/applied/persisted
  // (see stampDiffStepProvenance's header comment for why that ordering
  // matters). The same id is then used as this row's explicit primary
  // key below, so the stamped `copilot`+planId provenance always matches
  // the row it ends up persisted in.
  const appliedPlanId = randomUUID();
  const stamped = stampDiffStepProvenance(diff, { source: "copilot", planId: appliedPlanId });

  const checks = validateDiffStructure(stamped, backfilled);
  const failure = checks.find((c) => c.status === "fail");
  if (failure) {
    throw new AppError(422, "PLAN_DIFF_INVALID", failure.message, { results: checks });
  }

  const nextGraph = applyDiffToGraph(stamped, backfilled);

  const written = await putWorkflowGraph(withUser, scope, workflowId, {
    graph: nextGraph,
    expectedVersion: current.version,
  });

  try {
    await withUser((db) =>
      db.query(
        `insert into copilot_applied_plans (id, workflow_id, summary, prompt, diff, graph_version_after)
         values ($1, $2, $3, $4, $5, $6)`,
        [appliedPlanId, workflowId, stamped.summary, input.prompt ?? "", stamped, written.version],
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(500, "APPLIED_PLAN_WRITE_FAILED", message);
  }

  // Same "second, best-effort-after-the-main-write, but throws (never
  // swallows) on failure" precedent as copilotApply.ts's own audit call —
  // the audit log is load-bearing (CONVENTIONS.md), so a failed audit write
  // must surface as a distinct error, not disappear silently.
  try {
    await withUser((db) =>
      db.query(`select public.log_plan_diff_applied($1, $2, $3, $4, $5, $6)`, [
        workflowId,
        appliedPlanId,
        stamped.summary,
        input.prompt ?? null,
        stamped.ops.map((op) => op.kind),
        written.version,
      ]),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(500, "AUDIT_WRITE_FAILED", message);
  }

  // Phase 13, Step 6 — the write side of a CleanPlan binding (cleanPlan.ts's
  // header comment; read side is runEtl.ts's checkCleanPlanDrift). Only
  // present when this apply came from the "Propose cleaning" flow (Step 7's
  // UI passes it through); an ordinary Copilot plan-diff apply never sets
  // it. stepsHash is recomputed here from the just-written graph's node,
  // never trusted from the caller, so a ghost-preview edit made right
  // before Apply is still hashed correctly (see CleanBindingInput's doc
  // comment). onConflict on (workflow_id, node_id) means re-proposing and
  // re-applying against the same node replaces its prior binding.
  if (input.cleanBinding) {
    const cleanBinding = input.cleanBinding;
    const node = written.graph.nodes.find((n) => n.id === cleanBinding.nodeId);
    if (!node) {
      throw new AppError(
        422,
        "CLEAN_BINDING_NODE_NOT_FOUND",
        `Node "${cleanBinding.nodeId}" was not found in the applied graph.`,
      );
    }
    const parsed = parseNodeConfig("transform", node.config);
    if (parsed.unrecognized || parsed.type !== "transform") {
      throw new AppError(
        422,
        "CLEAN_BINDING_NODE_NOT_TRANSFORM",
        `Node "${cleanBinding.nodeId}" is not a valid transform node.`,
      );
    }
    const stepsHash = computeStepsHash(parsed.value.steps);
    try {
      await withUser((db) =>
        db.query(
          `insert into clean_plans
             (workflow_id, node_id, applied_plan_id, steps_hash, source_schema_hash, profile_hash, op_catalog_version, adapter_version, profile_signature_version)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (workflow_id, node_id)
           do update set
             applied_plan_id = excluded.applied_plan_id,
             steps_hash = excluded.steps_hash,
             source_schema_hash = excluded.source_schema_hash,
             profile_hash = excluded.profile_hash,
             op_catalog_version = excluded.op_catalog_version,
             adapter_version = excluded.adapter_version,
             profile_signature_version = excluded.profile_signature_version`,
          [
            workflowId,
            cleanBinding.nodeId,
            appliedPlanId,
            stepsHash,
            cleanBinding.sourceSchemaHash,
            cleanBinding.profileHash,
            OP_CATALOG_VERSION,
            ADAPTER_VERSION,
            PROFILE_SIGNATURE_VERSION,
          ],
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AppError(500, "CLEAN_PLAN_WRITE_FAILED", message);
    }
  }

  return { ...written, appliedPlanId };
}

/** Newest first — same ordering as checks.ts's listCheckRuns (Logs-tab-style history feed). */
export async function listAppliedPlans(
  withUser: WithUser,
  scope: WorkspaceScope,
  workflowId: string,
  limit = 20,
): Promise<AppliedPlanRow[]> {
  await assertWorkflowInScope(withUser, scope, workflowId);

  const { rows } = await withUser((db) =>
    db.query<RawAppliedPlanRow>(
      `select id, workflow_id, summary, prompt, diff, graph_version_after, applied_at, applied_by, reverted_at, reverted_by, revert_plan_id, reverts_plan_id
       from copilot_applied_plans where workflow_id = $1 order by applied_at desc limit $2`,
      [workflowId, limit],
    ),
  );

  return rows.map(parseRow);
}

/**
 * Reverts a previously-applied plan (phase12.md Design C): builds the
 * inverse of the original diff and applies it through the EXACT same path
 * as applyPlanDiff — same validation, same graphVersion concurrency check
 * — then records its own copilot_applied_plans row (reverts_plan_id set)
 * and, atomically with marking the original reverted, its own audit entry
 * referencing the original plan (0023's mark_plan_reverted rpc).
 *
 * Before reverting, checkRevertConflicts compares every element the
 * original diff touched against the live graph; any mismatch refuses the
 * revert and lists what changed (phase12.md: "No automatic merging").
 */
export async function revertPlan(
  withUser: WithUser,
  scope: WorkspaceScope,
  workflowId: string,
  appliedPlanId: string,
  input: { prompt?: string },
): Promise<ApplyPlanDiffResult> {
  await assertWorkflowInScope(withUser, scope, workflowId);

  let row: RawAppliedPlanRow | undefined;
  try {
    const { rows } = await withUser((db) =>
      db.query<RawAppliedPlanRow>(
        `select id, workflow_id, summary, prompt, diff, graph_version_after, applied_at, applied_by, reverted_at, reverted_by, revert_plan_id, reverts_plan_id
         from copilot_applied_plans where id = $1 and workflow_id = $2`,
        [appliedPlanId, workflowId],
      ),
    );
    row = rows[0];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(500, "APPLIED_PLAN_READ_FAILED", message);
  }
  if (!row) throw new AppError(404, "NOT_FOUND", "Applied plan not found.");

  const plan = parseRow(row);
  if (plan.revertedAt) {
    throw new AppError(409, "PLAN_ALREADY_REVERTED", "This plan was already reverted.");
  }

  // Fresh fetch — a revert always targets the graph's current (live)
  // version, never the version the original plan happened to leave it at
  // (see invertDiff's doc comment).
  const current = await getWorkflowGraph(withUser, scope, workflowId);

  const conflictCheck = checkRevertConflicts(plan.diff, current.graph);
  if (!conflictCheck.ok) {
    throw new AppError(
      409,
      "REVERT_CONFLICT",
      "This plan can't be reverted — some of what it changed has since been changed again.",
      { conflicts: conflictCheck.conflicts },
    );
  }

  const revertDiff = invertDiff(plan.diff, { baseGraphVersion: current.version });

  const structureChecks = validateDiffStructure(revertDiff, current.graph);
  const structureFailure = structureChecks.find((c) => c.status === "fail");
  if (structureFailure) {
    throw new AppError(422, "PLAN_DIFF_INVALID", structureFailure.message, { results: structureChecks });
  }

  const nextGraph = applyDiffToGraph(revertDiff, current.graph);

  const written = await putWorkflowGraph(withUser, scope, workflowId, {
    graph: nextGraph,
    expectedVersion: current.version,
  });

  let revertPlanId: string;
  try {
    const { rows } = await withUser((db) =>
      db.query<{ id: string }>(
        `insert into copilot_applied_plans (workflow_id, summary, prompt, diff, graph_version_after, reverts_plan_id)
         values ($1, $2, $3, $4, $5, $6)
         returning id`,
        [workflowId, revertDiff.summary, input.prompt ?? "", revertDiff, written.version, plan.id],
      ),
    );
    const revertRow = rows[0];
    if (!revertRow) throw new Error("Failed to record the revert plan.");
    revertPlanId = revertRow.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(500, "APPLIED_PLAN_WRITE_FAILED", message);
  }

  try {
    await withUser((db) =>
      db.query(`select public.log_plan_diff_applied($1, $2, $3, $4, $5, $6)`, [
        workflowId,
        revertPlanId,
        revertDiff.summary,
        input.prompt ?? null,
        revertDiff.ops.map((op) => op.kind),
        written.version,
      ]),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(500, "AUDIT_WRITE_FAILED", message);
  }

  // Marks the ORIGINAL plan reverted and writes the "own audit entry
  // referencing the original plan" (phase12.md Design C) atomically —
  // see mark_plan_reverted's header comment (0023) for why this can't be
  // a plain client UPDATE.
  try {
    await withUser((db) => db.query(`select public.mark_plan_reverted($1, $2, $3)`, [plan.id, revertPlanId, input.prompt ?? null]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(500, "AUDIT_WRITE_FAILED", message);
  }

  return { ...written, appliedPlanId: revertPlanId };
}
