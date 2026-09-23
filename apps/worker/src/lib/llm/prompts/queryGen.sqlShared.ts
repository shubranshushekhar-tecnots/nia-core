export type ReductionHint = { operation: "max" | "min" | "sum" | "count"; targetField: string };

// See queryGen.mongo.ts's SOURCE_SCOPE_NOTE for the full rationale: this one
// table/database is one of several INDEPENDENT sources combined afterward in
// code (multiSource/reduce.ts), never inside this query. Applied here too for
// defense-in-depth/parity, even though the observed bug (chat-count-diagnose.ts)
// was only reproduced on the Mongo side (via $unionWith) — the same
// "across these sources" phrasing could in principle tempt a model into a
// spurious cross-database UNION/JOIN on the SQL side.
const SOURCE_SCOPE_NOTE =
  ' This query is scoped to this one data source only — any "across these sources" phrasing in the question refers to OTHER independent connections being queried separately and combined afterward, not other tables or databases reachable from this connection. Never use UNION or a cross-database JOIN to simulate combining data from another source.';

/** Shared by queryGen.mysql.ts and queryGen.postgres.ts — the tie-safe max/min and single-row sum/count wording is identical across both SQL dialects (queryGen.mongo.ts has its own, pipeline-shaped version). */
export function sqlReductionInstructions(hint?: ReductionHint): string {
  if (!hint) return "";
  if (hint.operation === "max" || hint.operation === "min") {
    const fn = hint.operation === "max" ? "MAX" : "MIN";
    return `\n\nThis question asks for the ${hint.operation === "max" ? "highest" : "lowest"} "${hint.targetField}".${SOURCE_SCOPE_NOTE} Do NOT use ORDER BY ... LIMIT 1 — that silently breaks ties. Instead return ALL rows whose "${hint.targetField}" equals the overall ${fn}("${hint.targetField}") (e.g. \`WHERE "${hint.targetField}" = (SELECT ${fn}("${hint.targetField}") FROM ...)\`), so a tie surfaces as multiple rows rather than being dropped.`;
  }
  const fn = hint.operation === "sum" ? "SUM" : "COUNT";
  return `\n\nThis question asks for a total (${hint.operation}) of "${hint.targetField}" across all matching rows.${SOURCE_SCOPE_NOTE} Return EXACTLY ONE row: a single ${fn}(${hint.operation === "sum" ? `"${hint.targetField}"` : "*"}) with no GROUP BY (unless a GROUP BY is unavoidable to first select which rows count, in which case wrap it so the outer query still returns exactly one row).`;
}
