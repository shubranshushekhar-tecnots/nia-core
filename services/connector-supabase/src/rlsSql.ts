/**
 * /introspect's per-table privilege + RLS-visibility query. Separated from
 * index.ts so the "does a policy apply to this connection's role" logic is
 * unit-testable without a live Postgres (same reasoning as writeSql.ts/
 * stagingSql.ts — a pure string builder, exercised here via text
 * assertions, actually exercised at runtime by Postgres itself).
 *
 * Bug this replaced: the previous query matched a policy's applicability
 * with `current_user = ANY(p.roles)` — a literal string-identity check.
 * That misses every policy created "TO <group role>" that the connecting
 * role is only a *member* of (the common case: a login role like `nia_ro`
 * inheriting from a group role a policy actually names), which is exactly
 * what Postgres itself uses to decide whether a policy applies (see
 * CREATE POLICY's docs: applies to the current role and any role it is a
 * member of, respecting the INHERIT attribute). pg_has_role(role, role,
 * 'member') is the correct, membership-aware check — it also covers the
 * literal-identity case, since every role is trivially a member of itself.
 *
 * The PUBLIC entry needs special-casing: pg_policies.roles stores a
 * PUBLIC-targeted policy as the literal element 'public', and pg_has_role
 * raises "role \"public\" does not exist" if asked about it directly (it's
 * a pseudo-role, not a real one) — so that branch is short-circuited via a
 * CASE (unlike AND/OR, Postgres guarantees CASE only evaluates the taken
 * branch), never passed to pg_has_role.
 *
 * rls_blocks_read is also now gated on can_select directly (not just
 * inferred from relrowsecurity + no policy) — a role with no SELECT
 * privilege at all already gets flagged by can_select=false ("no access"),
 * a different and non-overlapping warning from "has SELECT, but RLS still
 * zeroes it out".
 */
export function buildIntrospectPrivilegeSql(): string {
  return `WITH priv AS (
  SELECT n.nspname AS table_schema, c.relname AS table_name,
    c.relrowsecurity,
    has_table_privilege(current_user, format('%I.%I', n.nspname, c.relname), 'SELECT') AS can_select,
    has_table_privilege(current_user, format('%I.%I', n.nspname, c.relname), 'INSERT') AS can_insert
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND n.nspname != ALL($1::text[])
),
rls AS (
  SELECT priv.*,
    (priv.can_select AND priv.relrowsecurity AND NOT EXISTS (
      SELECT 1
      FROM pg_policies p, unnest(p.roles) AS pr(rolename)
      WHERE p.schemaname = priv.table_schema AND p.tablename = priv.table_name
        AND (CASE WHEN pr.rolename = 'public' THEN true ELSE pg_has_role(current_user, pr.rolename, 'member') END)
    )) AS rls_blocks_read
  FROM priv
)
SELECT table_schema, table_name, can_select, can_insert, rls_blocks_read,
  CASE WHEN rls_blocks_read
    THEN format('CREATE POLICY %I ON %I.%I FOR SELECT TO %I USING (true);', table_name || '_nia_read', table_schema, table_name, current_user)
    ELSE NULL
  END AS rls_fix_sql
FROM rls`;
}
