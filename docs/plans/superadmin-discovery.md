Save this prompt verbatim to docs/plans/superadmin-discovery.md. Discovery only — don't change any code or data. Don't commit.

Goal: understand exactly how "SuperAdmin" (platform-level admin, above normal org/workspace admins) works in the project today, so we can plan it properly.

Step 0 — Report git status. Don't stop if dirty.

Step 1 — Inventory (file:line for everything). If something doesn't exist, say "not found" and what you searched for.

1. Definition: is there a superadmin/platform-admin concept at all? Search for superadmin, super_admin, isSuperAdmin, platform admin, staff, internal, god mode, admin role, role enums. How is it represented (column on users/profiles, separate table, env allowlist of emails, Better Auth role/plugin, hardcoded IDs)?
2. How someone becomes a superadmin: migration/seed, SQL, env var, UI? Who can grant or revoke it? Is it audited?
3. Normal roles for comparison: what roles exist per org/workspace (owner/admin/member/viewer?), where they're stored, and how they're checked.
4. Enforcement, server side: every place in apps/api, apps/worker and connectors that checks superadmin or admin (middleware, route guards, RLS policies, SQL helpers). For each: what it protects and whether it can be bypassed (e.g. a check only in the UI).
5. Enforcement, database: any RLS policies, security-definer functions or grants that reference admin/superadmin. Can a superadmin read or change other orgs' data, and through which path?
6. UI: any admin pages, routes (/admin, /internal), menus or feature flags gated by admin/superadmin in apps/web. How the UI decides to show them, and whether the matching API routes are protected too.
7. What a superadmin can do today: list every capability (view all orgs, impersonate users, manage plans/limits, see runs, manage connectors, change billing, etc.) — actual code, not intentions.
8. Sensitive areas: can any admin path read decrypted customer credentials (nia_secrets), customer data, or LLM prompts? Is admin access to them logged?
9. Plans/billing/limits: how getPlanUsage() and plan limits work, and whether admins can override them.
10. Audit and safety: is admin activity logged anywhere? Any rate limits or confirmation on dangerous admin actions?
11. Docs and intentions: anything in TODO.md, docs/decisions.md, docs/plans/, docs/history/, designs/ describing planned superadmin/admin features.
12. Tests covering admin/superadmin behaviour.

Report as:
(a) What exists today (short summary + table of capabilities and where each is enforced).
(b) Security gaps or risks, each with file:line (e.g. UI-only checks, missing audit, access to secrets).
(c) What's planned but not built.
(d) Open questions for me.
Then stop and wait.

---

## Step 0 — Git status

Working tree was dirty at time of discovery (many modified/untracked files across apps/web canvas UI work). Not stopping per instructions.

## Step 1 — Findings

### (a) What exists today

No platform-level superadmin concept exists. Only org-scoped roles: `member` / `admin` / `owner`.

- **Role definition:** `packages/schemas/src/can.ts:13` — `OrgRole = z.enum(["member", "admin", "owner"])`.
- **Legacy `super_admin` value:** the Postgres enum `org_role` still defines a `super_admin` value (`supabase/migrations/0001_auth_orgs.sql:78`) for reversibility, but no row carries it after `0004_owner_rename.sql`. `can.ts:9-11` explicitly documents this and deliberately does not expose it.
- **Rename history:** `0003_owner_enum_value.sql` adds the new `'owner'` enum value (separate transaction, Postgres requirement); `0004_owner_rename.sql:126` backfills `UPDATE organization_members SET role = 'owner' WHERE role = 'super_admin'` — pure rename, no permission semantics changed.
- **Storage:** `organization_members(org_id, user_id, role)` table, PK `(org_id, user_id)` — one role per user per org, no platform-wide identity.
- **No env allowlist, no Better Auth admin/staff plugin, no hardcoded IDs found** — checked packages/auth/src, apps/api/src, apps/web/src, supabase/migrations.

**Capability matrix** (`packages/schemas/src/can.ts:102-130`), all enforced via `requireCapability` middleware server-side AND mirrored in Postgres RLS (RLS is source of truth):

| Capability | member | admin | owner |
|---|---|---|---|
| org.view | ✓ | ✓ | ✓ |
| org.update | ✗ | ✓ | ✓ |
| org.transferOwnership | ✗ | ✗ | ✓ |
| members.view | ✓ | ✓ | ✓ |
| members.invite / remove / changeRole | ✗ | ✓ | ✓ |
| billing.view | ✓ | ✓ | ✓ |
| billing.mutate | ✗ | ✗ | ✓ (admin read-only by design) |
| auditLog.view | ✗ | ✓ | ✓ |
| projects.* / workflows.* / connectors.* / connections.* / grants.* | ✓ | ✓ | ✓ (all roles equal on day-to-day work, per DECISION-C) |

**Server-side enforcement:**
- `attachActor` (`apps/api/src/middleware/actor.ts:17-64`) loads the user's *first* (oldest, `ORDER BY created_at ASC LIMIT 1`) org membership into `req.actor`.
- `requireCapability(action)` (`apps/api/src/middleware/requireCapability.ts:15-34`) calls `assertCan(role, action)`, throws 403 if disallowed. Used on all mutation routes: workflows update/run/cancel, connections create/update/delete/test, grants create/confirm/revoke, connectors install/uninstall.
- `requireOrgActor` (`apps/api/src/middleware/actor.ts:72-94`) rejects users with no org membership (409).
- No admin/console/internal routes exist anywhere in apps/api.

