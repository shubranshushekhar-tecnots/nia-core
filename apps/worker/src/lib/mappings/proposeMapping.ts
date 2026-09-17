import { ProposalSchema, parseNodeConfig, fieldNamesForSource, type IntrospectResponse, type MappingEntry } from "@nia/schemas";
import { resolveGraph } from "../checks/runWorkflowChecks.js";
import { resolveConnection } from "../resolveConnection.js";
import { getSchema } from "../introspection.js";
import { completeJson, JsonExtractionError } from "../llm/parseHelpers.js";
import type { WorkspaceScope } from "../workspaceScope.js";

/**
 * Failure modes specific to proposing a mapping — deliberately a separate
 * enum from errors.ts's DispatchErrorKind (that one's header comment scopes
 * it to dispatch.ts's connector-execute path only; this flow fails in ways
 * dispatch never does, e.g. "the two sides are already the same connector
 * type").
 */
export type ProposeMappingErrorKind =
  | "workflow-not-found"
  | "dest-node-not-found"
  | "no-upstream-source"
  | "homogeneous-path"
  | "connection-not-found"
  | "introspect-failed"
  | "llm-failed";

export type ProposeMappingResult =
  | { ok: true; value: { entries: MappingEntry[] } }
  | { ok: false; error: { kind: ProposeMappingErrorKind; message: string } };

function uniqueFieldNames(schema: IntrospectResponse): string[] {
  const names = new Set<string>();
  for (const entity of schema.entities) {
    for (const field of entity.fields) names.add(field.name);
  }
  return Array.from(names).sort();
}

/**
 * Pure orchestration (aside from its I/O calls, all of which already follow
 * this codebase's DispatchResult-style ok/error convention) — no
 * persistence. Called by both the worker's BullMQ job handler (index.ts)
 * and mapping-smoke.ts directly, same dual-caller shape as the rest of
 * apps/worker/src/lib (dispatch.ts, runWorkflowChecks.ts).
 */
export async function proposeMapping(workflowId: string, destNodeId: string, scope: WorkspaceScope): Promise<ProposeMappingResult> {
  const graph = await resolveGraph(workflowId, scope);
  if (!graph) {
    return { ok: false, error: { kind: "workflow-not-found", message: "Workflow not found in the given workspace." } };
  }

  const dest = graph.nodes.find((n) => n.id === destNodeId && n.type === "destination");
  if (!dest || !dest.connectionId) {
    return { ok: false, error: { kind: "dest-node-not-found", message: `No destination node "${destNodeId}" with a connection selected exists in this workflow.` } };
  }

  const incomingSourceIds = new Set(graph.edges.filter((e) => e.target === destNodeId).map((e) => e.source));
  const source = graph.nodes.find((n) => incomingSourceIds.has(n.id) && n.type === "source" && n.connectionId);
  if (!source?.connectionId) {
    return { ok: false, error: { kind: "no-upstream-source", message: "Destination node has no upstream source node with a connection selected." } };
  }

  if (source.manifestId && dest.manifestId && source.manifestId === dest.manifestId) {
    return { ok: false, error: { kind: "homogeneous-path", message: "Source and destination use the same connector type — no field mapping is needed." } };
  }

  const [resolvedSource, resolvedDest] = await Promise.all([
    resolveConnection(source.connectionId, scope),
    resolveConnection(dest.connectionId, scope),
  ]);
  if (!resolvedSource.ok) return { ok: false, error: { kind: "connection-not-found", message: `Source connection: ${resolvedSource.error.message}` } };
  if (!resolvedDest.ok) return { ok: false, error: { kind: "connection-not-found", message: `Destination connection: ${resolvedDest.error.message}` } };

  const [sourceSchema, destSchema] = await Promise.all([getSchema(resolvedSource.value), getSchema(resolvedDest.value)]);
  if (!sourceSchema.ok) return { ok: false, error: { kind: "introspect-failed", message: `Source schema: ${sourceSchema.error.message}` } };
  if (!destSchema.ok) return { ok: false, error: { kind: "introspect-failed", message: `Destination schema: ${destSchema.error.message}` } };

  // Phase 6 Block 0: prefer the source node's persisted entity (scoped field
  // list, no cross-table ambiguity) over the flat union; falls back to the
  // flat union automatically when no entity is persisted or it no longer
  // resolves against the live schema (see fieldNamesForSource's doc comment).
  const sourceConfig = parseNodeConfig("source", source.config);
  const sourceEntity = !sourceConfig.unrecognized && sourceConfig.type !== "transform" ? sourceConfig.value.entity : undefined;
  const sourceFields = fieldNamesForSource(sourceSchema.value, sourceEntity).sort();
  const destFields = uniqueFieldNames(destSchema.value);

  try {
    const raw = await completeJson(
      [
        {
          role: "system",
          content:
            "You map source fields to destination fields for a data pipeline. Respond with ONLY a JSON object of the shape " +
            '{"entries":[{"from":string,"to":string}]}. Only include a pairing for fields you are reasonably confident ' +
            "correspond to each other (matching name, or an obvious rename/synonym). Never invent field names outside the " +
            "given lists. Leave a destination field unmapped (simply omit it) if nothing on the source side plausibly matches.",
        },
        {
          role: "user",
          content: `Source fields: ${JSON.stringify(sourceFields)}\nDestination fields: ${JSON.stringify(destFields)}`,
        },
      ],
      { node: "propose-mapping" },
    );

    const parsed = ProposalSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: { kind: "llm-failed", message: `Model response didn't match the expected shape: ${parsed.error.message}` } };
    }

    // Defense in depth: never surface a pairing that hallucinates a field
    // name outside either side's actual introspected schema.
    const sourceSet = new Set(sourceFields);
    const destSet = new Set(destFields);
    const entries = parsed.data.entries.filter((e) => sourceSet.has(e.from) && destSet.has(e.to));

    return { ok: true, value: { entries } };
  } catch (err) {
    if (err instanceof JsonExtractionError) {
      return { ok: false, error: { kind: "llm-failed", message: err.message } };
    }
    return { ok: false, error: { kind: "llm-failed", message: err instanceof Error ? err.message : String(err) } };
  }
}
