import {
  checkConfig,
  checkMappings,
  compilePushdown,
  manifestDialect,
  parseNodeConfig,
  resolveSourceEntity,
  type DialectQuery,
  type FieldsLookup,
  type GraphDoc,
  type GraphNode,
  type IntrospectResponse,
  type MappingEntry,
  type PreviewChart,
  type PreviewJob,
  type PreviewOutcome,
  type PreviewValue,
  type QueryPayload,
  type SourceDialect,
} from "@nia/schemas";
import { resolveGraph } from "../checks/runWorkflowChecks.js";
import { resolveConnection } from "../resolveConnection.js";
import { getSchema } from "../introspection.js";
import { dispatch } from "../dispatch.js";

/**
 * Failure modes specific to destination preview — separate enum from
 * DispatchErrorKind (errors.ts, scoped to dispatch.ts's connector-execute
 * path only) and from ProposeMappingErrorKind (this flow fails in ways
 * neither of those does, e.g. "mapping fields match no single table").
 */
export type PreviewErrorKind =
  | "workflow-not-found"
  | "dest-node-not-found"
  | "no-upstream-source"
  | "mapping-not-approved"
  | "checks-failing"
  | "entity-unresolved"
  | "connection-not-found"
  | "introspect-failed"
  | "not-read-shaped"
  | "dispatch-failed";

/**
 * Walks backward from destNodeId (BFS, same algorithm as apps/web/src/lib/
 * canvas/upstream.ts's findUpstreamSource — nearest source wins, no attempt
 * to reconcile multiple joined sources since no join step exists yet, see
 * pushdown.ts's header comment) and additionally reconstructs the forward
 * chain of transform nodes between that source and the destination, which
 * findUpstreamSource itself never needed (it only reports the source's
 * connection/manifest, not the full path) but the pushdown compiler does.
 * Assumes a linear source -> [transform]* -> destination chain; behavior on
 * a branching topology is best-effort/undefined, same limitation class as
 * findUpstreamSource, not a new gap introduced here.
 */
export function findSourcePath(destNodeId: string, graph: GraphDoc): { source: GraphNode; transforms: GraphNode[] } | undefined {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  // Maps an upstream node id -> the downstream neighbor id we discovered it
  // from, so once a source is found we can walk forward from it back to
  // destNodeId, collecting any transform nodes on the way.
  const downstreamOf = new Map<string, string>();
  const visited = new Set<string>([destNodeId]);
  let frontier = [destNodeId];
  let sourceId: string | undefined;

  while (frontier.length && !sourceId) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of graph.edges) {
        if (edge.target !== id || visited.has(edge.source)) continue;
        visited.add(edge.source);
        downstreamOf.set(edge.source, id);
        const upstream = nodesById.get(edge.source);
        if (!upstream) continue;
        if (upstream.type === "source") {
          sourceId = upstream.id;
          break;
        }
        next.push(edge.source);
      }
      if (sourceId) break;
    }
    frontier = next;
  }

  if (!sourceId) return undefined;
  const source = nodesById.get(sourceId)!;
  const transforms: GraphNode[] = [];
  let cur = sourceId;
  while (cur !== destNodeId) {
    const nextId = downstreamOf.get(cur);
    if (!nextId) break; // unreachable given how downstreamOf was built, but keeps this a total function.
    if (nextId !== destNodeId) {
      const node = nodesById.get(nextId);
      if (node?.type === "transform") transforms.push(node);
    }
    cur = nextId;
  }
  return { source, transforms };
}

