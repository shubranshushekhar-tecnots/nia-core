import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
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
} from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";
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
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  workflowId: string,
  input: { diff: unknown; prompt?: string },
): Promise<ApplyPlanDiffResult> {
  const diff = PlanDiff.parse(input.diff);

  // Fresh fetch — never trust a client-cached graph as the apply base.
  const current = await getWorkflowGraph(supabase, scope, workflowId);

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

  const written = await putWorkflowGraph(supabase, scope, workflowId, {
    graph: nextGraph,
    expectedVersion: current.version,
  });

  const { data: appliedRow, error: insertError } = await supabase
    .from("copilot_applied_plans")
    .insert({
      id: appliedPlanId,
      workflow_id: workflowId,
      summary: stamped.summary,
      prompt: input.prompt ?? "",
      diff: stamped,
      graph_version_after: written.version,
    })
    .select("id")
    .single();
  if (insertError || !appliedRow) {
    throw new AppError(500, "APPLIED_PLAN_WRITE_FAILED", insertError?.message ?? "Failed to record the applied plan.");
  }

  // Same "second, best-effort-after-the-main-write, but throws (never
  // swallows) on failure" precedent as copilotApply.ts's own audit call —
  // the audit log is load-bearing (CLAUDE.md), so a failed audit write
  // must surface as a distinct error, not disappear silently.
  const { error: auditError } = await supabase.rpc("log_plan_diff_applied", {
    p_workflow_id: workflowId,
    p_applied_plan_id: appliedPlanId,
    p_summary: stamped.summary,
    p_prompt: input.prompt ?? null,
    p_op_kinds: stamped.ops.map((op) => op.kind),
    p_graph_version: written.version,
  });
  if (auditError) throw new AppError(500, "AUDIT_WRITE_FAILED", auditError.message);

  return { ...written, appliedPlanId };
}

/** Newest first — same ordering as checks.ts's listCheckRuns (Logs-tab-style history feed). */
export async function listAppliedPlans(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  workflowId: string,
  limit = 20,
): Promise<AppliedPlanRow[]> {
  await assertWorkflowInScope(supabase, scope, workflowId);

  const { data } = await supabase
    .from("copilot_applied_plans")
    .select("id, workflow_id, summary, prompt, diff, graph_version_after, applied_at, applied_by, reverted_at, reverted_by, revert_plan_id, reverts_plan_id")
    .eq("workflow_id", workflowId)
    .order("applied_at", { ascending: false })
    .limit(limit);

  return (data ?? []).map((row) => parseRow(row as RawAppliedPlanRow));
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
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  workflowId: string,
  appliedPlanId: string,
  input: { prompt?: string },
): Promise<ApplyPlanDiffResult> {
  await assertWorkflowInScope(supabase, scope, workflowId);

  const { data: row, error: fetchError } = await supabase
    .from("copilot_applied_plans")
    .select("id, workflow_id, summary, prompt, diff, graph_version_after, applied_at, applied_by, reverted_at, reverted_by, revert_plan_id, reverts_plan_id")
    .eq("id", appliedPlanId)
    .eq("workflow_id", workflowId)
    .maybeSingle();
  if (fetchError) throw new AppError(500, "APPLIED_PLAN_READ_FAILED", fetchError.message);
  if (!row) throw new AppError(404, "NOT_FOUND", "Applied plan not found.");

  const plan = parseRow(row as RawAppliedPlanRow);
  if (plan.revertedAt) {
    throw new AppError(409, "PLAN_ALREADY_REVERTED", "This plan was already reverted.");
  }

  // Fresh fetch — a revert always targets the graph's current (live)
  // version, never the version the original plan happened to leave it at
  // (see invertDiff's doc comment).
  const current = await getWorkflowGraph(supabase, scope, workflowId);

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

  const written = await putWorkflowGraph(supabase, scope, workflowId, {
    graph: nextGraph,
    expectedVersion: current.version,
  });

  const { data: revertRow, error: insertError } = await supabase
    .from("copilot_applied_plans")
    .insert({
      workflow_id: workflowId,
      summary: revertDiff.summary,
      prompt: input.prompt ?? "",
      diff: revertDiff,
      graph_version_after: written.version,
      reverts_plan_id: plan.id,
    })
    .select("id")
    .single();
  if (insertError || !revertRow) {
    throw new AppError(500, "APPLIED_PLAN_WRITE_FAILED", insertError?.message ?? "Failed to record the revert plan.");
  }
  const revertPlanId = (revertRow as { id: string }).id;

  const { error: auditError } = await supabase.rpc("log_plan_diff_applied", {
    p_workflow_id: workflowId,
    p_applied_plan_id: revertPlanId,
    p_summary: revertDiff.summary,
    p_prompt: input.prompt ?? null,
    p_op_kinds: revertDiff.ops.map((op) => op.kind),
    p_graph_version: written.version,
  });
  if (auditError) throw new AppError(500, "AUDIT_WRITE_FAILED", auditError.message);

  // Marks the ORIGINAL plan reverted and writes the "own audit entry
  // referencing the original plan" (phase12.md Design C) atomically —
  // see mark_plan_reverted's header comment (0023) for why this can't be
  // a plain client UPDATE.
  const { error: markError } = await supabase.rpc("mark_plan_reverted", {
    p_plan_id: plan.id,
    p_revert_plan_id: revertPlanId,
    p_prompt: input.prompt ?? null,
  });
  if (markError) throw new AppError(500, "AUDIT_WRITE_FAILED", markError.message);

  return { ...written, appliedPlanId: revertPlanId };
}
