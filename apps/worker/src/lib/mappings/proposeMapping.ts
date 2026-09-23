import { ProposalSchema, parseNodeConfig, fieldNamesForEntity, type MappingEntry } from "@nia/schemas";
import { resolveGraph } from "../checks/runWorkflowChecks.js";
import { resolveConnection } from "../resolveConnection.js";
import { getSchema } from "../introspection.js";
import { completeJson, JsonExtractionError } from "../llm/parseHelpers.js";
import { findSourcePath } from "../preview/runPreview.js";
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

  // Walks back through any transform nodes between source and destination
  // (findSourcePath, runPreview.ts) rather than requiring a direct edge —
  // a Source -> Transform -> Destination chain is the normal shape, not an
  // edge case, and the old direct-edge-only lookup here failed on it even
  // though runEtl.ts/runPreview.ts both already resolve through transforms.
  const path = findSourcePath(destNodeId, graph);
  const source = path?.source;
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
  // resolves against the live schema (see fieldNamesForEntity's doc comment).
  const sourceConfig = parseNodeConfig("source", source.config);
  const sourceEntity = !sourceConfig.unrecognized && sourceConfig.type !== "transform" ? sourceConfig.value.entity : undefined;
  const sourceFields = fieldNamesForEntity(sourceSchema.value, sourceEntity).sort();

  // Item 2 fix: the destination side used to match against `uniqueFieldNames`
  // — a flat union of every table in the destination connection — so a
  // target table's exact-name-match fields could be masked or diluted by
  // unrelated tables' columns. Scope to the destination node's persisted
  // `entity` the same way the source side already does; `uniqueFieldNames`
  // is kept only as the fallback fieldNamesForEntity itself already applies
  // for legacy nodes with no persisted entity.
  const destConfig = parseNodeConfig("destination", dest.config);
  const destEntity = !destConfig.unrecognized && destConfig.type !== "transform" ? destConfig.value.entity : undefined;
  const destFields = fieldNamesForEntity(destSchema.value, destEntity);

  // Follow-up item 3: a destination field whose name exactly matches a
  // source field (case-insensitive) is mapped deterministically, without
  // spending an LLM call on it. Only the remaining, genuinely unmatched
  // fields go to the LLM below — the user still approves the whole merged
  // mapping (deterministic + LLM-proposed) afterward, same as today.
  const destByLower = new Map<string, string>();
  for (const f of destFields) destByLower.set(f.toLowerCase(), f);
  const deterministicEntries: MappingEntry[] = [];
  const matchedDestLower = new Set<string>();
  for (const f of sourceFields) {
    const destMatch = destByLower.get(f.toLowerCase());
    if (destMatch && !matchedDestLower.has(destMatch.toLowerCase())) {
      deterministicEntries.push({ from: f, to: destMatch });
      matchedDestLower.add(destMatch.toLowerCase());
    }
  }
  const matchedSourceLower = new Set(deterministicEntries.map((e) => e.from.toLowerCase()));
  const unmatchedSourceFields = sourceFields.filter((f) => !matchedSourceLower.has(f.toLowerCase()));
  const unmatchedDestFields = destFields.filter((f) => !matchedDestLower.has(f.toLowerCase()));

  // Every destination field already resolved deterministically — nothing
  // left for the LLM to do.
  if (unmatchedDestFields.length === 0) {
    return { ok: true, value: { entries: deterministicEntries } };
  }

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
          content: `Source fields: ${JSON.stringify(unmatchedSourceFields)}\nDestination fields: ${JSON.stringify(unmatchedDestFields)}`,
        },
      ],
      { node: "propose-mapping" },
    );

    const parsed = ProposalSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: { kind: "llm-failed", message: `Model response didn't match the expected shape: ${parsed.error.message}` } };
    }

    // Defense in depth: never surface a pairing that hallucinates a field
    // name outside either side's actual introspected schema (scoped to the
    // fields the LLM was actually offered, i.e. the unmatched sets above).
    const sourceSet = new Set(unmatchedSourceFields);
    const destSet = new Set(unmatchedDestFields);
    const llmEntries = parsed.data.entries.filter((e) => sourceSet.has(e.from) && destSet.has(e.to));

    return { ok: true, value: { entries: [...deterministicEntries, ...llmEntries] } };
  } catch (err) {
    if (err instanceof JsonExtractionError) {
      return { ok: false, error: { kind: "llm-failed", message: err.message } };
    }
    return { ok: false, error: { kind: "llm-failed", message: err instanceof Error ? err.message : String(err) } };
  }
}