function quoteIdent(name: string, dialect: "mysql" | "postgres"): string {
  if (dialect === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Builds the full, runnable read query: the mapping's field projection
 * (aliased straight to destination field names, so the connector's
 * TabularResult columns already come back named for the drawer — no
 * second client-side rename pass) plus whatever WHERE/computed-field
 * fragment the pushdown compiler produced. Never includes anything beyond
 * SELECT/aggregation-read stages — see isReadShaped's defense-in-depth
 * check at the call site.
 */
function buildPreviewQuery(
  dialect: SourceDialect,
  entity: { namespace: string; name: string },
  mappingEntries: MappingEntry[],
  dialectQuery: DialectQuery | null,
): QueryPayload {
  if (dialect === "mongo") {
    const pipeline: Record<string, unknown>[] = dialectQuery && dialectQuery.dialect === "mongo" ? [...dialectQuery.pipeline] : [];
    const project: Record<string, unknown> = { _id: 0 };
    for (const entry of mappingEntries) project[entry.to] = `$${entry.from}`;
    pipeline.push({ $project: project });
    return { kind: "mongo", collection: entity.name, pipeline };
  }

  const selectParts = mappingEntries.map((e) => `${quoteIdent(e.from, dialect)} AS ${quoteIdent(e.to, dialect)}`);
  const sqlQuery = dialectQuery && dialectQuery.dialect !== "mongo" ? dialectQuery : null;
  if (sqlQuery?.selectSql) selectParts.push(sqlQuery.selectSql);
  const from = `${quoteIdent(entity.namespace, dialect)}.${quoteIdent(entity.name, dialect)}`;
  const where = sqlQuery?.whereSql ? ` WHERE ${sqlQuery.whereSql}` : "";
  return { kind: "sql", sql: `SELECT ${selectParts.join(", ")} FROM ${from}${where}`, params: sqlQuery?.params ?? [] };
}

/** Defense in depth — see this task's plan: assert the compiled query is read-shaped before it ever reaches dispatch(), even though every branch that builds one here is already SELECT/aggregation-only by construction. */
function isReadShaped(query: QueryPayload): boolean {
  if (query.kind === "sql") return /^\s*(SELECT|WITH)\b/i.test(query.sql);
  return !query.pipeline.some((stage) => "$out" in stage || "$merge" in stage);
}

function uniqueFieldNames(schema: IntrospectResponse): string[] {
  const names = new Set<string>();
  for (const entity of schema.entities) for (const field of entity.fields) names.add(field.name);
  return Array.from(names);
}

function computeAutoChart(columns: PreviewValue["columns"], rows: unknown[][]): PreviewChart | null {
  const numericIdx: number[] = [];
  const textIdx: number[] = [];
  columns.forEach((c, i) => {
    if (c.type === "number") numericIdx.push(i);
    else if (c.type === "string") textIdx.push(i);
  });
  if (numericIdx.length !== 1 || textIdx.length === 0 || rows.length === 0) return null;
  return { kind: "bar", labelColumn: columns[textIdx[0]!]!.name, valueColumn: columns[numericIdx[0]!]!.name };
}

/**
 * Pure orchestration aside from its I/O calls (Supabase/introspect/dispatch,
 * all already DispatchResult-style ok/error), no persistence — same shape
 * as proposeMapping.ts. Read-side only: builds and dispatches exactly one
 * SELECT/aggregation-read query, capped at rowCap 50, and never executes
 * residual (in-stream) transforms — those are reported as a count for the
 * drawer's honesty notice, not silently skipped without disclosure.
 */
export async function runPreview(job: PreviewJob): Promise<PreviewOutcome> {
  const graph = await resolveGraph(job.workflowId, job.scope);
  if (!graph) {
    return { ok: false, error: { kind: "workflow-not-found", message: "Workflow not found in the given workspace." } };
  }

  const dest = graph.nodes.find((n) => n.id === job.destNodeId && n.type === "destination");
  if (!dest || !dest.connectionId) {
    return { ok: false, error: { kind: "dest-node-not-found", message: `No destination node "${job.destNodeId}" with a connection selected exists in this workflow.` } };
  }

  const parsedDest = parseNodeConfig(dest.type, dest.config);
  const mapping = !parsedDest.unrecognized && parsedDest.type !== "transform" ? parsedDest.value.mapping : undefined;
  if (!mapping || !mapping.approvedAt || mapping.entries.length === 0) {
    return { ok: false, error: { kind: "mapping-not-approved", message: "Destination has no approved field mapping for this path yet." } };
  }

  const path = findSourcePath(dest.id, graph);
  const sourceConnectionId = path?.source.connectionId;
  if (!path || !sourceConnectionId) {
    return { ok: false, error: { kind: "no-upstream-source", message: "Destination node has no upstream source node with a connection selected." } };
  }
  const { source, transforms } = path;

  const resolvedSource = await resolveConnection(sourceConnectionId, job.scope);
  if (!resolvedSource.ok) {
    return { ok: false, error: { kind: "connection-not-found", message: `Source connection: ${resolvedSource.error.message}` } };
  }
  const sourceSchema = await getSchema(resolvedSource.value);
  if (!sourceSchema.ok) {
    return { ok: false, error: { kind: "introspect-failed", message: `Source schema: ${sourceSchema.error.message}` } };
  }

  // Reuse check results — no new validation logic. checkConfig is pure;
  // checkMappings needs the same source-fields I/O this function already
  // just did for schema resolution, so it's reused here rather than
  // re-fetched, mirroring runWorkflowChecks.ts's buildMappingsCheck.
  const lookupFields: FieldsLookup = (sourceNodeId) => (sourceNodeId === source.id ? uniqueFieldNames(sourceSchema.value) : undefined);
  const relevantFailures = [...checkConfig(graph), ...checkMappings(graph, lookupFields)].filter(
    (r) => r.nodeId === dest.id && r.status === "fail",
  );
  if (relevantFailures.length > 0) {
    return { ok: false, error: { kind: "checks-failing", message: relevantFailures.map((r) => r.message).join(" ") } };
  }

  const entityResult = resolveSourceEntity(sourceSchema.value, mapping.entries.map((e) => e.from));
  if (!entityResult.ok) {
    return { ok: false, error: { kind: "entity-unresolved", message: entityResult.message } };
  }

  const dialect = manifestDialect(source.manifestId);
  if (!dialect) {
    return { ok: false, error: { kind: "entity-unresolved", message: `Source connector "${source.manifestId ?? "unknown"}" has no supported query dialect.` } };
  }

  // Pushdown chaining across MULTIPLE transform nodes in series was never
  // designed (compilePushdown compiles exactly one node's TransformConfig
  // against a base dialect — see its header comment); rather than invent
  // undefined chaining semantics, 2+ transform nodes on the path degrade to
  // fully residual, matching this preview's own honest-degradation
  // contract (report the count, never silently skip or guess).
  let residualCount = 0;
  let dialectQuery: DialectQuery | null = null;
  if (transforms.length === 1) {
    const parsedTransform = parseNodeConfig("transform", transforms[0]!.config);
    const transformConfig = !parsedTransform.unrecognized && parsedTransform.type === "transform" ? parsedTransform.value : { steps: [] };
    const plan = compilePushdown(dialect, transformConfig);
    dialectQuery = plan.dialectQuery;
    residualCount = plan.residualCount;
  } else if (transforms.length > 1) {
    for (const t of transforms) {
      const parsed = parseNodeConfig("transform", t.config);
      residualCount += !parsed.unrecognized && parsed.type === "transform" ? parsed.value.steps.length : 0;
    }
  }

  const query = buildPreviewQuery(dialect, entityResult.entity, mapping.entries, dialectQuery);
  if (!isReadShaped(query)) {
    return { ok: false, error: { kind: "not-read-shaped", message: "Compiled preview query was not read-shaped; refused before dispatch." } };
  }

  const result = await dispatch(sourceConnectionId, query, job.scope, job.triggeredByUserId, { rowCap: 50 });
  if (!result.ok) {
    return { ok: false, error: { kind: "dispatch-failed", message: result.error.message } };
  }

  return {
    ok: true,
    value: {
      columns: result.value.columns,
      rows: result.value.rows,
      truncated: result.value.meta.truncated,
      residualCount,
      chart: computeAutoChart(result.value.columns, result.value.rows),
    },
  };
}
