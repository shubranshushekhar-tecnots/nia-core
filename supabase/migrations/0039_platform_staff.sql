-- 0039_platform_staff.sql
-- Console v1, build order Step 2 (docs/plans/console-plan.md §5).
--
-- platform_staff: who is platform staff. A separate identity table, never a
-- role/flag on public."user" or organization_members — per the decided
-- principle (console-plan.md's opening prompt), staff is orthogonal to org
-- membership and must be grantable/revocable without touching any org's
-- data. Rows are never deleted, only revoked (revoked_at set) — an
-- append-only-ish audit trail of who has ever been staff and who granted
-- it, matching the "append-only staff_audit_log" spirit for this table too
-- even though this one isn't itself the audit log (that's staff_audit_log,
-- build order Step 3, a separate migration).
--
-- Granted/revoked only via a CLI script run by an existing staff member
-- (apps/api/src/scripts/manageStaff.ts) — never via any HTTP route. RLS is
-- enabled with ZERO policies (default-deny for authenticated/anon; the
-- fresh table also gets no explicit grant to either, so there is nothing to
-- revoke) — same posture as staging_objects (0021_staging_registry.sql):
-- a table with no client-facing read/write surface at all. service_role
-- (and the postgres login role migrate.mjs and the CLI script both run as)
-- already gets full access via docker/local-postgres-bootstrap.sql's
-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO postgres,
-- service_role` — no per-table grant needed here.
--
-- This is the single most security-sensitive table introduced by the
-- console: any row here with revoked_at is null is a platform admin.
-- Keeping it service_role-only (RLS bypass, not a policy grant) is
-- deliberate — a policy is something a future migration or bug could
-- accidentally widen; "no policy at all" cannot be accidentally widened by
-- a WHERE-clause mistake, only by an explicit new GRANT statement, which is
-- a much more visible/reviewable change.

create table public.platform_staff (
  user_id    uuid primary key references public."user" (id) on delete cascade,
  granted_by uuid not null references public."user" (id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);

comment on table public.platform_staff is
  'Platform staff identity, separate from any org membership. Granted/'
  'revoked only by apps/api/src/scripts/manageStaff.ts (an existing staff '
  'member acting via a direct DB connection), never via any HTTP route. '
  'A user is currently staff iff a row exists here with revoked_at is '
  'null — checked by requireStaff (apps/api/src/middleware, console v1 '
  'build order Step 4). RLS enabled with zero policies: no authenticated '
  'or anon access at all, only service_role/postgres. See '
  'docs/plans/console-plan.md.';

comment on column public.platform_staff.granted_by is
  'The staff user_id who ran the grant. Not nullable — the very first '
  'staff member is granted by manageStaff.ts using a value the operator '
  'supplies directly (e.g. their own user_id), never a bootstrap NULL, so '
  'this column never needs an exception to its NOT NULL constraint.';

comment on column public.platform_staff.revoked_at is
  'Null while the grant is active. Revocation sets this timestamp rather '
  'than deleting the row, preserving the historical grant/revoke record. '
  'requireStaff and every staff-listing query must filter on '
  '`revoked_at is null`.';

-- Fast "is this user currently staff" lookup (requireStaff runs this on
-- every /console/* request) and fast "list current staff" for the CLI
-- script's own status output.
create index platform_staff_active_idx on public.platform_staff (user_id) where revoked_at is null;

alter table public.platform_staff enable row level security;
