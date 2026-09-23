/**
 * Pure filtering logic for NodeDrawer.tsx's Table picker, extracted so it's
 * unit-testable without rendering the component (see tableFieldState.ts's
 * header comment for why — same vitest constraint).
 *
 * Bug fix context: the picker used to list every entity /introspect
 * returned, including Supabase-internal schemas (auth, storage, realtime,
 * vault, …) and tables the connection's role can't actually read/write —
 * both silently confusing (picking "auth.users" as a source) or actively
 * broken (RLS quietly returning 0 rows).
 */
export type FilterableEntity = {
  namespace: string;
  canRead?: boolean;
  canWrite?: boolean;
};

/**
 * Supabase-internal schemas hidden by default, behind the "Show system
 * schemas" toggle. `vault` is listed here too even though connector-
 * supabase's /introspect already hard-excludes it server-side (never
 * returned at all) — see ALWAYS_HIDDEN below for the toggle-proof half of
 * that guarantee; this set alone is what the toggle shows/hides.
 */
export const SYSTEM_SCHEMAS: ReadonlySet<string> = new Set([
  "pg_catalog",
  "information_schema",
  "auth",
  "storage",
  "realtime",
  "vault",
  "extensions",
  "graphql",
  "graphql_public",
  "pgsodium",
  "pgsodium_masks",
  "supabase_functions",
  "supabase_migrations",
  "net",
  "cron",
]);

/**
 * Never shown, regardless of the "Show system schemas" toggle: `nia` is
 * Nia's own staging/quarantine schema (never a valid source or
 * destination), and `vault` holds encrypted secrets and must never be
 * selectable as a source even with the toggle on. Both are already
 * excluded server-side (connector-supabase's /introspect), so this is
 * defense in depth, not the primary enforcement point.
 */
const ALWAYS_HIDDEN: ReadonlySet<string> = new Set(["nia", "vault"]);

export function filterEntities<T extends FilterableEntity>(
  entities: T[],
  opts: { nodeType: "source" | "destination"; showSystemSchemas: boolean },
): T[] {
  return entities.filter((e) => {
    if (ALWAYS_HIDDEN.has(e.namespace)) return false;
    if (!opts.showSystemSchemas && SYSTEM_SCHEMAS.has(e.namespace)) return false;
    // canRead/canWrite are optional (mysql/mongo don't populate them) —
    // only exclude on an explicit `false`, never on `undefined`.
    if (opts.nodeType === "source" && e.canRead === false) return false;
    if (opts.nodeType === "destination" && e.canWrite === false) return false;
    return true;
  });
}
