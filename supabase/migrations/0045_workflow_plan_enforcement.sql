-- 0045_workflow_plan_enforcement.sql
-- Console v1 Slice 3a (docs/plans/console-plan.md, build order step 8):
-- PATCH /console/orgs/:orgId/plan + workflow_limit enforcement. Two
-- independent pieces:
--
-- 1. private.log_org_audit() — a NEW service-role-callable audit helper for
--    the org's own audit_log. The plan doc's §3 says the PATCH route
--    "also calls the existing private.log_audit(org_id, action, detail)
--    RPC" — but private.log_audit (0001_auth_orgs.sql) is NOT usable from
--    the console route as written: it is revoked from public/anon/
--    authenticated with no grant to service_role at all (only callable
--    from another SECURITY DEFINER function owned by the same definer),
--    and it reads auth.uid() internally to set `actor` — which resolves to
--    null under withServiceRole (no request.jwt.claims set; see
--    packages/db/src/client.ts). Every existing audited write in this
--    codebase that needs auth.uid() genuinely available goes through
--    withUser instead (apps/api/src/copilot/audit.ts's own header comment
--    says so explicitly) — but the console router deliberately reads/writes
--    cross-org via withServiceRole (requireStaff already gates it; see
--    routes/console.ts's own header comment), so that option doesn't apply
--    here either. Reusing/modifying log_audit's signature isn't an option
--    without risking its other caller (create_organization).
--    private.log_org_audit is the same shape as private.log_staff_action
--    (0040_staff_audit_log.sql): SECURITY DEFINER, pinned search_path,
--    explicit p_actor parameter (the staff member's id, supplied by the
--    caller instead of relying on auth.uid()), explicitly granted to
--    service_role and nobody else.
--
-- 2. private.enforce_workflow_limit() — a BEFORE INSERT trigger on
--    public.workflows, the source of truth for workflow_limit (the
--    createWorkflow application-level pre-check in
--    apps/web/src/lib/dashboard/actions.ts is a fast-path/friendly-message
--    convenience only; this trigger is what actually cannot be bypassed,
--    matching every other insert path into workflows — supabase/seed.sql,
--    any future RPC — automatically). Mirrors getOrgPlan()'s exact
--    "case when op.org_id is null then 25 else op.workflow_limit end"
--    default (apps/api/src/services/dashboard.ts) for org-scoped rows, and
--    the same Pro/25 default for personally-owned rows (org_id null,
--    owner_id set — 0005_individual_workspace.sql's xor shape; org_plan
--    structurally cannot apply to a row with no organizations id at all).
--    null workflow_limit = unlimited (org_plan's own column comment).
--
--    Concurrency safety: two concurrent inserts for the SAME org/owner
--    racing past a plain `count(*)` check both risk reading the same
--    pre-insert count and both succeeding past the limit. Guarded with
--    pg_advisory_xact_lock keyed on the org_id/owner_id, taken before the
--    count — this serializes concurrent inserts for that one org/owner
--    (the second insert blocks until the first's transaction commits or
--    rolls back, so it recounts including the first's new row) while
--    leaving inserts for different orgs/owners fully concurrent. Chosen
--    over `select ... for update` on org_plan because that would only
--    protect orgs that already have an org_plan row (every org since
--    0043's trigger, but not guaranteed for older data) and has no
--    equivalent row to lock at all for personally-owned workflows.
--    Advisory locks are transaction-scoped (`_xact_`) so they release
--    automatically on commit or rollback — no explicit unlock needed, and
--    nothing can be left held by a crashed session.
--
--    Raises with a custom SQLSTATE ('NIA01', an arbitrary code that does
--    not collide with any built-in Postgres error class) rather than
--    requiring callers to string-match the message — the message text
--    itself is the exact customer-facing copy (IS the surfaced string),
--    while `err.code === 'NIA01'` is how apps/web/src/lib/dashboard/
--    actions.ts distinguishes "hit the limit" from any other unexpected
--    database error without depending on wording staying stable.

create or replace function private.log_org_audit(
  p_org_id uuid,
  p_actor uuid,
  p_action text,
  p_detail jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_org_id is null then
    raise exception 'p_org_id is required';
  end if;
  if p_action is null or length(trim(p_action)) = 0 then
    raise exception 'p_action is required';
  end if;

  insert into public.audit_log (org_id, actor, action, detail)
  values (p_org_id, p_actor, p_action, coalesce(p_detail, '{}'::jsonb));
end;
$$;

revoke execute on function private.log_org_audit(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function private.log_org_audit(uuid, uuid, text, jsonb) to service_role;

create or replace function private.enforce_workflow_limit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_limit integer;
  v_count integer;
begin
  if new.org_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.org_id::text, 0));

    select case when op.org_id is null then 25 else op.workflow_limit end
      into v_limit
      from (select new.org_id as id) o
      left join public.org_plan op on op.org_id = o.id;

    if v_limit is not null then
      select count(*) into v_count from public.workflows where org_id = new.org_id;
      if v_count >= v_limit then
        raise exception 'Your plan allows % workflows. Delete one or upgrade to add more.', v_limit
          using errcode = 'NIA01';
      end if;
    end if;
  else
    -- Personally-owned workflow (org_id is null, owner_id is not null per
    -- workflows_org_xor_owner) — no org_plan row can exist for it; matches
    -- getOrgPlan()'s own "no orgId in scope" branch (hardcoded Pro/25).
    perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text, 1));

    v_limit := 25;
    select count(*) into v_count from public.workflows where owner_id = new.owner_id;
    if v_count >= v_limit then
      raise exception 'Your plan allows % workflows. Delete one or upgrade to add more.', v_limit
        using errcode = 'NIA01';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function private.enforce_workflow_limit() from public, anon, authenticated, service_role;

create trigger workflows_enforce_limit
  before insert on public.workflows
  for each row
  execute function private.enforce_workflow_limit();