**Database enforcement:**
- `is_admin(org)` SECURITY DEFINER function (`0001_auth_orgs.sql:139-152`) — true if admin or owner.
- `members_insert_admins` / `members_update_admins` / `members_delete_admins_or_self` RLS policies (`0004_owner_rename.sql:55-83`) gate membership mutation by role, with extra guard that only owners can create/promote other owners.
- `protect_last_super_admin()` trigger (`0004_owner_rename.sql:89-117`) blocks removing/demoting the last owner in an org.
- `audit_log_select_admins` RLS (`0001_auth_orgs.sql:272-274`) — audit log visible only to admins/owners of that org.
- `nia_secrets_select_members` RLS (`0032_nia_secrets.sql:70-75`) — any org member (not just admin) can read secrets rows for their org; no route currently exposes this, so it's defense-in-depth only today.
- No cross-org read/write path exists for any role — RLS scopes everything to the org(s) a user belongs to. A direct Postgres superuser connection (outside RLS) could see everything, but that's infra-level access, not an app role.

**Capability/enforcement summary table:**

| Capability | Implemented? | Enforcement | Audited? | Rate-limited? | Confirmation? |
|---|---|---|---|---|---|
| View own org | ✓ | RLS + auth | ✓ | ✗ | n/a |
| Update org / manage members / billing.mutate | ✓ (role-gated) | requireCapability + RLS | ✓ | ✗ | ✗ |
| View audit log | ✓ (admin/owner) | RLS | n/a | ✗ | n/a |
| View other orgs | ✗ not found | — | — | — | — |
| Impersonate user | ✗ not found | — | — | — | — |
| Reset user password | Script only (`apps/api/src/scripts/setUserPassword.ts`), no UI/route | Direct DB/script access | implicit only | n/a | ✗ |
| Read org secrets | RLS allows org members; no route exposes it | RLS only | ✗ | ✗ | ✗ |
| View all runs across orgs | ✗ not found | — | — | — | — |
| Override plan limits | ✗ not found (see below) | — | — | — | — |

**Plan/billing limits:** searched for `getPlanUsage` and plan-limit logic; no admin-override path found in apps/api/apps/web — billing.mutate is owner-only within a single org, nothing cross-org.

### (b) Security gaps / risks

1. **No cross-org visibility exists at all, planned or accidental** — `attachActor`'s `LIMIT 1` means even a user in multiple orgs can't act across them via the API today. This isn't a vulnerability per se, but it means there is currently zero code path to build a "staff" feature on top of without new plumbing.
2. **`nia_secrets` RLS grants read to any org member, not just admin/owner** (`supabase/migrations/0032_nia_secrets.sql:70-91`) — harmless today since no route reads secrets back, but a landmine: the capability matrix in `can.ts` has no `secrets.read` action, so a future engineer adding a "view connection secret" route could rely on RLS alone and inadvertently let any member (not just admins) read decrypted-adjacent secret rows.
3. **No rate limiting anywhere** — no rate-limit middleware found in `apps/api/src/middleware/`. Role changes, member removal, connector install/uninstall etc. can be done in rapid succession with no throttle or confirmation step.
4. **Password reset is dev-script-only** (`apps/api/src/scripts/setUserPassword.ts`) — no self-serve flow, no admin-facing route; anyone who can run scripts against the DB can silently reset a password with only implicit logging (whatever the script itself prints), not the structured `audit_log`.
5. **Audit log gap is a documented, accepted risk for member-level destructive actions** — `can.ts:86-100` states no role gate exists on some destructive/credential-minting actions (all roles equal per DECISION-C); the audit log is called out as "the only record of who installed what, minted which grant, or deleted whose project — treat gaps in audit logging as bugs, not nice-to-haves." Worth keeping in mind when designing staff audit logging too.

### (c) What's planned but not built

- **`designs/Nia Console (superadmin).html`** — a full interactive HTML/CSS mockup of a "Nia Console" superadmin UI. No corresponding code exists in apps/web or apps/api (no `/console`, `/admin`, `/internal` routes or pages anywhere).
- **`docs/history/PHASE5_SESSION_NOTES.md:30`** — explicitly notes "Console (superadmin) — nothing built yet (still true)."
- **`TODO.md`** — references a "Console + audit" milestone (grouping what was originally Phase 8) as a prerequisite before a later phase (Phase 15), but scope/capabilities are not specified there.
- **`docs/decisions.md`** — mentions Console only as a design/styling surface (shares the indigo accent with Landing/App-light/Auth), not as a built product.

### (d) Open questions

1. Should staff be a separate identity (new table, e.g. `platform_staff`) or a special org/membership? (Now answered by the user's follow-up: separate `platform_staff` table.)
2. What exact capabilities does v1 need (view-only vs. mutating; impersonation in/out of scope)? (Now answered by the user's follow-up.)
3. Who grants/revokes staff status, and how is it audited? (Now answered: CLI script only, by existing staff.)
4. Should staff actions on a customer org write into that org's own `audit_log`, a separate `staff_audit_log`, or both? (Now answered: both, per the follow-up.)
5. Rate limiting / confirmation on dangerous staff actions — still open, to be addressed in the Console v1 plan.
6. Does Better Auth (as configured in `packages/auth`) support 2FA out of the box, and what would enabling it involve? — to be answered in the Console v1 plan.
