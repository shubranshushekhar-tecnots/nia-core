import { describe, expect, it } from "vitest";
import { buildIntrospectPrivilegeSql } from "./rlsSql.js";

describe("buildIntrospectPrivilegeSql — policy-applies-to-role check", () => {
  it("tests role membership via pg_has_role (not literal current_user identity), short-circuits the PUBLIC pseudo-role via CASE instead of passing it to pg_has_role, and gates rls_blocks_read on can_select", () => {
    const sql = buildIntrospectPrivilegeSql();

    // Membership-aware, not `current_user = ANY(p.roles)` — that literal
    // check is exactly the bug: it misses policies granted to a group role
    // the connecting role only inherits from.
    expect(sql).not.toMatch(/current_user\s*=\s*ANY\(p\.roles\)/);
    expect(sql).toContain("pg_has_role(current_user, pr.rolename, 'member')");

    // 'public' must never reach pg_has_role directly (it's a pseudo-role,
    // not a real one — pg_has_role('public', ...) errors) — it's handled
    // by a CASE, which Postgres guarantees short-circuits per-branch,
    // unlike AND/OR.
    const caseGuard = /CASE WHEN pr\.rolename = 'public' THEN true ELSE pg_has_role\(current_user, pr\.rolename, 'member'\) END/;
    expect(sql).toMatch(caseGuard);

    // rls_blocks_read requires can_select — SELECT-less roles are already
    // covered by the separate can_select=false ("no access") signal.
    expect(sql).toMatch(/priv\.can_select AND priv\.relrowsecurity AND NOT EXISTS/);
  });

  it("only produces a CREATE POLICY fix statement when rls_blocks_read is true", () => {
    const sql = buildIntrospectPrivilegeSql();
    expect(sql).toMatch(/CASE WHEN rls_blocks_read\s+THEN format\('CREATE POLICY %I ON %I\.%I FOR SELECT TO %I USING \(true\);'/);
    expect(sql).toMatch(/ELSE NULL\s+END AS rls_fix_sql/);
  });
});
