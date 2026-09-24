/**
 * Same org_id/owner_id xor every RLS policy in this repo enforces (e.g.
 * 0007_connectors.sql's connections_select_members) and that
 * apps/api/src/lib/workspaceScope.ts and apps/worker/src/lib/workspaceScope.ts
 * each currently redeclare locally. This is the one canonical definition —
 * Step 3 replaces both local copies with this import.
 */
export type WorkspaceScope = { orgId: string } | { ownerId: string };

export interface ScopedWhere {
  /** SQL fragment using exactly one `$N` placeholder — never a raw literal. */
  readonly sql: string;
  /** Exactly one value, positioned for the placeholder in `sql`. */
  readonly params: readonly [string];
}

/**
 * The ONLY sanctioned way to turn a WorkspaceScope into SQL. Every scoped-
 * table query in apps/worker (which runs entirely under service_role, with
 * no RLS backstop — see docs/plans/data-access.md's Step 1 report) must go
 * through this, in place of today's inline
 * `"orgId" in scope ? query.eq("org_id", scope.orgId) : ...` ternary
 * repeated at each call site (see e.g. apps/worker/src/lib/resolveConnection.ts).
 *
 * `paramIndex` is the 1-based position of the placeholder this fragment
 * should use once inlined into the caller's full query text — callers
 * compose it themselves, e.g.:
 *
 *   const scope = workspaceWhere(ws, 2);
 *   const { rows } = await db.query(
 *     `select * from connections where id = $1 and ${scope.sql}`,
 *     [connectionId, ...scope.params],
 *   );
 *
 * Throws on a malformed scope (missing/empty id on either branch) rather
 * than silently producing a WHERE clause that matches nothing or, worse,
 * every row — a scoped-table query must never proceed on a scope that
 * failed to resolve to a real id.
 *
 * `tableAlias`, if given, qualifies the emitted `org_id`/`owner_id` columns
 * (e.g. `p.org_id = $1`) instead of the bare column name. Bare names are
 * only unambiguous against a single unaliased table; any query that joins
 * two scoped tables (most of them have their own `org_id`/`owner_id`) needs
 * this to avoid Postgres's "column reference ... is ambiguous" — pass the
 * alias of whichever table the scope should actually apply to.
 *
 * Enforcement (docs/plans/data-access.md's Step 2 report, addition #2):
 * TypeScript cannot statically prove an arbitrary hand-written SQL string
 * used this helper — that would require validating raw SQL text at compile
 * time, which is not something the type system can do. What IS enforced:
 * (1) every apps/worker function that touches a scoped table takes
 * `scope: WorkspaceScope` as a required, non-optional, non-defaulted
 * parameter (already true today, e.g. resolveConnection.ts) — TypeScript
 * itself refuses to compile a call site that omits it; (2) a CI-run guard
 * script (added at the end of Step 3, once every worker call site is
 * migrated) greps apps/worker/src for a raw `org_id`/`owner_id` comparison
 * outside of this file, and fails the build if one is found — the
 * concrete "fail ... or throw" backstop for the one thing TypeScript can't
 * check: that a call site actually calls workspaceWhere instead of
 * reimplementing the ternary inline. Not added yet, since apps/worker's
 * call sites still contain the pre-existing ternary until Step 3 migrates
 * them — turning the guard on before that would fail on legitimate
 * pre-migration code.
 */
export function workspaceWhere(scope: WorkspaceScope, paramIndex: number, tableAlias?: string): ScopedWhere {
  if (!Number.isInteger(paramIndex) || paramIndex < 1) {
    throw new Error(`workspaceWhere: paramIndex must be a positive integer, got ${String(paramIndex)}`);
  }
  const prefix = tableAlias ? `${tableAlias}.` : "";
  if ("orgId" in scope) {
    if (typeof scope.orgId !== "string" || scope.orgId.length === 0) {
      throw new Error("workspaceWhere: scope.orgId must be a non-empty string");
    }
    return { sql: `${prefix}org_id = $${paramIndex}`, params: [scope.orgId] };
  }
  if (typeof scope.ownerId !== "string" || scope.ownerId.length === 0) {
    throw new Error("workspaceWhere: scope.ownerId must be a non-empty string");
  }
  return { sql: `${prefix}org_id is null and ${prefix}owner_id = $${paramIndex}`, params: [scope.ownerId] };
}
