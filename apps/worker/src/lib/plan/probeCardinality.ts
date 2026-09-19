import type { EntityRef, QueryPayload, SourceDialect } from "@nia/schemas";
import { dispatch } from "../dispatch.js";
import type { WorkspaceScope } from "../workspaceScope.js";

function quoteIdent(name: string, dialect: "mysql" | "postgres"): string {
  if (dialect === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

/** Same DISTINCT-count shape for every SQL dialect (mysql/postgres) — a subquery alias keeps this portable rather than dialect-branching the aggregate itself. */
function buildCardinalityQuery(dialect: SourceDialect, entity: EntityRef, groupBy: string[]): QueryPayload {
  if (dialect === "mongo") {
    const groupId: Record<string, string> = {};
    for (const field of groupBy) groupId[field] = `$${field}`;
    return {
      kind: "mongo",
      collection: entity.name,
      pipeline: [{ $group: { _id: groupBy.length === 1 ? `$${groupBy[0]}` : groupId } }, { $count: "c" }],
    };
  }

  const cols = groupBy.map((f) => quoteIdent(f, dialect)).join(", ");
  const from = `${quoteIdent(entity.namespace, dialect)}.${quoteIdent(entity.name, dialect)}`;
  return {
    kind: "sql",
    sql: `SELECT COUNT(*) AS c FROM (SELECT DISTINCT ${cols} FROM ${from}) AS plan_cardinality_probe`,
    params: [],
  };
}

/**
 * Cardinality probes are a cheap, interactive-latency-sensitive read (the
 * user is waiting on the ghost preview) — capped well under
 * connectorClient.ts's general-purpose DEFAULT_TIMEOUT_MS (15000ms) so a
 * slow/unreachable connection fails the probe fast rather than stalling
 * plan generation for the full default window. Explicit rather than
 * inherited so this value is visible and intentional at the call site.
 */
const PLAN_PROBE_TIMEOUT_MS = 8000;

/**
 * Builds and dispatches a COUNT(DISTINCT groupBy cols)-shaped read query via
 * the existing dispatch() chokepoint (same pattern preview/runPreview.ts
 * already uses) — no new connector-side code needed. Returns -1 (never
 * throws) when the probe itself fails to dispatch or times out (connection
 * hiccup, guardrail rejection, PLAN_PROBE_TIMEOUT_MS exceeded) —
 * validateFeasibility (packages/schemas/src/plan.ts) treats any negative
 * result as "could not be measured" and REFUSES the plan; it must never be
 * treated as "assume within cap" (that was a fail-open bug, fixed — see
 * plan.ts's CardinalityProbeFn doc comment).
 */
export async function probeCardinality(
  connectionId: string,
  entity: EntityRef,
  groupBy: string[],
  dialect: SourceDialect,
  scope: WorkspaceScope,
  actorUserId: string,
): Promise<number> {
  const query = buildCardinalityQuery(dialect, entity, groupBy);
  const result = await dispatch(connectionId, query, scope, actorUserId, { rowCap: 1, timeoutMs: PLAN_PROBE_TIMEOUT_MS });
  if (!result.ok) return -1;
  const raw = result.value.rows[0]?.[0];
  const count = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(count) ? count : -1;
}
