import { randomUUID } from "node:crypto";
import { findPersistedEntity, manifestDialect, parseNodeConfig, type CleanProposalResult, type WorkspaceScope } from "@nia/schemas";
import { resolveGraph } from "../checks/runWorkflowChecks.js";
import { resolveConnection } from "../resolveConnection.js";
import { getSchema } from "../introspection.js";
import { findSourcePath } from "../preview/runPreview.js";
import { withServiceRole } from "@nia/db";
import { dbPool } from "../dbPool.js";
import { sampleEntity } from "../profile/sampleEntity.js";
import { computeColumnStats } from "../profile/stats.js";
import { computeSignature, computeProfileHash, computeSchemaHash } from "../profile/signature.js";
import { routeColumns, type ColumnRoute } from "./router.js";
import { proposeMissingValueCleaning } from "./missingValueSpecialist.js";
import { proposeCoercionCleaning } from "./coercionSpecialist.js";
import { buildAssembledPlan } from "./assemble.js";

/**
 * Phase 13, Step 7 — the clean_propose BullMQ job's orchestrator: runs
 * profile -> route -> propose -> assemble against a transform node's
 * upstream source, then packages the result as a CleanProposalResult (see
 * packages/schemas/src/cleanPropose.ts) the FE can render as a ghost
 * preview. Same ok/error, no-persistence, dual-caller shape as
 * proposeMapping.ts — this function only ever computes; nothing here
 * writes a clean_plans row (that's applyPlanDiff's `cleanBinding` field,
 * a separate explicit apply call).
 *
 * Deliberately re-profiles live on every call (never reads source_profiles)
 * — same reasoning as cleanPlanDrift.ts's drift check: profileEntity.ts
 * has no persistence-in-worker shape at all, so "always fresh" falls out
 * of reusing sampleEntity/computeColumnStats/computeSignature directly
 * rather than anything special this file does.
 */
export type ProposeCleaningErrorKind =
  | "workflow-not-found"
  | "node-not-found"
  | "no-upstream-source"
  | "source-entity-missing"
  | "connection-not-found"
  | "introspect-failed"
  | "entity-not-found"
  | "no-dialect"
  | "sample-failed";

export type ProposeCleaningResult =
  | { ok: true; value: CleanProposalResult }
  | { ok: false; error: { kind: ProposeCleaningErrorKind; message: string } };

/**
 * Columns the router excluded from coercion for being identifier-like
 * (router.ts's routeColumn: both the `route:"none"` and the
 * `route:"missing-value"`-with-coercion-signal-present branches stamp this
 * exact substring into their reason) — surfaced separately from
 * assemble.ts's skippedProposals since these never reach a specialist at
 * all, per Step 7's "Skipped identifier-like columns are listed with their
 * reason."
 */
function identifierLikeSkips(routes: ColumnRoute[]) {
  return routes.filter((r) => r.reason.includes("identifier-like")).map((r) => ({ column: r.column, reason: r.reason }));
}

