-- 0040_staff_audit_log.sql
-- Console v1, build order Step 3 (docs/plans/console-plan.md §5 step 3).
--
-- staff_audit_log: append-only record of every staff read/action, the
-- audit trail companion to platform_staff (0039). One row per staff read
-- of an org/user and per mutating action in later build-order steps.
-- manageStaff.ts's grant/revoke/bootstrap paths also write here (action:
-- 'staff.grant' / 'staff.revoke' / 'staff.bootstrap') — granting/revoking
-- staff access is itself a staff action worth auditing, even though it
-- mutates Step 2's table, not this one.
--
-- Append-only is enforced two ways, deliberately redundant:
--  1. RLS enabled, zero policies (same "no policy at all — cannot be
--     accidentally widened by a WHERE-clause mistake" posture as
--     platform_staff, 0039) — authenticated/anon get no grant either, so
--     there is no customer-facing access whatsoever, not even read.
--  2. A BEFORE UPDATE OR DELETE trigger that unconditionally raises. This
--     is the part that actually matters for "append-only": RLS alone does
--     NOT stop this, because service_role (and the postgres login role
--     every CLI script and migrate.mjs run as) has BYPASSRLS and, via
--     docker/local-postgres-bootstrap.sql's `ALTER DEFAULT PRIVILEGES ...
--     GRANT ALL ON TABLES TO postgres, service_role`, full UPDATE/DELETE
--     table privileges too. A trigger fires for every role including the
--     table owner, so it is the only mechanism here that actually makes
--     "no UPDATE/DELETE for any app role" true rather than aspirational.
--     Lifting it later would require an explicit, reviewable `drop
--     trigger`/`alter table ... disable trigger` — not something a policy
--     WHERE-clause change could ever accidentally do.
--  3. A BEFORE TRUNCATE (statement-level) trigger, same unconditional
--     raise, plus an explicit `revoke truncate` from every non-owner role.
--     TRUNCATE is neither UPDATE nor DELETE and is not blocked by a
--     row-level trigger (TRUNCATE never fires row-level triggers at all),
--     and it would otherwise be available to service_role via the same
--     default-privilege ALL grant as UPDATE/DELETE — without both the
--     trigger and the revoke, TRUNCATE would have been a silent bypass of
--     point 2 above, wiping the whole table in one statement with no
--     per-row trigger to stop it.
--
-- Accepted, not preventable in-DB (recorded in docs/plans/console-plan.md
-- §6): the table OWNER (postgres) can still `alter table ... disable
-- trigger` or `drop trigger` before running a mutating statement, since
-- triggers and privilege grants are themselves owned/managed by that same
-- role. This is a property of Postgres ownership, not a gap specific to
-- this migration — the goal here is making UPDATE/DELETE/TRUNCATE
-- impossible via ordinary querying (including via service_role, which has
-- no ownership rights over this table), not impossible for a superuser
-- willing to first alter the schema itself, which is a far more visible,
-- reviewable action than a stray DML statement.
--
-- Writes go through private.log_staff_action() (SECURITY DEFINER,
-- service_role-only via explicit grant — unlike private.log_audit(),
-- 0001_auth_orgs.sql, which is only ever called from other owner-run
-- SECURITY DEFINER functions and needs no direct grant, this one is also
-- meant to be called directly by future console service-layer code
-- running as service_role, so it needs its own explicit grant). A plain
-- `insert` as service_role/postgres also works and is not blocked —
-- manageStaff.ts uses the RPC for consistency/documentation value, not
-- because a raw insert would be rejected. Only UPDATE/DELETE/TRUNCATE are
-- ever rejected, unconditionally, by the triggers below.

create table public.staff_audit_log (
  id             uuid primary key default gen_random_uuid(),
  staff_user_id  uuid not null references public."user" (id),
  org_id         uuid references public.organizations (id),
  target_user_id uuid references public."user" (id),
  action         text not null,
  detail         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

comment on table public.staff_audit_log is
  'Append-only trail of every staff read/action, including platform_staff '
  'grant/revoke/bootstrap itself. Write path is private.log_staff_action() '
  'or a direct insert as service_role/postgres; UPDATE and DELETE are '
  'rejected unconditionally by staff_audit_log_append_only, for every '
  'role including the table owner. RLS enabled with zero policies: no '
  'authenticated or anon access at all. See docs/plans/console-plan.md.';

comment on column public.staff_audit_log.staff_user_id is
  'The staff member who performed the read/action (the actor). Always '
  'required, never null.';

comment on column public.staff_audit_log.org_id is
  'The org this read/action was scoped to, if any. Null for account-level '
  'actions with no single org (e.g. platform_staff grant/revoke/bootstrap) '
  'or actions against a user with no org membership.';

comment on column public.staff_audit_log.target_user_id is
  'The user this read/action was about, if any — the staff member being '
  'granted/revoked/bootstrapped (Step 2), or a customer user being '
  'viewed/acted on (later build-order steps).';

comment on column public.staff_audit_log.action is
  'Free-text action tag, e.g. staff.grant / staff.revoke / staff.bootstrap '
  '/ org.read / org.suspend / user.revoke_sessions (later steps).';

comment on column public.staff_audit_log.detail is
  'Free-form jsonb context for the action. Never contains secrets or '
  'decrypted credentials — same rule public.audit_log follows.';

create index staff_audit_log_staff_user_id_created_at_idx
  on public.staff_audit_log (staff_user_id, created_at desc);

create index staff_audit_log_org_id_created_at_idx
  on public.staff_audit_log (org_id, created_at desc) where org_id is not null;

create index staff_audit_log_target_user_id_created_at_idx
  on public.staff_audit_log (target_user_id, created_at desc) where target_user_id is not null;

alter table public.staff_audit_log enable row level security;

-- =========================================================================
-- Append-only enforcement: reject UPDATE/DELETE unconditionally, for every
-- role including the table owner — see header comment for why this, and
-- not just RLS, is required.
-- =========================================================================

create or replace function private.reject_staff_audit_log_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'staff_audit_log is append-only: % is not permitted', tg_op;
end;
$$;

create trigger staff_audit_log_append_only
  before update or delete on public.staff_audit_log
  for each row execute function private.reject_staff_audit_log_mutation();

-- TRUNCATE is statement-level (no OLD/NEW row), fires with no row-level
-- trigger at all, and is granted to service_role via the same
-- ALTER DEFAULT PRIVILEGES ALL as UPDATE/DELETE — needs its own trigger
-- function (FOR EACH STATEMENT, not FOR EACH ROW) and its own revoke.
create or replace function private.reject_staff_audit_log_truncate()
returns trigger
language plpgsql
as $$
begin
  raise exception 'staff_audit_log is append-only: TRUNCATE is not permitted';
end;
$$;

create trigger staff_audit_log_no_truncate
  before truncate on public.staff_audit_log
  for each statement execute function private.reject_staff_audit_log_truncate();

revoke truncate on public.staff_audit_log from public, anon, authenticated, service_role;

-- =========================================================================
-- private.log_staff_action — the intended write path.
-- =========================================================================

create or replace function private.log_staff_action(
  p_staff_user_id  uuid,
  p_action         text,
  p_target_user_id uuid default null,
  p_org_id         uuid default null,
  p_detail         jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_staff_user_id is null then
    raise exception 'p_staff_user_id is required';
  end if;
  if p_action is null or length(trim(p_action)) = 0 then
    raise exception 'p_action is required';
  end if;

  insert into public.staff_audit_log (staff_user_id, org_id, target_user_id, action, detail)
  values (p_staff_user_id, p_org_id, p_target_user_id, p_action, coalesce(p_detail, '{}'::jsonb));
end;
$$;

-- Explicit grant to service_role (unlike private.log_audit()): this
-- function is meant to be called directly by service_role connections
-- (future console service-layer code, and manageStaff.ts running as the
-- postgres login role, which bypasses grant checks entirely as owner),
-- not only from inside another owner-run SECURITY DEFINER function.
revoke execute on function private.log_staff_action(uuid, text, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function private.log_staff_action(uuid, text, uuid, uuid, jsonb) to service_role;