export async function proposeCleaning(workflowId: string, nodeId: string, scope: WorkspaceScope, triggeredByUserId: string): Promise<ProposeCleaningResult> {
  const graph = await resolveGraph(workflowId, scope);
  if (!graph) {
    return { ok: false, error: { kind: "workflow-not-found", message: "Workflow not found in the given workspace." } };
  }

  const node = graph.nodes.find((n) => n.id === nodeId && n.type === "transform");
  if (!node) {
    return { ok: false, error: { kind: "node-not-found", message: `No transform node "${nodeId}" exists in this workflow.` } };
  }

  const parsedTransform = parseNodeConfig("transform", node.config);
  if (parsedTransform.unrecognized || parsedTransform.type !== "transform") {
    return { ok: false, error: { kind: "node-not-found", message: `Node "${nodeId}" does not have a valid transform config.` } };
  }

  // Walks back through any earlier transform nodes to the nearest upstream
  // source, same generic BFS proposeMapping.ts uses (findSourcePath isn't
  // destination-specific despite its parameter name — see runPreview.ts).
  const path = findSourcePath(nodeId, graph);
  const source = path?.source;
  if (!source?.connectionId) {
    return { ok: false, error: { kind: "no-upstream-source", message: "Transform node has no upstream source node with a connection selected." } };
  }

  const sourceConfig = parseNodeConfig("source", source.config);
  const sourceEntity = !sourceConfig.unrecognized && sourceConfig.type === "source" ? sourceConfig.value.entity : undefined;
  if (!sourceEntity) {
    return { ok: false, error: { kind: "source-entity-missing", message: "Upstream source node has no entity selected." } };
  }

  const resolvedSource = await resolveConnection(source.connectionId, scope);
  if (!resolvedSource.ok) {
    return { ok: false, error: { kind: "connection-not-found", message: resolvedSource.error.message } };
  }
  const connection = resolvedSource.value;

  const schemaResult = await getSchema(connection);
  if (!schemaResult.ok) {
    return { ok: false, error: { kind: "introspect-failed", message: schemaResult.error.message } };
  }

  const entity = findPersistedEntity(schemaResult.value, sourceEntity);
  if (!entity) {
    return { ok: false, error: { kind: "entity-not-found", message: `Entity ${sourceEntity.namespace}.${sourceEntity.name} not found in the connection's current schema.` } };
  }

  const dialect = manifestDialect(connection.connectorId);
  if (!dialect) {
    return { ok: false, error: { kind: "no-dialect", message: `Connector "${connection.connectorId}" has no supported query dialect.` } };
  }

  const sample = await sampleEntity(dialect, { namespace: entity.namespace, name: entity.name }, entity.primaryKey, source.connectionId, scope, triggeredByUserId);
  if (!sample.ok) {
    return { ok: false, error: { kind: "sample-failed", message: sample.error.message } };
  }

  const declaredTypes = new Map(entity.fields.map((f) => [f.name, f.type]));
  const columns = sample.value.columns.map((name) => computeColumnStats(name, declaredTypes.get(name) ?? "unknown", sample.value.rows.map((row) => row[name])));

  const routes = routeColumns(columns);
  const [missingValue, coercion] = await Promise.all([proposeMissingValueCleaning(columns, routes), proposeCoercionCleaning(columns, routes)]);

  const signature = computeSignature(columns);
  const profileHash = computeProfileHash(signature);
  const sourceSchemaHash = computeSchemaHash(columns);

  // assemble.ts's dry-run evaluator wants array-of-arrays, in sampleColumns
  // order — sampleEntity returns object-keyed rows (see its header comment
  // on why: raw connector reads never assume a shared row shape upfront).
  const sampleColumns = sample.value.columns;
  const sampleRows = sample.value.rows.map((row) => sampleColumns.map((c) => row[c]));

  const graphResult = await withServiceRole(dbPool, (db) =>
    db.query<{ version: number }>("select version from public.workflow_graphs where workflow_id = $1", [workflowId]),
  );
  const baseGraphVersion = graphResult.rows[0]?.version ?? 0;

  const assembled = buildAssembledPlan({
    nodeId,
    planId: randomUUID(),
    baseGraphVersion,
    existingStepCount: parsedTransform.value.steps.length,
    sampleColumns,
    sampleRows,
    missingValue,
    coercion,
    columns,
  });

  const routeByColumn = new Map(routes.map((r) => [r.column, r]));
  const columnReports = assembled.stepReports.map((report) => {
    const route = routeByColumn.get(report.column);
    return {
      column: report.column,
      specialist: report.specialist,
      route: route?.route ?? ("none" as const),
      routeReason: route?.reason ?? "",
      rationale: report.rationale,
      onFailure: report.step.onFailure ?? "fail",
      before: report.before,
      after: report.after,
      sampleSize: report.sampleSize,
      failureCount: report.failureCount,
      failureRate: report.failureRate,
      maxFailureRate: report.maxFailureRate,
      included: report.included,
      dropReason: report.dropReason,
    };
  });

  return {
    ok: true,
    value: {
      diff: assembled.diff,
      columns: columnReports,
      skipped: assembled.skippedProposals,
      skippedIdentifierLike: identifierLikeSkips(routes),
      binding: { sourceSchemaHash, profileHash },
    },
  };
}
