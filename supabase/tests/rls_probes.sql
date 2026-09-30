-- rls_probes.sql
-- Manual RLS/privilege-escalation probes for 0001_auth_orgs.sql.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/rls_probes.sql
-- or:
--   supabase db execute --local -f supabase/tests/rls_probes.sql
--
-- The whole script runs inside one transaction that is ROLLED BACK at the
-- end, so it never leaves fixture data behind — safe to run against a
-- staging (or even prod) database as a superuser/postgres connection.
--
-- Each probe is an isolated DO block. Inside a DO block, PL/pgSQL's own
-- BEGIN/EXCEPTION acts as an implicit subtransaction, so a failed
-- assertion (RAISE EXCEPTION) is caught and reported without aborting the
-- outer transaction or any later probe.
--
-- Simulating a client: `set local role authenticated;` switches privilege
-- to the same role PostgREST/Supabase uses (RLS applies to it, unlike
-- superuser/table-owner connections), and setting the `request.jwt.claims`
-- GUC's `sub` is what `auth.uid()` reads to determine "the current user".

begin;

-- =========================================================================
-- Fixtures (inserted as postgres — bypasses RLS)
-- =========================================================================

create temporary table test_ids (key text primary key, id uuid not null) on commit drop;
create temporary table probe_results (n int, name text, passed boolean) on commit drop;
-- Captures 'org's org_plan row exactly as 0050_org_plan_overrides.sql's
-- create-org trigger leaves it, before the project/workflow-limit-lifting
-- override a few lines below permanently overwrites those same columns for
-- the rest of this script. Probe 55 asserts against this snapshot (not a
-- live query) for that reason — see the override's own comment and probe
-- 55's comment for the full explanation.
create temporary table probe55_baseline (workflow_limit int, workflow_limit_set boolean) on commit drop;

do $$
declare
  v_owner    uuid; -- owner, org creator
  v_admin2   uuid; -- second owner
  v_admin    uuid; -- plain admin
  v_member   uuid; -- plain member
  v_outsider uuid; -- not a member of the org
  v_viewer   uuid; -- read-only viewer (Subscription Phase 2, Slice 3)
  v_org      uuid;
begin
  -- Fixture identities are created ahead of time through Better Auth's own
  -- signUpEmail path (never raw SQL — the password hash format is internal
  -- to Better Auth), by:
  --   pnpm --filter @nia/api seed:fixtures
  -- Looked up here by email rather than inserted, since this whole script
  -- runs inside one transaction that gets rolled back at the end, but these
  -- users must persist across runs for that command to stay idempotent.
  select id into v_owner    from public."user" where email = 'owner@rls-probe.test';
  select id into v_admin2   from public."user" where email = 'admin2@rls-probe.test';
  select id into v_admin    from public."user" where email = 'admin@rls-probe.test';
  select id into v_member   from public."user" where email = 'member@rls-probe.test';
  select id into v_outsider from public."user" where email = 'outsider@rls-probe.test';
  select id into v_viewer   from public."user" where email = 'viewer@rls-probe.test';
  if v_owner is null or v_admin2 is null or v_admin is null or v_member is null or v_outsider is null
     or v_viewer is null then
    raise exception 'rls_probes.sql: fixture users not found — run `pnpm --filter @nia/api seed:fixtures` against this database first.';
  end if;
  -- databaseHooks.user.create.after (packages/auth/src/config.ts) already
  -- created matching public.profiles rows at signup time.

  insert into public.organizations (name, slug, created_by)
  values ('RLS Probe Org', 'rls-probe-org', v_owner)
  returning id into v_org;

  insert into public.organization_members (org_id, user_id, role) values
    (v_org, v_owner,  'owner'),
    (v_org, v_admin2, 'owner'),
    (v_org, v_admin,  'admin'),
    (v_org, v_member, 'member'),
    (v_org, v_viewer, 'viewer');

  -- Lift this org's project_limit AND workflow_limit for the rest of the
  -- script. 0050_org_plan_overrides.sql's create-org trigger defaults every
  -- new org to the 'free' plan (project_limit=1, workflow_limit=2,
  -- 0049_plans_table.sql), and this script goes on to insert several
  -- org-scoped projects (probes 11, 66-69, 73, 79+) and workflows (probes
  -- 11, 66-70) against 'org' that were never meant to be gated by
  -- 0052_project_limit_enforcement.sql / 0053_workflow_limit_uses_plans.sql's
  -- triggers — that enforcement is real product behavior under test
  -- elsewhere (probes covering those migrations themselves) and each of
  -- these existing fixtures predates them with no exception handling of
  -- their own, so without this override the second org-scoped project
  -- insert (or third workflow insert) in the whole script trips "Your Free
  -- plan allows 1 project"/"...2 workflows" (NIA02/NIA01) and aborts the
  -- entire transaction — including, before this fix, masking probe 70's
  -- suspension check behind an unrelated limit error.
  insert into probe55_baseline (workflow_limit, workflow_limit_set)
  select workflow_limit, workflow_limit_set from public.org_plan where org_id = v_org;

  update public.org_plan
  set project_limit_set = true, project_limit = null,
      workflow_limit_set = true, workflow_limit = null
  where org_id = v_org;

  insert into test_ids values
    ('owner', v_owner), ('admin2', v_admin2), ('admin', v_admin),
    ('member', v_member), ('outsider', v_outsider), ('viewer', v_viewer), ('org', v_org);
end $$;

-- Helper: act as a given test user for the rest of the (sub)transaction.
create or replace function pg_temp.act_as(p_user uuid) returns void
language plpgsql as $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end;
$$;

-- =========================================================================
-- Probe 1 — non-member cannot see the org or its members
-- =========================================================================
do $$
declare
  v_org uuid := (select id from test_ids where key = 'org');
  v_outsider uuid := (select id from test_ids where key = 'outsider');
  n_orgs int;
  n_members int;
begin
  perform pg_temp.act_as(v_outsider);

  select count(*) into n_orgs from public.organizations where id = v_org;
  select count(*) into n_members from public.organization_members where org_id = v_org;
  reset role;

  if n_orgs = 0 and n_members = 0 then
    insert into probe_results values (1, 'non-member cannot select org/members', true);
  else
    insert into probe_results values (1, 'non-member cannot select org/members', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (1, 'non-member cannot select org/members (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 2 — plain member can read but cannot update the organization
-- =========================================================================
do $$
declare
  v_org uuid := (select id from test_ids where key = 'org');
  v_member uuid := (select id from test_ids where key = 'member');
  n_visible int;
  n_updated int;
begin
  perform pg_temp.act_as(v_member);

  select count(*) into n_visible from public.organizations where id = v_org;
  update public.organizations set name = 'Hijacked' where id = v_org;
  get diagnostics n_updated = row_count;
  reset role;

  if n_visible = 1 and n_updated = 0 then
    insert into probe_results values (2, 'member can read but not update org', true);
  else
    insert into probe_results values (2, 'member can read but not update org', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (2, 'member can read but not update org (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 3 — plain admin cannot INSERT a new member row with role=owner
-- =========================================================================
do $$
declare
  v_org uuid := (select id from test_ids where key = 'org');
  v_admin uuid := (select id from test_ids where key = 'admin');
  v_new uuid;
  denied boolean := false;
begin
  -- Fixture identity created ahead of time via `pnpm --filter @nia/api
  -- seed:fixtures` (see the main fixture block above for why).
  select id into v_new from public."user" where email = 'newperson@rls-probe.test';
  if v_new is null then
    raise exception 'rls_probes.sql: fixture user not found — run `pnpm --filter @nia/api seed:fixtures` against this database first.';
  end if;

  perform pg_temp.act_as(v_admin);
  begin
    insert into public.organization_members (org_id, user_id, role) values (v_org, v_new, 'owner');
    denied := false; -- insert succeeded — that's a FAIL (escalation allowed)
  exception when insufficient_privilege or others then
    denied := true; -- WITH CHECK rejected it — expected
  end;
  reset role;

  insert into probe_results values (3, 'admin cannot insert self/other as owner', denied);
exception when others then
  reset role;
  insert into probe_results values (3, 'admin cannot insert as owner (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 4 — plain admin cannot UPDATE a member's role to owner
-- =========================================================================
do $$
declare
  v_org uuid := (select id from test_ids where key = 'org');
  v_admin uuid := (select id from test_ids where key = 'admin');
  v_member uuid := (select id from test_ids where key = 'member');
  n_updated int := 0;
  still_member boolean;
  denied boolean := false;
begin
  perform pg_temp.act_as(v_admin);
  begin
    -- WITH CHECK failure on the NEW row raises an exception (unlike USING,
    -- which just silently filters candidate rows) — this is expected here.
    update public.organization_members set role = 'owner' where org_id = v_org and user_id = v_member;
    get diagnostics n_updated = row_count;
  exception when insufficient_privilege or others then
    denied := true;
  end;
  reset role;

  select (role = 'member') into still_member
  from public.organization_members where org_id = v_org and user_id = v_member;

  if (denied or n_updated = 0) and still_member then
    insert into probe_results values (4, 'admin cannot promote member to owner', true);
  else
    insert into probe_results values (4, 'admin cannot promote member to owner', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (4, 'admin cannot promote member to owner (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 5 — last-owner protection trigger fires on demote/delete
-- =========================================================================
do $$
declare
  v_org uuid := (select id from test_ids where key = 'org');
  v_owner uuid := (select id from test_ids where key = 'owner');
  v_admin2 uuid := (select id from test_ids where key = 'admin2');
  blocked_demote boolean := false;
  blocked_delete boolean := false;
begin
  -- Temporarily drop to a single owner (owner) by demoting admin2,
  -- done as postgres (bypasses RLS) so only the trigger is under test.
  update public.organization_members set role = 'admin' where org_id = v_org and user_id = v_admin2;

  begin
    update public.organization_members set role = 'admin' where org_id = v_org and user_id = v_owner;
    blocked_demote := false; -- should never get here
  exception when others then
    blocked_demote := true;
  end;

  begin
    delete from public.organization_members where org_id = v_org and user_id = v_owner;
    blocked_delete := false; -- should never get here
  exception when others then
    blocked_delete := true;
  end;

  -- Restore admin2 to owner for later probes.
  update public.organization_members set role = 'owner' where org_id = v_org and user_id = v_admin2;

  if blocked_demote and blocked_delete then
    insert into probe_results values (5, 'trigger blocks demoting/deleting the last owner', true);
  else
    insert into probe_results values (5, 'trigger blocks demoting/deleting the last owner', false);
  end if;
exception when others then
  insert into probe_results values (5, 'last-owner trigger probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 6 — delete-path escalation guard
--   6a: plain admin deletes an owner's membership row -> DENIED
--   6b: another owner does the same -> ALLOWED (2 owners exist,
--       so the last-owner trigger does not block it)
-- =========================================================================
do $$
declare
  v_org uuid := (select id from test_ids where key = 'org');
  v_admin uuid := (select id from test_ids where key = 'admin');
  v_owner uuid := (select id from test_ids where key = 'owner');
  v_admin2 uuid := (select id from test_ids where key = 'admin2');
  n_deleted int;
  admin2_still_present boolean;
  pass_6a boolean;
  pass_6b boolean;
begin
  -- 6a: plain admin attempts to delete admin2 (an owner) — must be denied by RLS.
  perform pg_temp.act_as(v_admin);
  delete from public.organization_members where org_id = v_org and user_id = v_admin2;
  get diagnostics n_deleted = row_count;
  reset role;

  select exists (
    select 1 from public.organization_members where org_id = v_org and user_id = v_admin2
  ) into admin2_still_present;

  pass_6a := (n_deleted = 0 and admin2_still_present);
  insert into probe_results values (61, '6a: plain admin cannot delete an owner membership', pass_6a);

  -- 6b: owner (another owner) deletes admin2 — allowed, since owner
  -- remains as an owner afterward (trigger does not block this case).
  perform pg_temp.act_as(v_owner);
  delete from public.organization_members where org_id = v_org and user_id = v_admin2;
  get diagnostics n_deleted = row_count;
  reset role;

  select not exists (
    select 1 from public.organization_members where org_id = v_org and user_id = v_admin2
  ) into pass_6b;
  pass_6b := (n_deleted = 1 and pass_6b);

  insert into probe_results values (62, '6b: another owner CAN delete an owner membership (not last)', pass_6b);
exception when others then
  reset role;
  insert into probe_results values (60, 'probe 6 (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Fixture for probes 7-10 — an individual (org-less) user
-- =========================================================================
do $$
declare
  v_individual uuid;
begin
  -- Fixture identity created ahead of time via `pnpm --filter @nia/api
  -- seed:fixtures` (see the main fixture block above for why).
  select id into v_individual from public."user" where email = 'individual@rls-probe.test';
  if v_individual is null then
    raise exception 'rls_probes.sql: fixture user not found — run `pnpm --filter @nia/api seed:fixtures` against this database first.';
  end if;

  -- Lift this individual's project_limit for the rest of the script, same
  -- reasoning as the 'org' override above — probe 7 creates a personal
  -- project and probe 71 (suspension-unaffected personal project) creates
  -- a second one; the free plan's project_limit=1 (0049_plans_table.sql)
  -- would otherwise trip 0052_project_limit_enforcement.sql on that second
  -- insert, unrelated to what probe 71 is actually testing.
  update public.owner_plan
  set project_limit_set = true, project_limit = null
  where user_id = v_individual;

  insert into test_ids values ('individual', v_individual);
end $$;

-- =========================================================================
-- Probe 7 — individual user can create and read their own personal project
-- (org_id null, owner_id = self) — 0005_individual_workspace.sql
-- =========================================================================
do $$
declare
  v_individual uuid := (select id from test_ids where key = 'individual');
  v_project uuid;
  n_visible int;
begin
  perform pg_temp.act_as(v_individual);
  insert into public.projects (org_id, owner_id, name, created_by)
  values (null, v_individual, 'Personal project', v_individual)
  returning id into v_project;

  select count(*) into n_visible from public.projects where id = v_project;
  reset role;

  insert into test_ids values ('personal_project', v_project);

  if n_visible = 1 then
    insert into probe_results values (7, 'individual can create and read their own personal project', true);
  else
    insert into probe_results values (7, 'individual can create and read their own personal project', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (7, 'individual personal project probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 8 — another user cannot see someone else's personal project
-- =========================================================================
do $$
declare
  v_outsider uuid := (select id from test_ids where key = 'outsider');
  v_project uuid := (select id from test_ids where key = 'personal_project');
  n_visible int;
begin
  perform pg_temp.act_as(v_outsider);
  select count(*) into n_visible from public.projects where id = v_project;
  reset role;

  if n_visible = 0 then
    insert into probe_results values (8, 'other user cannot see someone else''s personal project', true);
  else
    insert into probe_results values (8, 'other user cannot see someone else''s personal project', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (8, 'personal project isolation probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 9 — org_id/owner_id are mutually exclusive (never both, never
-- neither) — rejected by RLS and/or the projects_org_xor_owner constraint
-- =========================================================================
do $$
declare
  v_individual uuid := (select id from test_ids where key = 'individual');
  v_org uuid := (select id from test_ids where key = 'org');
  rejected_both_set boolean := false;
  rejected_neither_set boolean := false;
begin
  perform pg_temp.act_as(v_individual);

  begin
    insert into public.projects (org_id, owner_id, name, created_by)
    values (v_org, v_individual, 'Invalid: both set', v_individual);
  exception when others then
    rejected_both_set := true;
  end;

  begin
    insert into public.projects (org_id, owner_id, name, created_by)
    values (null, null, 'Invalid: neither set', v_individual);
  exception when others then
    rejected_neither_set := true;
  end;

  reset role;

  if rejected_both_set and rejected_neither_set then
    insert into probe_results values (9, 'org_id/owner_id xor is enforced (rejects both-set and neither-set)', true);
  else
    insert into probe_results values (9, 'org_id/owner_id xor is enforced (rejects both-set and neither-set)', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (9, 'org_id/owner_id xor probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 10 — create_organization() RPC assigns the creator role 'owner'
-- (end-to-end regression check for the super_admin -> owner rename)
-- =========================================================================
do $$
declare
  v_individual uuid := (select id from test_ids where key = 'individual');
  v_new_org uuid;
  v_role public.org_role;
begin
  perform pg_temp.act_as(v_individual);
  select public.create_organization('Regression Org', 'regression-org-' || substr(v_individual::text, 1, 8)) into v_new_org;
  reset role;

  select role into v_role from public.organization_members
  where org_id = v_new_org and user_id = v_individual;

  if v_role = 'owner' then
    insert into probe_results values (10, 'create_organization() assigns creator role owner (post-rename)', true);
  else
    insert into probe_results values (10, 'create_organization() assigns creator role owner (post-rename)', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (10, 'create_organization owner-role regression probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Fixture for probe 11 — a second org ("org B") with its own member, plus
-- an org-scoped project/workflow/workflow_run under each org
-- (0002_projects_workflows.sql cross-org isolation)
-- =========================================================================
do $$
declare
  v_org_b_owner uuid;
  v_org_b uuid;
  v_project_a uuid;
  v_project_b uuid;
  v_workflow_a uuid;
  v_workflow_b uuid;
  v_member uuid := (select id from test_ids where key = 'member');
begin
  -- Fixture identity created ahead of time via `pnpm --filter @nia/api
  -- seed:fixtures` (see the main fixture block above for why).
  select id into v_org_b_owner from public."user" where email = 'orgb-owner@rls-probe.test';
  if v_org_b_owner is null then
    raise exception 'rls_probes.sql: fixture user not found — run `pnpm --filter @nia/api seed:fixtures` against this database first.';
  end if;

  insert into public.organizations (name, slug, created_by)
  values ('RLS Probe Org B', 'rls-probe-org-b', v_org_b_owner)
  returning id into v_org_b;

  insert into public.organization_members (org_id, user_id, role) values (v_org_b, v_org_b_owner, 'owner');

  -- Lift org B's project_limit for the rest of the script, same reasoning
  -- as the 'org' override above — the fixture below creates one org-scoped
  -- project and probe 72 (cross-org isolation) creates a second one; the
  -- free plan's project_limit=1 (0049_plans_table.sql) would otherwise trip
  -- 0052_project_limit_enforcement.sql on that second insert, unrelated to
  -- what probe 72 is actually testing.
  update public.org_plan
  set project_limit_set = true, project_limit = null
  where org_id = v_org_b;

  -- Fixtures inserted as postgres (bypasses RLS) — only the SELECT-side
  -- isolation is under test here, not the insert-side policies (already
  -- covered by probes elsewhere).
  insert into public.projects (org_id, name, created_by) values ((select id from test_ids where key = 'org'), 'Org A project', v_member) returning id into v_project_a;
  insert into public.projects (org_id, name, created_by) values (v_org_b, 'Org B project', v_org_b_owner) returning id into v_project_b;

  insert into public.workflows (project_id, org_id, name, created_by) values (v_project_a, (select id from test_ids where key = 'org'), 'Org A workflow', v_member) returning id into v_workflow_a;
  insert into public.workflows (project_id, org_id, name, created_by) values (v_project_b, v_org_b, 'Org B workflow', v_org_b_owner) returning id into v_workflow_b;

  insert into public.workflow_runs (workflow_id, org_id, status, rows_processed) values (v_workflow_a, (select id from test_ids where key = 'org'), 'succeeded', 100);
  insert into public.workflow_runs (workflow_id, org_id, status, rows_processed) values (v_workflow_b, v_org_b, 'succeeded', 200);

  insert into test_ids values ('org_b', v_org_b), ('org_b_owner', v_org_b_owner), ('workflow_a', v_workflow_a), ('workflow_b', v_workflow_b);
end $$;

-- =========================================================================
-- Probe 11 — a member of org A cannot see org B's workflow_runs (or vice
-- versa); each can only see their own org's runs
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_org_b_owner uuid := (select id from test_ids where key = 'org_b_owner');
  v_workflow_a uuid := (select id from test_ids where key = 'workflow_a');
  v_workflow_b uuid := (select id from test_ids where key = 'workflow_b');
  n_a_sees_a int;
  n_a_sees_b int;
  n_b_sees_b int;
  n_b_sees_a int;
begin
  perform pg_temp.act_as(v_member);
  select count(*) into n_a_sees_a from public.workflow_runs where workflow_id = v_workflow_a;
  select count(*) into n_a_sees_b from public.workflow_runs where workflow_id = v_workflow_b;
  reset role;

  perform pg_temp.act_as(v_org_b_owner);
  select count(*) into n_b_sees_b from public.workflow_runs where workflow_id = v_workflow_b;
  select count(*) into n_b_sees_a from public.workflow_runs where workflow_id = v_workflow_a;
  reset role;

  if n_a_sees_a = 1 and n_a_sees_b = 0 and n_b_sees_b = 1 and n_b_sees_a = 0 then
    insert into probe_results values (11, 'org member cannot see another org''s workflow_runs', true);
  else
    insert into probe_results values (11, 'org member cannot see another org''s workflow_runs', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (11, 'cross-org workflow_runs isolation probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probes 12-17 — 0007_connectors.sql (connector_installs/connections/
-- write_grants + the audit_log org/owner extension)
-- =========================================================================

-- Probe 12 — any org member can install a connector (no role gate); an
-- outsider cannot see or install it.
do $$
declare
  v_member   uuid := (select id from test_ids where key = 'member');
  v_outsider uuid := (select id from test_ids where key = 'outsider');
  v_org      uuid := (select id from test_ids where key = 'org');
  v_install  uuid;
  n_outsider_sees int;
  outsider_denied boolean := false;
begin
  perform pg_temp.act_as(v_member);
  insert into public.connector_installs (org_id, connector_id, installed_by_user_id)
  values (v_org, 'mysql', v_member)
  returning id into v_install;
  reset role;

  perform pg_temp.act_as(v_outsider);
  select count(*) into n_outsider_sees from public.connector_installs where id = v_install;
  begin
    insert into public.connector_installs (org_id, connector_id, installed_by_user_id)
    values (v_org, 'mongo', v_outsider);
  exception when others then
    outsider_denied := true;
  end;
  reset role;

  insert into test_ids values ('connector_install_org', v_install);

  if n_outsider_sees = 0 and outsider_denied then
    insert into probe_results values (12, 'any org member can install a connector; outsider cannot see/install', true);
  else
    insert into probe_results values (12, 'any org member can install a connector; outsider cannot see/install', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (12, 'connector install probe (errored: ' || sqlerrm || ')', false);
end $$;

-- Probe 13 — an individual (org-less) user can install into their own
-- personal workspace; another individual cannot see it.
do $$
declare
  v_individual  uuid := (select id from test_ids where key = 'individual');
  v_outsider    uuid := (select id from test_ids where key = 'outsider');
  v_install     uuid;
  n_outsider_sees int;
begin
  perform pg_temp.act_as(v_individual);
  insert into public.connector_installs (owner_id, connector_id, installed_by_user_id)
  values (v_individual, 'mysql', v_individual)
  returning id into v_install;
  reset role;

  perform pg_temp.act_as(v_outsider);
  select count(*) into n_outsider_sees from public.connector_installs where id = v_install;
  reset role;

  if n_outsider_sees = 0 then
    insert into probe_results values (13, 'individual can install into personal workspace, isolated from others', true);
  else
    insert into probe_results values (13, 'individual can install into personal workspace, isolated from others', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (13, 'personal connector install probe (errored: ' || sqlerrm || ')', false);
end $$;

-- Probe 14 — a connection is org-visible: any member (not just its
-- owner_user_id) can update/delete it; an outsider cannot see it at all.
do $$
declare
  v_owner    uuid := (select id from test_ids where key = 'owner');
  v_member   uuid := (select id from test_ids where key = 'member');
  v_outsider uuid := (select id from test_ids where key = 'outsider');
  v_org      uuid := (select id from test_ids where key = 'org');
  v_conn     uuid;
  n_outsider_sees int;
  n_member_updated int;
begin
  -- owner connects it (owner_user_id = owner), member (a different user)
  -- must still be able to manage it per "not access control".
  perform pg_temp.act_as(v_owner);
  insert into public.connections (org_id, connector_id, handle, display_name, owner_user_id, vault_secret_ref)
  values (v_org, 'mysql', '@mysql-probe', 'Probe DB', v_owner, 'vault:probe-ref')
  returning id into v_conn;
  reset role;

  perform pg_temp.act_as(v_outsider);
  select count(*) into n_outsider_sees from public.connections where id = v_conn;
  reset role;

  perform pg_temp.act_as(v_member);
  update public.connections set display_name = 'Renamed by member' where id = v_conn;
  get diagnostics n_member_updated = row_count;
  reset role;

  insert into test_ids values ('connection_org', v_conn);

  if n_outsider_sees = 0 and n_member_updated = 1 then
    insert into probe_results values (14, 'connection is org-visible; any member (not just owner_user_id) can manage it; outsider cannot see it', true);
  else
    insert into probe_results values (14, 'connection is org-visible; any member (not just owner_user_id) can manage it; outsider cannot see it', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (14, 'connection org-visibility probe (errored: ' || sqlerrm || ')', false);
end $$;

-- Probe 15 — org_id/owner_id xor is enforced on connections (mirrors
-- probe 9 for projects).
do $$
declare
  v_individual uuid := (select id from test_ids where key = 'individual');
  v_org        uuid := (select id from test_ids where key = 'org');
  both_rejected boolean := false;
  neither_rejected boolean := false;
begin
  perform pg_temp.act_as(v_individual);

  begin
    insert into public.connections (org_id, owner_id, connector_id, handle, display_name, owner_user_id, vault_secret_ref)
    values (v_org, v_individual, 'mysql', '@both-set', 'Invalid', v_individual, 'vault:x');
  exception when others then
    both_rejected := true;
  end;

  begin
    insert into public.connections (org_id, owner_id, connector_id, handle, display_name, owner_user_id, vault_secret_ref)
    values (null, null, 'mysql', '@neither-set', 'Invalid', v_individual, 'vault:x');
  exception when others then
    neither_rejected := true;
  end;

  reset role;

  if both_rejected and neither_rejected then
    insert into probe_results values (15, 'connections org_id/owner_id xor is enforced', true);
  else
    insert into probe_results values (15, 'connections org_id/owner_id xor is enforced', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (15, 'connections xor probe (errored: ' || sqlerrm || ')', false);
end $$;

-- Probe 16 — write_grants inherit scope from the parent connection (no
-- org_id/owner_id of their own): an org member can grant/see one on the
-- org's connection (via create_write_grant() — Phase 6 Block 1 locked
-- direct client INSERT down to RPC-only, see probes 35-40 below); an
-- outsider cannot see it.
do $$
declare
  v_member   uuid := (select id from test_ids where key = 'member');
  v_outsider uuid := (select id from test_ids where key = 'outsider');
  v_conn     uuid := (select id from test_ids where key = 'connection_org');
  v_grant    uuid;
  n_outsider_sees int;
begin
  perform pg_temp.act_as(v_member);
  select id into v_grant from public.create_write_grant(v_conn, '{"schemas":["sales"]}'::jsonb);
  reset role;

  perform pg_temp.act_as(v_outsider);
  select count(*) into n_outsider_sees from public.write_grants where id = v_grant;
  reset role;

  if n_outsider_sees = 0 then
    insert into probe_results values (16, 'write_grants inherit scope from parent connection; outsider cannot see one', true);
  else
    insert into probe_results values (16, 'write_grants inherit scope from parent connection; outsider cannot see one', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (16, 'write_grants scope probe (errored: ' || sqlerrm || ')', false);
end $$;

-- Probe 17 — audit_log's new owner_id branch: an individual's own
-- (personal-scoped) audit entries are visible to them, not to another
-- individual; org-scoped entries are unaffected (still admin-gated).
do $$
declare
  v_individual uuid := (select id from test_ids where key = 'individual');
  v_outsider   uuid := (select id from test_ids where key = 'outsider');
  n_self_sees int;
  n_other_sees int;
begin
  perform private.log_audit_personal(v_individual, 'connectors.install.probe', jsonb_build_object('connector_id', 'mysql'));

  perform pg_temp.act_as(v_individual);
  select count(*) into n_self_sees from public.audit_log where owner_id = v_individual and action = 'connectors.install.probe';
  reset role;

  perform pg_temp.act_as(v_outsider);
  select count(*) into n_other_sees from public.audit_log where owner_id = v_individual and action = 'connectors.install.probe';
  reset role;

  if n_self_sees = 1 and n_other_sees = 0 then
    insert into probe_results values (17, 'personal audit_log entries are visible to their owner only', true);
  else
    insert into probe_results values (17, 'personal audit_log entries are visible to their owner only', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (17, 'personal audit_log probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 18 — member can create a conversation + own user message; another
-- org member can read both (org-wide visibility, same as projects/workflows)
-- =========================================================================
do $$
declare
  v_org uuid := (select id from test_ids where key = 'org');
  v_member uuid := (select id from test_ids where key = 'member');
  v_admin uuid := (select id from test_ids where key = 'admin');
  v_conv uuid;
  n_admin_sees_conv int;
  n_admin_sees_msg int;
begin
  perform pg_temp.act_as(v_member);
  insert into public.conversations (org_id, created_by, title)
  values (v_org, v_member, 'Probe conversation')
  returning id into v_conv;
  insert into public.messages (conversation_id, org_id, role, content)
  values (v_conv, v_org, 'user', 'how many rows?');
  reset role;

  perform pg_temp.act_as(v_admin);
  select count(*) into n_admin_sees_conv from public.conversations where id = v_conv;
  select count(*) into n_admin_sees_msg from public.messages where conversation_id = v_conv;
  reset role;

  if n_admin_sees_conv = 1 and n_admin_sees_msg = 1 then
    insert into probe_results values (18, 'org member sees another member''s conversation + message', true);
  else
    insert into probe_results values (18, 'org member sees another member''s conversation + message', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (18, 'conversation/message visibility probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 19 — outsider (non-member) cannot see the conversation or message
-- =========================================================================
do $$
declare
  v_org uuid := (select id from test_ids where key = 'org');
  v_outsider uuid := (select id from test_ids where key = 'outsider');
  v_conv uuid := (select id from public.conversations where org_id = v_org and title = 'Probe conversation' limit 1);
  n_conv int;
  n_msg int;
begin
  perform pg_temp.act_as(v_outsider);
  select count(*) into n_conv from public.conversations where id = v_conv;
  select count(*) into n_msg from public.messages where conversation_id = v_conv;
  reset role;

  if n_conv = 0 and n_msg = 0 then
    insert into probe_results values (19, 'non-member cannot see conversation/message', true);
  else
    insert into probe_results values (19, 'non-member cannot see conversation/message', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (19, 'non-member conversation probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 20 — client cannot insert a role='assistant' message (worker-only,
-- service_role bypasses RLS; an authenticated client must never be able to
-- forge an assistant-authored row directly)
-- =========================================================================
do $$
declare
  v_org uuid := (select id from test_ids where key = 'org');
  v_member uuid := (select id from test_ids where key = 'member');
  v_conv uuid := (select id from public.conversations where org_id = v_org and title = 'Probe conversation' limit 1);
  denied boolean := false;
begin
  perform pg_temp.act_as(v_member);
  begin
    insert into public.messages (conversation_id, org_id, role, content)
    values (v_conv, v_org, 'assistant', 'forged answer');
    denied := false; -- insert succeeded — FAIL (client forged an assistant row)
  exception when insufficient_privilege or others then
    denied := true; -- WITH CHECK rejected it — expected
  end;
  reset role;

  insert into probe_results values (20, 'client cannot insert role=assistant message', denied);
exception when others then
  reset role;
  insert into probe_results values (20, 'client assistant-message probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 21 — member cannot insert a user message into a conversation they
-- didn't create (even within their own org)
-- =========================================================================
do $$
declare
  v_org uuid := (select id from test_ids where key = 'org');
  v_admin uuid := (select id from test_ids where key = 'admin');
  v_conv uuid := (select id from public.conversations where org_id = v_org and title = 'Probe conversation' limit 1);
  denied boolean := false;
begin
  perform pg_temp.act_as(v_admin);
  begin
    insert into public.messages (conversation_id, org_id, role, content)
    values (v_conv, v_org, 'user', 'not my conversation');
    denied := false; -- insert succeeded — FAIL
  exception when insufficient_privilege or others then
    denied := true; -- expected
  end;
  reset role;

  insert into probe_results values (21, 'member cannot insert user message into another member''s conversation', denied);
exception when others then
  reset role;
  insert into probe_results values (21, 'foreign-conversation message probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 22 — cross-org: org B member cannot see org A's conversation
-- =========================================================================
do $$
declare
  v_org_b_owner uuid := (select id from test_ids where key = 'org_b_owner');
  v_conv uuid := (select id from public.conversations where title = 'Probe conversation' limit 1);
  n_conv int;
begin
  perform pg_temp.act_as(v_org_b_owner);
  select count(*) into n_conv from public.conversations where id = v_conv;
  reset role;

  if n_conv = 0 then
    insert into probe_results values (22, 'cross-org member cannot see another org''s conversation', true);
  else
    insert into probe_results values (22, 'cross-org member cannot see another org''s conversation', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (22, 'cross-org conversation probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Fixture for probes 23-26 — 0012_workflow_graphs.sql: a personal
-- (org-less) workflow for 'individual', reusing their personal_project
-- from probe 7
-- =========================================================================
do $$
declare
  v_individual uuid := (select id from test_ids where key = 'individual');
  v_personal_project uuid := (select id from test_ids where key = 'personal_project');
  v_personal_workflow uuid;
begin
  insert into public.workflows (project_id, owner_id, name, created_by)
  values (v_personal_project, v_individual, 'Personal workflow', v_individual)
  returning id into v_personal_workflow;

  insert into test_ids values ('personal_workflow', v_personal_workflow);
end $$;

-- =========================================================================
-- Probe 23 — org member can create and read their workflow's graph
-- (private.can_access_workflow's org branch)
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_workflow_a uuid := (select id from test_ids where key = 'workflow_a');
  n_visible int;
begin
  perform pg_temp.act_as(v_member);
  insert into public.workflow_graphs (workflow_id, graph)
  values (v_workflow_a, '{"nodes":[{"id":"n1","type":"source","position":{"x":0,"y":0},"config":{}}],"edges":[]}'::jsonb);
  select count(*) into n_visible from public.workflow_graphs where workflow_id = v_workflow_a;
  reset role;

  if n_visible = 1 then
    insert into probe_results values (23, 'org member can create/read their workflow''s graph', true);
  else
    insert into probe_results values (23, 'org member can create/read their workflow''s graph', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (23, 'workflow_graphs org create/read probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 24 — cross-org: org B member cannot see or update org A's
-- workflow_graphs row (direct PostgREST-shaped update, not just select)
-- =========================================================================
do $$
declare
  v_org_b_owner uuid := (select id from test_ids where key = 'org_b_owner');
  v_workflow_a uuid := (select id from test_ids where key = 'workflow_a');
  n_visible int;
  n_updated int;
begin
  perform pg_temp.act_as(v_org_b_owner);
  select count(*) into n_visible from public.workflow_graphs where workflow_id = v_workflow_a;
  update public.workflow_graphs set graph = '{"nodes":[],"edges":[]}'::jsonb, version = version + 1 where workflow_id = v_workflow_a;
  get diagnostics n_updated = row_count;
  reset role;

  if n_visible = 0 and n_updated = 0 then
    insert into probe_results values (24, 'cross-org member cannot see or update another org''s workflow_graphs row', true);
  else
    insert into probe_results values (24, 'cross-org member cannot see or update another org''s workflow_graphs row', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (24, 'cross-org workflow_graphs probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 25 — individual (personal-workspace) user can create/update their
-- own workflow's graph (private.can_access_workflow's owner_id branch),
-- with optimistic-concurrency version bump
-- =========================================================================
do $$
declare
  v_individual uuid := (select id from test_ids where key = 'individual');
  v_personal_workflow uuid := (select id from test_ids where key = 'personal_workflow');
  n_updated int;
  v_version int;
begin
  perform pg_temp.act_as(v_individual);
  insert into public.workflow_graphs (workflow_id, graph)
  values (v_personal_workflow, '{"nodes":[],"edges":[]}'::jsonb);
  update public.workflow_graphs set graph = '{"nodes":[{"id":"n1","type":"transform","position":{"x":10,"y":10},"config":{}}],"edges":[]}'::jsonb, version = version + 1
  where workflow_id = v_personal_workflow and version = 1;
  get diagnostics n_updated = row_count;
  select version into v_version from public.workflow_graphs where workflow_id = v_personal_workflow;
  reset role;

  if n_updated = 1 and v_version = 2 then
    insert into probe_results values (25, 'individual can create/update their own workflow''s graph, version increments', true);
  else
    insert into probe_results values (25, 'individual can create/update their own workflow''s graph, version increments', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (25, 'personal workflow_graphs probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 26 — another individual cannot see or update someone else's
-- personal workflow_graphs row
-- =========================================================================
do $$
declare
  v_outsider uuid := (select id from test_ids where key = 'outsider');
  v_personal_workflow uuid := (select id from test_ids where key = 'personal_workflow');
  n_visible int;
  n_updated int;
begin
  perform pg_temp.act_as(v_outsider);
  select count(*) into n_visible from public.workflow_graphs where workflow_id = v_personal_workflow;
  update public.workflow_graphs set graph = '{"nodes":[],"edges":[]}'::jsonb, version = version + 1 where workflow_id = v_personal_workflow;
  get diagnostics n_updated = row_count;
  reset role;

  if n_visible = 0 and n_updated = 0 then
    insert into probe_results values (26, 'other individual cannot see or update someone else''s personal workflow_graphs row', true);
  else
    insert into probe_results values (26, 'other individual cannot see or update someone else''s personal workflow_graphs row', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (26, 'personal workflow_graphs isolation probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 27 — direct PostgREST update supplying an arbitrary version is
-- overridden by the server-side trigger: a client setting version = 999
-- alongside a graph change must end at old_version + 1, never 999
-- (private.bump_workflow_graph_version, added on review of 0012)
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_workflow_a uuid := (select id from test_ids where key = 'workflow_a');
  v_before int;
  v_after int;
begin
  perform pg_temp.act_as(v_member);
  select version into v_before from public.workflow_graphs where workflow_id = v_workflow_a;
  update public.workflow_graphs
  set graph = '{"nodes":[{"id":"n2","type":"destination","position":{"x":5,"y":5},"config":{}}],"edges":[]}'::jsonb,
      version = 999
  where workflow_id = v_workflow_a;
  select version into v_after from public.workflow_graphs where workflow_id = v_workflow_a;
  reset role;

  if v_after = v_before + 1 then
    insert into probe_results values (27, 'trigger overrides client-supplied version, forces old_version + 1', true);
  else
    insert into probe_results values (27, 'trigger overrides client-supplied version, forces old_version + 1', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (27, 'version-override trigger probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 28 — individual (personal-workspace) user can create a conversation
-- + own user message in their personal workspace (0013's owner_id branch)
-- =========================================================================
do $$
declare
  v_individual uuid := (select id from test_ids where key = 'individual');
  v_conv uuid;
  n_visible int;
begin
  perform pg_temp.act_as(v_individual);
  insert into public.conversations (owner_id, created_by, title)
  values (v_individual, v_individual, 'Personal probe conversation')
  returning id into v_conv;
  insert into public.messages (conversation_id, owner_id, role, content)
  values (v_conv, v_individual, 'user', 'how many rows?');
  select count(*) into n_visible from public.messages where conversation_id = v_conv;
  reset role;

  if n_visible = 1 then
    insert into probe_results values (28, 'individual can create/read their own personal conversation + message', true);
  else
    insert into probe_results values (28, 'individual can create/read their own personal conversation + message', false);
  end if;
  insert into test_ids values ('personal_conversation', v_conv);
exception when others then
  reset role;
  insert into probe_results values (28, 'personal conversation probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 29 — another individual (outsider) cannot see or insert into
-- someone else's personal conversation
-- =========================================================================
do $$
declare
  v_outsider uuid := (select id from test_ids where key = 'outsider');
  v_conv uuid := (select id from test_ids where key = 'personal_conversation');
  n_conv int;
  n_msg int;
  denied boolean := false;
begin
  perform pg_temp.act_as(v_outsider);
  select count(*) into n_conv from public.conversations where id = v_conv;
  select count(*) into n_msg from public.messages where conversation_id = v_conv;
  begin
    insert into public.messages (conversation_id, owner_id, role, content)
    values (v_conv, v_outsider, 'user', 'not my conversation');
    denied := false; -- insert succeeded — FAIL
  exception when insufficient_privilege or others then
    denied := true; -- expected
  end;
  reset role;

  if n_conv = 0 and n_msg = 0 and denied then
    insert into probe_results values (29, 'other individual cannot see or insert into someone else''s personal conversation', true);
  else
    insert into probe_results values (29, 'other individual cannot see or insert into someone else''s personal conversation', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (29, 'personal conversation isolation probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 30 — 0014_workflow_check_runs.sql: an authorized org member cannot
-- write a workflow_check_runs row directly via PostgREST insert — the audit-
-- log pattern means SELECT is the only client-grantable privilege on this
-- table; the only write path is record_check_run() (probes 31-32 below).
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_workflow_a uuid := (select id from test_ids where key = 'workflow_a');
  denied boolean := false;
begin
  perform pg_temp.act_as(v_member);
  begin
    insert into public.workflow_check_runs (workflow_id, graph_version, results)
    values (v_workflow_a, 1, '[{"id":"config","status":"pass","message":"forged"}]'::jsonb);
    denied := false; -- insert succeeded — FAIL
  exception when insufficient_privilege or others then
    denied := true; -- expected: no insert policy exists on this table
  end;
  reset role;

  if denied then
    insert into probe_results values (30, 'authorized member cannot directly INSERT into workflow_check_runs', true);
  else
    insert into probe_results values (30, 'authorized member cannot directly INSERT into workflow_check_runs', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (30, 'workflow_check_runs direct-insert probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 31 — record_check_run() raises for a caller who isn't authorized
-- for the target workflow (private.can_access_workflow re-checked inside
-- the function itself, not trusted from the caller)
-- =========================================================================
do $$
declare
  v_org_b_owner uuid := (select id from test_ids where key = 'org_b_owner');
  v_workflow_a uuid := (select id from test_ids where key = 'workflow_a');
  raised boolean := false;
begin
  perform pg_temp.act_as(v_org_b_owner);
  begin
    perform public.record_check_run(v_workflow_a, '[{"id":"config","status":"pass","message":"forged"}]'::jsonb);
    raised := false; -- call succeeded — FAIL
  exception when others then
    raised := true; -- expected
  end;
  reset role;

  if raised then
    insert into probe_results values (31, 'record_check_run raises for a non-member of the target workflow', true);
  else
    insert into probe_results values (31, 'record_check_run raises for a non-member of the target workflow', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (31, 'record_check_run non-member probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 32 — record_check_run() as an authorized member: the returned (and
-- persisted) row always carries the CURRENT workflow_graphs.version — there
-- is no p_graph_version parameter to supply a stale/forged one through.
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_workflow_a uuid := (select id from test_ids where key = 'workflow_a');
  v_current_version int;
  v_run public.workflow_check_runs;
  n_visible int;
begin
  select version into v_current_version from public.workflow_graphs where workflow_id = v_workflow_a;

  perform pg_temp.act_as(v_member);
  select * into v_run from public.record_check_run(v_workflow_a, '[{"id":"config","status":"pass","message":"ok"}]'::jsonb);
  select count(*) into n_visible from public.workflow_check_runs where id = v_run.id and workflow_id = v_workflow_a;
  reset role;

  if v_run.graph_version = v_current_version and n_visible = 1 then
    insert into probe_results values (32, 'record_check_run persists a row at the current graph_version, not a client-supplied one', true);
  else
    insert into probe_results values (32, 'record_check_run persists a row at the current graph_version, not a client-supplied one', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (32, 'record_check_run current-version probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 33 — org member can create a workflow-linked conversation (via the
-- new 0015 workflow_id column) and read it back; another member of the
-- same org can see it too (same org-wide visibility as probe 18 — the
-- new column is just a pointer, not a new access path)
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_admin uuid := (select id from test_ids where key = 'admin');
  v_org uuid := (select id from test_ids where key = 'org');
  v_workflow_a uuid := (select id from test_ids where key = 'workflow_a');
  v_conv uuid;
  n_self_sees int;
  n_admin_sees int;
begin
  perform pg_temp.act_as(v_member);
  insert into public.conversations (org_id, created_by, title, workflow_id)
  values (v_org, v_member, 'Workflow-linked probe conversation', v_workflow_a)
  returning id into v_conv;
  select count(*) into n_self_sees from public.conversations where id = v_conv and workflow_id = v_workflow_a;
  reset role;

  perform pg_temp.act_as(v_admin);
  select count(*) into n_admin_sees from public.conversations where id = v_conv and workflow_id = v_workflow_a;
  reset role;

  insert into test_ids values ('workflow_linked_conv', v_conv);

  if n_self_sees = 1 and n_admin_sees = 1 then
    insert into probe_results values (33, 'org member creates/reads a workflow-linked conversation; org-mate sees it too', true);
  else
    insert into probe_results values (33, 'org member creates/reads a workflow-linked conversation; org-mate sees it too', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (33, 'workflow-linked conversation probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 34 — cross-org: org B's owner cannot see the workflow-linked
-- conversation from probe 33 (proves workflow_id doesn't open a new
-- access path around the existing org/owner XOR policy)
-- =========================================================================
do $$
declare
  v_org_b_owner uuid := (select id from test_ids where key = 'org_b_owner');
  v_conv uuid := (select id from test_ids where key = 'workflow_linked_conv');
  n_visible int;
begin
  perform pg_temp.act_as(v_org_b_owner);
  select count(*) into n_visible from public.conversations where id = v_conv;
  reset role;

  if n_visible = 0 then
    insert into probe_results values (34, 'cross-org actor cannot see another org''s workflow-linked conversation', true);
  else
    insert into probe_results values (34, 'cross-org actor cannot see another org''s workflow-linked conversation', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (34, 'cross-org workflow-linked conversation probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probes 35-40 — 0016_write_grants.sql (Phase 6 Block 1: write_grants
-- hardened to RPC-only writes; create/confirm/revoke stay all-role per
-- the DECISION-C ruling in docs/decisions.md)
-- =========================================================================

-- Probe 35 — direct client INSERT/UPDATE on write_grants is denied for
-- every role, including admin/owner — the RPCs are the only write path.
do $$
declare
  v_admin uuid := (select id from test_ids where key = 'admin');
  v_owner uuid := (select id from test_ids where key = 'owner');
  v_conn  uuid := (select id from test_ids where key = 'connection_org');
  v_grant uuid := (select id from public.write_grants where connection_id = (select id from test_ids where key = 'connection_org') limit 1);
  insert_denied boolean := false;
  update_denied boolean := false;
begin
  perform pg_temp.act_as(v_admin);
  begin
    insert into public.write_grants (connection_id, granted_by_user_id, scope)
    values (v_conn, v_admin, '{"schemas":["direct-insert-attempt"]}'::jsonb);
  exception when others then
    insert_denied := true;
  end;
  reset role;

  perform pg_temp.act_as(v_owner);
  begin
    update public.write_grants set scope = '{"hijacked":true}'::jsonb where id = v_grant;
  exception when others then
    update_denied := true;
  end;
  reset role;

  if insert_denied and update_denied then
    insert into probe_results values (35, 'direct client INSERT/UPDATE on write_grants denied for every role, RPC-only', true);
  else
    insert into probe_results values (35, 'direct client INSERT/UPDATE on write_grants denied for every role, RPC-only', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (35, 'write_grants direct-write-denied probe (errored: ' || sqlerrm || ')', false);
end $$;

-- Probe 36 — full create -> confirm -> revoke lifecycle as a plain member
-- (all-role per the DECISION-C ruling, not admin/owner-gated) works
-- end-to-end, and each step is audit-logged.
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_org    uuid := (select id from test_ids where key = 'org');
  v_conn   uuid := (select id from test_ids where key = 'connection_org');
  v_grant  public.write_grants;
  n_audit_events int;
  v_prior_max_cred_version int;
  lifecycle_ok boolean := false;
begin
  -- 0018_write_grant_cred_version_bump.sql made cred_version
  -- connection-relative (max(existing cred_version on this connection) + 1),
  -- not a fixed "1 on first confirm" — probe 16 above already plants an
  -- unconfirmed grant on this same connection_org fixture (for its own,
  -- unrelated RLS-visibility purpose), which legitimately participates in
  -- that max(). Capture the pre-confirm baseline here instead of assuming
  -- this is the first grant ever created on the connection, so this probe
  -- asserts 0018's real "strictly increasing relative to prior grants"
  -- contract rather than a test-ordering-dependent literal value.
  select coalesce(max(cred_version), 0) into v_prior_max_cred_version
  from public.write_grants
  where connection_id = v_conn;

  perform pg_temp.act_as(v_member);

  select * into v_grant from public.create_write_grant(v_conn, '{"schemas":["reporting"]}'::jsonb);
  select * into v_grant from public.confirm_write_grant(v_grant.id, 'vault:write-cred-probe-36', 'nia_write_probe_36');
  select * into v_grant from public.revoke_write_grant(v_grant.id);

  reset role;

  -- audit_log's own RLS (audit_log_select_admins_or_self, 0007) only
  -- exposes org-scoped rows to admins — a plain member correctly can't
  -- SELECT them. That's a *different* assertion than "did the RPC log the
  -- event," which is what this probe checks, so the count runs after
  -- reset role (superuser, bypasses RLS) rather than while still
  -- act_as(v_member) — matching how other probes in this file separate
  -- "data exists" checks from RLS-visibility checks.
  select count(*) into n_audit_events
  from public.audit_log
  where org_id = v_org
    and action in ('write_grant.created', 'write_grant.confirmed', 'write_grant.revoked')
    and detail->>'grantId' = v_grant.id::text;

  lifecycle_ok := v_grant.confirmed_at is not null
    and v_grant.revoked_at is not null
    and v_grant.write_credential_vault_ref = 'vault:write-cred-probe-36'
    and v_grant.cred_version = v_prior_max_cred_version + 1
    and n_audit_events = 3;

  if lifecycle_ok then
    insert into probe_results values (36, 'plain member: create/confirm/revoke write-grant lifecycle works, audit-logged 3x', true);
  else
    insert into probe_results values (36, 'plain member: create/confirm/revoke write-grant lifecycle works, audit-logged 3x', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (36, 'write-grant lifecycle probe (errored: ' || sqlerrm || ')', false);
end $$;

-- Probe 37 — an outsider (no access to the connection's org) cannot call
-- create_write_grant against it.
do $$
declare
  v_outsider uuid := (select id from test_ids where key = 'outsider');
  v_conn     uuid := (select id from test_ids where key = 'connection_org');
  denied boolean := false;
begin
  perform pg_temp.act_as(v_outsider);
  begin
    perform public.create_write_grant(v_conn, '{"schemas":["sales"]}'::jsonb);
  exception when others then
    denied := true;
  end;
  reset role;

  if denied then
    insert into probe_results values (37, 'create_write_grant denied for a user with no access to the connection', true);
  else
    insert into probe_results values (37, 'create_write_grant denied for a user with no access to the connection', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (37, 'create_write_grant outsider-denied probe (errored: ' || sqlerrm || ')', false);
end $$;

-- Probe 38 — confirm_write_grant raises on an already-confirmed or
-- already-revoked grant; revoke_write_grant raises on an already-revoked
-- grant. No silent double-confirm/double-revoke.
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_conn   uuid := (select id from test_ids where key = 'connection_org');
  v_grant  public.write_grants;
  double_confirm_denied boolean := false;
  double_revoke_denied boolean := false;
begin
  perform pg_temp.act_as(v_member);

  select * into v_grant from public.create_write_grant(v_conn, '{"schemas":["ops"]}'::jsonb);
  select * into v_grant from public.confirm_write_grant(v_grant.id, 'vault:write-cred-probe-38', 'nia_write_probe_38');

  begin
    perform public.confirm_write_grant(v_grant.id, 'vault:write-cred-probe-38-again', 'nia_write_probe_38');
  exception when others then
    double_confirm_denied := true;
  end;

  perform public.revoke_write_grant(v_grant.id);

  begin
    perform public.revoke_write_grant(v_grant.id);
  exception when others then
    double_revoke_denied := true;
  end;

  reset role;

  if double_confirm_denied and double_revoke_denied then
    insert into probe_results values (38, 'confirm/revoke are not idempotent — re-confirm and re-revoke both raise', true);
  else
    insert into probe_results values (38, 'confirm/revoke are not idempotent — re-confirm and re-revoke both raise', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (38, 'confirm/revoke non-idempotency probe (errored: ' || sqlerrm || ')', false);
end $$;

-- Probe 39 — a revoked grant fails an active-grant lookup (the shape
-- Block 2's checkGrants/connector write path will filter on).
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_conn   uuid := (select id from test_ids where key = 'connection_org');
  v_grant  public.write_grants;
  n_active int;
begin
  perform pg_temp.act_as(v_member);

  select * into v_grant from public.create_write_grant(v_conn, '{"schemas":["finance"]}'::jsonb);
  select * into v_grant from public.confirm_write_grant(v_grant.id, 'vault:write-cred-probe-39', 'nia_write_probe_39');
  select * into v_grant from public.revoke_write_grant(v_grant.id);

  select count(*) into n_active
  from public.write_grants
  where id = v_grant.id and confirmed_at is not null and revoked_at is null;

  reset role;

  if n_active = 0 then
    insert into probe_results values (39, 'revoked grant fails an active-grant (confirmed, not revoked) lookup', true);
  else
    insert into probe_results values (39, 'revoked grant fails an active-grant (confirmed, not revoked) lookup', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (39, 'revoked-grant active-lookup probe (errored: ' || sqlerrm || ')', false);
end $$;

-- Probe 40 — personal-workspace owner can run the full lifecycle on their
-- own connection; another individual (no access to that connection) is
-- denied by create_write_grant the same way an org outsider is (probe 37).
do $$
declare
  v_individual uuid := (select id from test_ids where key = 'individual');
  v_outsider   uuid := (select id from test_ids where key = 'outsider');
  v_conn       uuid;
  v_grant      public.write_grants;
  other_denied boolean := false;
  lifecycle_ok boolean := false;
begin
  perform pg_temp.act_as(v_individual);
  insert into public.connections (owner_id, connector_id, handle, display_name, owner_user_id, vault_secret_ref)
  values (v_individual, 'mysql', '@mysql-personal-probe', 'Personal Probe DB', v_individual, 'vault:personal-probe-ref')
  returning id into v_conn;

  select * into v_grant from public.create_write_grant(v_conn, '{"schemas":["personal"]}'::jsonb);
  select * into v_grant from public.confirm_write_grant(v_grant.id, 'vault:write-cred-probe-40', 'nia_write_probe_40');
  select * into v_grant from public.revoke_write_grant(v_grant.id);
  reset role;

  lifecycle_ok := v_grant.confirmed_at is not null and v_grant.revoked_at is not null;

  perform pg_temp.act_as(v_outsider);
  begin
    perform public.create_write_grant(v_conn, '{"schemas":["personal"]}'::jsonb);
  exception when others then
    other_denied := true;
  end;
  reset role;

  if lifecycle_ok and other_denied then
    insert into probe_results values (40, 'personal-workspace owner: full write-grant lifecycle works, isolated from other individuals', true);
  else
    insert into probe_results values (40, 'personal-workspace owner: full write-grant lifecycle works, isolated from other individuals', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (40, 'personal write-grant lifecycle probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probes 41-42 — 0019_copilot_plan_audit.sql (Phase 7 Session 2: Copilot
-- Apply's mandatory audit event). log_plan_applied() reuses
-- private.can_access_workflow() rather than a new authorization check —
-- these probes prove that reuse actually gates the RPC, the same way
-- probes 33/34 proved workflow_id-linking doesn't open a new access path.
-- =========================================================================

-- Probe 41 — an org member with access to workflow_a can call
-- log_plan_applied(); the resulting audit_log row carries the org's id,
-- the calling actor, and the expected action string.
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_org uuid := (select id from test_ids where key = 'org');
  v_workflow_a uuid := (select id from test_ids where key = 'workflow_a');
  n_rows int;
begin
  perform pg_temp.act_as(v_member);
  perform public.log_plan_applied(v_workflow_a, 'Add a MySQL source', 'add a source for the orders table', array[gen_random_uuid()], 2);
  reset role;

  select count(*) into n_rows
  from public.audit_log
  where org_id = v_org and actor = v_member and action = 'copilot_plan.applied'
    and (detail ->> 'workflowId')::uuid = v_workflow_a;

  if n_rows = 1 then
    insert into probe_results values (41, 'org member: log_plan_applied writes exactly one audit_log row with expected org/actor/action/detail', true);
  else
    insert into probe_results values (41, 'org member: log_plan_applied writes exactly one audit_log row with expected org/actor/action/detail', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (41, 'log_plan_applied org-member probe (errored: ' || sqlerrm || ')', false);
end $$;

-- Probe 42 — cross-org: org B's owner (no access to workflow_a) is denied
-- by log_plan_applied, and no audit_log row is written on their behalf.
do $$
declare
  v_org_b_owner uuid := (select id from test_ids where key = 'org_b_owner');
  v_workflow_a uuid := (select id from test_ids where key = 'workflow_a');
  denied boolean := false;
  n_rows int;
begin
  perform pg_temp.act_as(v_org_b_owner);
  begin
    perform public.log_plan_applied(v_workflow_a, 'Add a MySQL source', 'add a source for the orders table', array[gen_random_uuid()], 3);
  exception when others then
    denied := true;
  end;
  reset role;

  select count(*) into n_rows from public.audit_log where actor = v_org_b_owner and action = 'copilot_plan.applied';

  if denied and n_rows = 0 then
    insert into probe_results values (42, 'cross-org actor is denied by log_plan_applied; no audit_log row written', true);
  else
    insert into probe_results values (42, 'cross-org actor is denied by log_plan_applied; no audit_log row written', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (42, 'log_plan_applied cross-org-denied probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 43 — 0020_source_profiles.sql (Phase 10 profiler cache): cross-org
-- isolation. source_profiles has no own org_id/owner_id — scope is derived
-- entirely via connection_id's parent connection (same shape as
-- write_grants, probe 16). This is the deferred Phase 13 gate check named
-- in TODO.md ("cross-org check that a user from another org sees 0
-- source_profiles rows").
-- =========================================================================

-- Probe 43 — org B's owner (no access to org A's connection) sees 0 rows
-- for a source_profiles row scoped to org A's connection; org A's own
-- member sees it.
do $$
declare
  v_conn uuid := (select id from test_ids where key = 'connection_org');
  v_member uuid := (select id from test_ids where key = 'member');
  v_org_b_owner uuid := (select id from test_ids where key = 'org_b_owner');
  v_profile uuid;
  n_member_sees int;
  n_org_b_sees int;
begin
  -- Fixture inserted as postgres (bypasses RLS) — only the SELECT-side
  -- isolation is under test here, mirroring probe 11's pattern.
  insert into public.source_profiles
    (connection_id, entity_namespace, entity_name, schema_hash, sample_method, sample_size, stats, signature, profile_hash, profiled_at, profiled_by_user_id)
  values
    (v_conn, 'public', 'probe_entity', 'schemahash-probe', 'full-table', 10, '[]'::jsonb, '[]'::jsonb, 'profilehash-probe', now(), v_member)
  returning id into v_profile;

  perform pg_temp.act_as(v_member);
  select count(*) into n_member_sees from public.source_profiles where id = v_profile;
  reset role;

  perform pg_temp.act_as(v_org_b_owner);
  select count(*) into n_org_b_sees from public.source_profiles where id = v_profile;
  reset role;

  if n_member_sees = 1 and n_org_b_sees = 0 then
    insert into probe_results values (43, 'cross-org: org B owner sees 0 rows of org A''s source_profiles; org A member sees it', true);
  else
    insert into probe_results values (43, 'cross-org: org B owner sees 0 rows of org A''s source_profiles; org A member sees it', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (43, 'source_profiles cross-org isolation probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probes 44-46 — 0027_connection_lifecycle_audit.sql (merge/delete secret
-- RPCs + generic connection-audit RPC)
-- =========================================================================

-- Probe 44 — log_connection_audit is callable by authenticated, not by
-- anon/public (privilege check only — no anon-role probe exists elsewhere
-- in this file to mirror for an actual call-attempt).
--
-- merge_connector_secret/delete_connector_secret (0027) were dropped in
-- migration 0036 as dead code (see that migration's header) — they had
-- zero real callers left after the envelope-encryption secret-store
-- migration, and their privilege/behavior checks were removed from this
-- probe (formerly probe 44) and probe 45 (removed entirely) accordingly.
do $$
declare
  ok boolean;
begin
  ok := has_function_privilege('authenticated', 'public.log_connection_audit(uuid, text, jsonb, uuid)', 'execute')
    and not has_function_privilege('anon', 'public.log_connection_audit(uuid, text, jsonb, uuid)', 'execute');

  insert into probe_results values (44, 'log_connection_audit: granted to authenticated, not anon', ok);
exception when others then
  insert into probe_results values (44, 'connection-lifecycle RPC privilege probe (errored: ' || sqlerrm || ')', false);
end $$;

-- Probe 46 — log_connection_audit: an authenticated caller's action is
-- always attributed to auth.uid(), ignoring any p_actor_user_id passed
-- (same asymmetric-actor rule as log_execution_audit, 0009); detail is
-- stored verbatim and scoped to the connection's own org.
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_org uuid := (select id from test_ids where key = 'org');
  v_conn uuid := (select id from test_ids where key = 'connection_org');
  v_bogus_actor uuid := gen_random_uuid();
  n_correct int;
  n_bogus int;
begin
  perform pg_temp.act_as(v_member);
  perform public.log_connection_audit(v_conn, 'connection.updated', '{"changedFields":["host"]}'::jsonb, v_bogus_actor);
  reset role;

  select count(*) into n_correct from public.audit_log
  where org_id = v_org and action = 'connection.updated' and actor = v_member
    and detail = '{"changedFields":["host"]}'::jsonb;
  select count(*) into n_bogus from public.audit_log
  where org_id = v_org and action = 'connection.updated' and actor = v_bogus_actor;

  if n_correct = 1 and n_bogus = 0 then
    insert into probe_results values (46, 'log_connection_audit: authenticated caller always attributed to auth.uid(), detail stored verbatim, org-scoped', true);
  else
    insert into probe_results values (46, 'log_connection_audit: authenticated caller always attributed to auth.uid(), detail stored verbatim, org-scoped', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (46, 'log_connection_audit probe (errored: ' || sqlerrm || ')', false);
end $$;

-- Probe 47 — Item 6.1 (fix-chain plan): connections_scope_display_name_unique_idx
-- (0029_connection_name_unique.sql) rejects a case-insensitive duplicate
-- display_name within the same scope (org or personal), but allows the same
-- name to be reused across different scopes (a different org, or a personal
-- workspace). Reuses probe 14's still-live `connection_org` fixture, whose
-- display_name was renamed to 'Renamed by member' by that probe's own
-- update — so the same-scope collision check below targets that exact
-- current value (case-flipped), not the fixture's original 'Probe DB' name.
do $$
declare
  v_owner       uuid := (select id from test_ids where key = 'owner');
  v_org         uuid := (select id from test_ids where key = 'org');
  v_org_b_owner uuid := (select id from test_ids where key = 'org_b_owner');
  v_org_b       uuid := (select id from test_ids where key = 'org_b');
  v_individual  uuid := (select id from test_ids where key = 'individual');
  same_org_rejected boolean := false;
  cross_org_ok boolean := false;
  personal_ok boolean := false;
begin
  -- Same org, case-flipped duplicate of the existing connection_org row's
  -- current name ('Renamed by member') — must be rejected.
  perform pg_temp.act_as(v_owner);
  begin
    insert into public.connections (org_id, connector_id, handle, display_name, owner_user_id, vault_secret_ref)
    values (v_org, 'mysql', '@dup-name-probe', 'RENAMED BY MEMBER', v_owner, 'vault:probe-dup');
  exception when others then
    same_org_rejected := true;
  end;
  reset role;

  -- Same exact name, but a different org — must be allowed.
  perform pg_temp.act_as(v_org_b_owner);
  begin
    insert into public.connections (org_id, connector_id, handle, display_name, owner_user_id, vault_secret_ref)
    values (v_org_b, 'mysql', '@dup-name-probe-b', 'Renamed by member', v_org_b_owner, 'vault:probe-dup-b');
    cross_org_ok := true;
  exception when others then
    cross_org_ok := false;
  end;
  reset role;

  -- Same exact name, but a personal workspace — must be allowed.
  perform pg_temp.act_as(v_individual);
  begin
    insert into public.connections (owner_id, connector_id, handle, display_name, owner_user_id, vault_secret_ref)
    values (v_individual, 'mysql', '@dup-name-probe-p', 'Renamed by member', v_individual, 'vault:probe-dup-p');
    personal_ok := true;
  exception when others then
    personal_ok := false;
  end;
  reset role;

  if same_org_rejected and cross_org_ok and personal_ok then
    insert into probe_results values (47, 'connections_scope_display_name_unique_idx: rejects a case-insensitive duplicate name within the same scope, allows it across orgs/personal scopes', true);
  else
    insert into probe_results values (47, 'connections_scope_display_name_unique_idx: rejects a case-insensitive duplicate name within the same scope, allows it across orgs/personal scopes', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (47, 'connections display_name uniqueness probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 48 — 0031_copilot_agent.sql (Copilot agent Part 3: confirm/consume
-- pending actions). apps/api/src/copilot/pendingActions.test.ts
-- reimplements consume_pending_action/confirm_pending_action's semantics in
-- a JS fake for fast unit coverage — this probe exercises the real SQL
-- functions directly, so nothing only proves the fake matches itself.
-- =========================================================================

-- Probe 48 — consume_pending_action: a correct, matching args_hash consumes
-- exactly once; a mismatched hash is rejected; a replay of an already-
-- consumed row is rejected; and a confirmed-but-expired row is rejected
-- even with a matching hash.
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_workflow_a uuid := (select id from test_ids where key = 'workflow_a');
  v_pending uuid;
  v_pending_expired uuid;
  v_row public.copilot_pending_actions;
  mismatch_rejected boolean := false;
  correct_consumed boolean := false;
  replay_rejected boolean := false;
  expired_rejected boolean := false;
begin
  -- Fixture inserted as postgres (bypasses RLS) — created_by has no
  -- request.jwt.claims to default from outside a client session.
  insert into public.copilot_pending_actions (workflow_id, tool, args_hash, args, created_by)
  values (v_workflow_a, 'start_run', 'probe-hash-correct', '{"workflowId":"probe"}'::jsonb, v_member)
  returning id into v_pending;

  perform pg_temp.act_as(v_member);
  perform public.confirm_pending_action(v_pending);

  -- Confirmed and not expired, but the wrong hash — must be rejected, and
  -- must not consume the row.
  begin
    perform public.consume_pending_action(v_pending, 'start_run', 'probe-hash-wrong');
  exception when others then
    mismatch_rejected := true;
  end;

  -- The correct hash — must succeed exactly once.
  select * into v_row from public.consume_pending_action(v_pending, 'start_run', 'probe-hash-correct');
  correct_consumed := v_row.consumed_at is not null;

  -- Replay: the same, now-already-consumed pending action, same correct
  -- hash — must be rejected.
  begin
    perform public.consume_pending_action(v_pending, 'start_run', 'probe-hash-correct');
  exception when others then
    replay_rejected := true;
  end;
  reset role;

  -- Expired: confirmed, correct hash, but past expires_at — must be
  -- rejected. Direct-inserted already-confirmed (bypassing RLS as
  -- postgres), since confirm_pending_action itself refuses to confirm an
  -- already-expired row, so the probe could never reach consume otherwise.
  insert into public.copilot_pending_actions (workflow_id, tool, args_hash, args, created_by, confirmed_at, confirmed_by, expires_at)
  values (v_workflow_a, 'start_run', 'probe-hash-expired', '{"workflowId":"probe"}'::jsonb, v_member, now() - interval '5 minutes', v_member, now() - interval '1 minute')
  returning id into v_pending_expired;

  perform pg_temp.act_as(v_member);
  begin
    perform public.consume_pending_action(v_pending_expired, 'start_run', 'probe-hash-expired');
  exception when others then
    expired_rejected := true;
  end;
  reset role;

  if mismatch_rejected and correct_consumed and replay_rejected and expired_rejected then
    insert into probe_results values (48, 'consume_pending_action: matching hash consumes exactly once; mismatched hash, replay, and expiry are all rejected', true);
  else
    insert into probe_results values (48, 'consume_pending_action: matching hash consumes exactly once; mismatched hash, replay, and expiry are all rejected', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (48, 'consume_pending_action probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 49 — 0032_nia_secrets.sql (Vault replacement: envelope-encrypted
-- credential storage)
-- =========================================================================

-- Probe 49 — nia_secrets RLS: an org member can insert/select/delete a row
-- scoped to their own org; an outsider (not a member) can neither select
-- nor delete it, and cannot insert a row claiming that org's org_id.
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_outsider uuid := (select id from test_ids where key = 'outsider');
  v_org uuid := (select id from test_ids where key = 'org');
  v_secret uuid;
  n_rows int;
  member_can_select boolean := false;
  member_can_delete boolean := false;
  outsider_select_blocked boolean := false;
  outsider_delete_blocked boolean := false;
  outsider_insert_blocked boolean := false;
begin
  perform pg_temp.act_as(v_member);
  insert into public.nia_secrets (org_id, ciphertext, encrypted_data_key, iv, auth_tag)
  values (v_org, 'ct-probe-49', 'edk-probe-49', 'iv-probe-49', 'tag-probe-49')
  returning id into v_secret;

  member_can_select := exists (select 1 from public.nia_secrets where id = v_secret);
  reset role;

  perform pg_temp.act_as(v_outsider);
  outsider_select_blocked := not exists (select 1 from public.nia_secrets where id = v_secret);
  begin
    insert into public.nia_secrets (org_id, ciphertext, encrypted_data_key, iv, auth_tag)
    values (v_org, 'ct-outsider', 'edk-outsider', 'iv-outsider', 'tag-outsider');
  exception when others then
    outsider_insert_blocked := true;
  end;
  delete from public.nia_secrets where id = v_secret;
  get diagnostics n_rows = row_count;
  outsider_delete_blocked := (n_rows = 0); -- RLS silently filters, not an error — must affect 0 rows
  reset role;

  perform pg_temp.act_as(v_member);
  delete from public.nia_secrets where id = v_secret;
  get diagnostics n_rows = row_count;
  member_can_delete := (n_rows = 1);
  reset role;

  if member_can_select and member_can_delete and outsider_select_blocked and outsider_delete_blocked and outsider_insert_blocked then
    insert into probe_results values (49, 'nia_secrets RLS: org member can insert/select/delete own org row; outsider can neither read nor delete it nor insert into that org', true);
  else
    insert into probe_results values (49, 'nia_secrets RLS: org member can insert/select/delete own org row; outsider can neither read nor delete it nor insert into that org', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (49, 'nia_secrets RLS probe (errored: ' || sqlerrm || ')', false);
end $$;

-- Probe 50 (decrypt_connector_secret_for_edit — the Vault-era, authenticated-
-- callable equivalent of resolve_connector_secret, used only by the
-- pre-nia_secrets update-path) was removed along with that RPC once every
-- live ref was confirmed backfilled into nia_secrets — see
-- docs/decisions.md's Vault-removal entry. nia_secrets's own RLS (the only
-- access path left) is already covered by Probe 49 above.

-- =========================================================================
-- Probe 51 — 0039_platform_staff.sql (Console v1 Step 2: platform_staff has
-- zero policies and no grant to authenticated/anon at all — confirm both
-- SELECT and INSERT hard-fail with permission denied for an ordinary
-- authenticated user, not just an RLS-filtered empty result, since no
-- GRANT statement for this table was ever issued to that role.)
-- =========================================================================
do $$
declare
  v_outsider uuid := (select id from test_ids where key = 'outsider');
  select_denied boolean := false;
  insert_denied boolean := false;
begin
  perform pg_temp.act_as(v_outsider);
  begin
    perform 1 from public.platform_staff limit 1;
  exception when insufficient_privilege then
    select_denied := true;
  end;
  begin
    insert into public.platform_staff (user_id, granted_by) values (v_outsider, v_outsider);
  exception when insufficient_privilege then
    insert_denied := true;
  end;
  reset role;

  if select_denied and insert_denied then
    insert into probe_results values (51, 'platform_staff: authenticated has no grant at all — SELECT and INSERT both raise permission denied, not just an RLS-empty result', true);
  else
    insert into probe_results values (51, 'platform_staff: authenticated has no grant at all — SELECT and INSERT both raise permission denied, not just an RLS-empty result', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (51, 'platform_staff RLS probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 52 — 0040_staff_audit_log.sql (Console v1 Step 3: staff_audit_log
-- has zero policies and no grant to authenticated/anon at all — confirm
-- both SELECT and INSERT hard-fail with permission denied for an ordinary
-- authenticated user, same posture as platform_staff, Probe 51.)
-- =========================================================================
do $$
declare
  v_outsider uuid := (select id from test_ids where key = 'outsider');
  select_denied boolean := false;
  insert_denied boolean := false;
begin
  perform pg_temp.act_as(v_outsider);
  begin
    perform 1 from public.staff_audit_log limit 1;
  exception when insufficient_privilege then
    select_denied := true;
  end;
  begin
    insert into public.staff_audit_log (staff_user_id, action) values (v_outsider, 'probe.tamper');
  exception when insufficient_privilege then
    insert_denied := true;
  end;
  reset role;

  if select_denied and insert_denied then
    insert into probe_results values (52, 'staff_audit_log: authenticated has no grant at all — SELECT and INSERT both raise permission denied, not just an RLS-empty result', true);
  else
    insert into probe_results values (52, 'staff_audit_log: authenticated has no grant at all — SELECT and INSERT both raise permission denied, not just an RLS-empty result', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (52, 'staff_audit_log authenticated-grant probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 53 — 0040_staff_audit_log.sql (Console v1 Step 3: append-only
-- enforced by trigger, not just RLS — service_role has BYPASSRLS and full
-- default-privilege UPDATE/DELETE grants, so RLS alone would not stop it.
-- Confirm UPDATE, DELETE, and TRUNCATE are all rejected even for
-- service_role: UPDATE/DELETE by the row-level append-only trigger,
-- TRUNCATE by the revoked TRUNCATE privilege (checked first, so this
-- raises a plain permission-denied rather than the statement-level
-- trigger's own message — both are valid, redundant defenses).
-- =========================================================================
do $$
declare
  v_outsider uuid := (select id from test_ids where key = 'outsider');
  v_row_id uuid;
  update_rejected boolean := false;
  delete_rejected boolean := false;
  truncate_rejected boolean := false;
begin
  insert into public.staff_audit_log (staff_user_id, action, detail)
  values (v_outsider, 'probe.fixture', '{}'::jsonb)
  returning id into v_row_id;

  set local role service_role;
  begin
    update public.staff_audit_log set action = 'tampered' where id = v_row_id;
  exception when others then
    if sqlerrm like '%append-only%' then
      update_rejected := true;
    end if;
  end;
  begin
    delete from public.staff_audit_log where id = v_row_id;
  exception when others then
    if sqlerrm like '%append-only%' then
      delete_rejected := true;
    end if;
  end;
  begin
    truncate public.staff_audit_log;
  exception when others then
    if sqlerrm like '%append-only%' or sqlerrm like '%permission denied%' then
      truncate_rejected := true;
    end if;
  end;
  reset role;

  if update_rejected and delete_rejected and truncate_rejected then
    insert into probe_results values (53, 'staff_audit_log append-only: UPDATE, DELETE, and TRUNCATE all rejected for service_role', true);
  else
    insert into probe_results values (53, 'staff_audit_log append-only: UPDATE, DELETE, and TRUNCATE all rejected for service_role', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (53, 'staff_audit_log append-only probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 54 — 0042_org_plan.sql + 0044_org_plan_member_select.sql (Console
-- v1 Step 7, then a "Slice 2 follow-ups" narrowing: org_plan shipped with
-- zero policies/grants at all in 0042 — same posture as platform_staff/
-- staff_audit_log, Probes 51-52 — then 0044 added exactly one SELECT grant
-- + a member-scoped SELECT policy, nothing else. An outsider's SELECT is
-- now RLS-filtered to zero rows (the grant exists, so it's no longer a
-- statement-level permission error) — INSERT still hard-fails with
-- permission denied for anyone, since no INSERT grant was added.)
-- =========================================================================
do $$
declare
  v_outsider uuid := (select id from test_ids where key = 'outsider');
  v_org      uuid := (select id from test_ids where key = 'org');
  n_visible int;
  insert_denied boolean := false;
begin
  perform pg_temp.act_as(v_outsider);

  select count(*) into n_visible from public.org_plan;

  begin
    insert into public.org_plan (org_id, plan_tier, workflow_limit) values (v_org, 'Pro', 25);
  exception when insufficient_privilege then
    insert_denied := true;
  end;
  reset role;

  if n_visible = 0 and insert_denied then
    insert into probe_results values (54, 'org_plan: outsider SELECT is RLS-filtered to zero rows (not a grant error); INSERT still raises permission denied', true);
  else
    insert into probe_results values (54, 'org_plan: outsider SELECT is RLS-filtered to zero rows (not a grant error); INSERT still raises permission denied', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (54, 'org_plan RLS probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 55 — 0044_org_plan_member_select.sql: a member of the org CAN read
-- their own org's org_plan row (correct plan_id/plan_tier values, not just
-- "some row"). Stale-expectations fix: this org is created fresh by this
-- very script, so 0050_org_plan_overrides.sql's create-org trigger (private.
-- set_default_org_plan, redefined again by 0050) is what actually fires for
-- it — 'free'/'Free', not 0043's original 'Pro' default that only ever
-- applied before the plans-catalog migrations (0049-0051) shipped. See
-- docs/decisions.md ("org_plan default: Pro/25 -> Free/inherited") for the
-- full history of that model change.
-- Also restores the workflow_limit/workflow_limit_set assertion the prior
-- fix had dropped: that check IS still real, current behavior (a freshly
-- created org's org_plan row inherits from the 'free' plan rather than
-- getting an explicit override), it just can't be read live here because
-- the root fixture's project/workflow-limit-lifting override (needed before
-- probe 11) overwrites those same two columns on this same org long before
-- this probe runs. probe55_baseline (captured in the root fixture,
-- immediately before that override) holds the pre-override values instead.
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_org    uuid := (select id from test_ids where key = 'org');
  v_plan_id text;
  v_plan_tier text;
  v_baseline_limit int;
  v_baseline_limit_set boolean;
begin
  perform pg_temp.act_as(v_member);
  select plan_id, plan_tier
  into v_plan_id, v_plan_tier
  from public.org_plan where org_id = v_org;
  reset role;

  select workflow_limit, workflow_limit_set
  into v_baseline_limit, v_baseline_limit_set
  from probe55_baseline;

  if v_plan_id = 'free' and v_plan_tier = 'Free'
     and v_baseline_limit_set = false and v_baseline_limit is null then
    insert into probe_results values (55, 'org_plan: a member can read their own org''s plan row (0050''s Free/inherited default for new orgs)', true);
  else
    insert into probe_results values (55, 'org_plan: a member can read their own org''s plan row (0050''s Free/inherited default for new orgs)', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (55, 'org_plan member-can-read-own-org probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 56 — 0044_org_plan_member_select.sql: a member of org A CANNOT
-- read org B's org_plan row (private.is_member(org_id) actually scopes by
-- org, not just "any org the caller happens to be a member of somewhere").
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_org_b  uuid := (select id from test_ids where key = 'org_b');
  n_visible int;
begin
  perform pg_temp.act_as(v_member);
  select count(*) into n_visible from public.org_plan where org_id = v_org_b;
  reset role;

  if n_visible = 0 then
    insert into probe_results values (56, 'org_plan: a member of org A cannot read org B''s plan row', true);
  else
    insert into probe_results values (56, 'org_plan: a member of org A cannot read org B''s plan row', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (56, 'org_plan member-cannot-read-other-org probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 57 — 0044_org_plan_member_select.sql only ever added a SELECT
-- grant/policy — confirm an org member (not just an outsider) still cannot
-- INSERT, UPDATE, or DELETE org_plan at all; it remains write-only via
-- service_role/postgres (today: only the 0043 trigger).
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_org    uuid := (select id from test_ids where key = 'org');
  insert_denied boolean := false;
  update_denied boolean := false;
  delete_denied boolean := false;
begin
  perform pg_temp.act_as(v_member);
  begin
    insert into public.org_plan (org_id, plan_tier, workflow_limit) values (v_org, 'Pro', 25);
  exception when insufficient_privilege then
    insert_denied := true;
  end;
  begin
    update public.org_plan set workflow_limit = 999 where org_id = v_org;
  exception when insufficient_privilege then
    update_denied := true;
  end;
  begin
    delete from public.org_plan where org_id = v_org;
  exception when insufficient_privilege then
    delete_denied := true;
  end;
  reset role;

  if insert_denied and update_denied and delete_denied then
    insert into probe_results values (57, 'org_plan: an org member still cannot INSERT/UPDATE/DELETE (SELECT-only grant)', true);
  else
    insert into probe_results values (57, 'org_plan: an org member still cannot INSERT/UPDATE/DELETE (SELECT-only grant)', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (57, 'org_plan member-cannot-write probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Fixture for probes 66-73 — 0046_org_suspension.sql: a pre-existing
-- project/workflow in the main org, created (as postgres, bypassing RLS —
-- only the suspension-time behavior is under test, not the insert-side
-- policies themselves, already covered by probes 59/62) before the org is
-- ever suspended, so probes 60/61/62 have a real row to try to touch.
-- =========================================================================
do $$
declare
  v_org uuid := (select id from test_ids where key = 'org');
  v_member uuid := (select id from test_ids where key = 'member');
  v_project uuid;
  v_workflow uuid;
begin
  insert into public.projects (org_id, name, created_by)
  values (v_org, 'Suspension probe project', v_member)
  returning id into v_project;

  insert into public.workflows (project_id, org_id, name, created_by)
  values (v_project, v_org, 'Suspension probe workflow', v_member)
  returning id into v_workflow;

  insert into test_ids values ('suspension_project', v_project), ('suspension_workflow', v_workflow);
end $$;

-- =========================================================================
-- Probe 66 — staff suspends the main org (direct update, bypassing RLS —
-- simulates POST /console/orgs/:orgId/suspend's withServiceRole write, not
-- under test here); private.is_org_suspended() reflects it immediately.
-- =========================================================================
do $$
declare
  v_org uuid := (select id from test_ids where key = 'org');
  v_suspended boolean;
begin
  update public.organizations
  set suspended_at = now(), suspended_reason = 'RLS probe suspension'
  where id = v_org;

  select private.is_org_suspended(v_org) into v_suspended;

  if v_suspended then
    insert into probe_results values (66, 'is_org_suspended() reflects a freshly suspended org', true);
  else
    insert into probe_results values (66, 'is_org_suspended() reflects a freshly suspended org', false);
  end if;
exception when others then
  insert into probe_results values (66, 'suspend-org fixture probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 67 — suspended org: a member cannot INSERT a new project
-- (projects_insert_members' with-check now includes not is_org_suspended)
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_org uuid := (select id from test_ids where key = 'org');
  insert_denied boolean := false;
begin
  perform pg_temp.act_as(v_member);
  begin
    insert into public.projects (org_id, name, created_by) values (v_org, 'Should be blocked', v_member);
  exception when insufficient_privilege then
    insert_denied := true;
  end;
  reset role;

  if insert_denied then
    insert into probe_results values (67, 'suspended org: member cannot INSERT a new project', true);
  else
    insert into probe_results values (67, 'suspended org: member cannot INSERT a new project', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (67, 'suspended-org project insert probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 68 — suspended org: a member cannot UPDATE (e.g. rename) an
-- existing project (projects_update_members' using/with-check both amended)
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_project uuid := (select id from test_ids where key = 'suspension_project');
  n_updated int;
begin
  perform pg_temp.act_as(v_member);
  update public.projects set name = 'Should stay blocked' where id = v_project;
  get diagnostics n_updated = row_count;
  reset role;

  if n_updated = 0 then
    insert into probe_results values (68, 'suspended org: member cannot UPDATE an existing project', true);
  else
    insert into probe_results values (68, 'suspended org: member cannot UPDATE an existing project', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (68, 'suspended-org project update probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 69 — suspended org: a member cannot DELETE an existing project
-- (projects_delete_members' using clause amended)
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_project uuid := (select id from test_ids where key = 'suspension_project');
  n_deleted int;
begin
  perform pg_temp.act_as(v_member);
  delete from public.projects where id = v_project;
  get diagnostics n_deleted = row_count;
  reset role;

  if n_deleted = 0 then
    insert into probe_results values (69, 'suspended org: member cannot DELETE an existing project', true);
  else
    insert into probe_results values (69, 'suspended org: member cannot DELETE an existing project', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (69, 'suspended-org project delete probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 70 — suspended org: a member cannot INSERT, UPDATE, or DELETE a
-- workflow either (same shape as projects — workflows_insert/update/
-- delete_members all amended identically)
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_org uuid := (select id from test_ids where key = 'org');
  v_project uuid := (select id from test_ids where key = 'suspension_project');
  v_workflow uuid := (select id from test_ids where key = 'suspension_workflow');
  insert_denied boolean := false;
  update_denied boolean := false;
  delete_denied boolean := false;
  n_updated int;
  n_deleted int;
begin
  perform pg_temp.act_as(v_member);

  begin
    insert into public.workflows (project_id, org_id, name, created_by) values (v_project, v_org, 'Should be blocked', v_member);
  exception when insufficient_privilege then
    insert_denied := true;
  end;

  update public.workflows set name = 'Should stay blocked' where id = v_workflow;
  get diagnostics n_updated = row_count;
  update_denied := n_updated = 0;

  delete from public.workflows where id = v_workflow;
  get diagnostics n_deleted = row_count;
  delete_denied := n_deleted = 0;

  reset role;

  if insert_denied and update_denied and delete_denied then
    insert into probe_results values (70, 'suspended org: member cannot INSERT/UPDATE/DELETE a workflow', true);
  else
    insert into probe_results values (70, 'suspended org: member cannot INSERT/UPDATE/DELETE a workflow', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (70, 'suspended-org workflow probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 71 — a personally-owned project (org_id null, owner_id = self) is
-- completely unaffected by ANY org's suspension — the owner_id branch of
-- every amended policy was deliberately left untouched.
-- =========================================================================
do $$
declare
  v_individual uuid := (select id from test_ids where key = 'individual');
  v_project uuid;
  insert_ok boolean := false;
  update_ok boolean := false;
  delete_ok boolean := false;
  n_rows int;
begin
  perform pg_temp.act_as(v_individual);

  begin
    insert into public.projects (org_id, owner_id, name, created_by)
    values (null, v_individual, 'Suspension-unaffected personal project', v_individual)
    returning id into v_project;
    insert_ok := true;
  exception when others then
    insert_ok := false;
  end;

  if v_project is not null then
    update public.projects set name = 'Renamed personal project' where id = v_project;
    get diagnostics n_rows = row_count;
    update_ok := n_rows = 1;

    delete from public.projects where id = v_project;
    get diagnostics n_rows = row_count;
    delete_ok := n_rows = 1;
  end if;

  reset role;

  if insert_ok and update_ok and delete_ok then
    insert into probe_results values (71, 'personally-owned project unaffected by any org''s suspension (insert/update/delete all succeed)', true);
  else
    insert into probe_results values (71, 'personally-owned project unaffected by any org''s suspension (insert/update/delete all succeed)', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (71, 'personal-project-unaffected-by-suspension probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 72 — cross-org isolation: org A is suspended but org B is not —
-- org B's owner can still INSERT/UPDATE their own org's project
-- (private.is_org_suspended(org_id) is checked per-row's own org_id only).
-- =========================================================================
do $$
declare
  v_org_b_owner uuid := (select id from test_ids where key = 'org_b_owner');
  v_org_b uuid := (select id from test_ids where key = 'org_b');
  v_project uuid;
  insert_ok boolean := false;
  update_ok boolean := false;
  n_rows int;
begin
  perform pg_temp.act_as(v_org_b_owner);

  begin
    insert into public.projects (org_id, name, created_by)
    values (v_org_b, 'Org B project (post-A-suspension)', v_org_b_owner)
    returning id into v_project;
    insert_ok := true;
  exception when others then
    insert_ok := false;
  end;

  if v_project is not null then
    update public.projects set name = 'Org B project renamed' where id = v_project;
    get diagnostics n_rows = row_count;
    update_ok := n_rows = 1;
  end if;

  reset role;

  if insert_ok and update_ok then
    insert into probe_results values (72, 'org B unaffected by org A''s suspension (insert/update still succeed)', true);
  else
    insert into probe_results values (72, 'org B unaffected by org A''s suspension (insert/update still succeed)', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (72, 'cross-org suspension isolation probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Fixture for probe 73 — un-suspend the main org (direct update, bypassing
-- RLS, same shape as probe 66's own suspend fixture above): kept in its
-- own isolated, no-role-switch block rather than folded into the
-- act_as-driven assertion below it, matching every other probe in this
-- file's convention of starting the BEGIN section with act_as() as the
-- very first statement (see probe 36's comment on the convention).
-- =========================================================================
do $$
declare
  v_org uuid := (select id from test_ids where key = 'org');
begin
  update public.organizations
  set suspended_at = null, suspended_by = null, suspended_reason = null
  where id = v_org;
exception when others then
  raise notice 'un-suspend-org fixture for probe 73 failed: %', sqlerrm;
end $$;

-- =========================================================================
-- Probe 73 — unsuspending the org (suspended_at set back to null) restores
-- write access immediately — suspension is not a one-way/permanent state.
--
-- Deliberately does NOT use `returning id into v_project`: with
-- 0054_project_members.sql's tightened projects_select_members policy, a
-- plain (non-admin) member's own just-inserted row isn't yet visible to
-- them at RETURNING-evaluation time — private.add_creator_as_project_member
-- is an AFTER INSERT trigger, and Postgres evaluates the SELECT policy
-- for RETURNING before that trigger has fired — so RETURNING spuriously
-- raises "new row violates row-level security policy" even though the
-- INSERT's own WITH CHECK genuinely passed. Confirmed this only affects
-- RETURNING itself (a plain INSERT with no RETURNING clause, as the real
-- app code in apps/web/src/lib/dashboard/actions.ts's createProject()
-- already does, succeeds fine) — not a product bug, just means probes
-- must fetch the new row's id the same way the app would: a follow-up
-- SELECT after reset role.
-- =========================================================================
do $$
declare
  v_org uuid := (select id from test_ids where key = 'org');
  v_member uuid := (select id from test_ids where key = 'member');
  v_project uuid;
  v_suspended boolean;
begin
  perform pg_temp.act_as(v_member);
  insert into public.projects (org_id, name, created_by) values (v_org, 'Post-unsuspend project', v_member);
  reset role;

  select id into v_project
  from public.projects
  where org_id = v_org and created_by = v_member and name = 'Post-unsuspend project';

  select private.is_org_suspended(v_org) into v_suspended;

  if not v_suspended and v_project is not null then
    insert into probe_results values (73, 'unsuspending the org restores write access', true);
  else
    insert into probe_results values (73, 'unsuspending the org restores write access', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (73, 'unsuspend-restores-access probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 74 — 0049_plans_table.sql: plans is a public read-only catalog —
-- any authenticated user (including a total outsider, not a member of any
-- org) can SELECT every row.
-- =========================================================================
do $$
declare
  v_outsider uuid := (select id from test_ids where key = 'outsider');
  n_plans int;
begin
  perform pg_temp.act_as(v_outsider);
  select count(*) into n_plans from public.plans;
  reset role;

  if n_plans = 5 then
    insert into probe_results values (74, 'plans: any authenticated user can read the full catalog (5 seeded rows)', true);
  else
    insert into probe_results values (74, 'plans: any authenticated user can read the full catalog (5 seeded rows)', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (74, 'plans read-all probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 75 — 0049_plans_table.sql: plans has no write grant at all —
-- confirm an authenticated user cannot INSERT/UPDATE/DELETE it (read-only
-- catalog, service_role/migrations only).
-- =========================================================================
do $$
declare
  v_outsider uuid := (select id from test_ids where key = 'outsider');
  insert_denied boolean := false;
  update_denied boolean := false;
  delete_denied boolean := false;
begin
  perform pg_temp.act_as(v_outsider);
  begin
    insert into public.plans (id, name) values ('probe-plan', 'Probe Plan');
  exception when insufficient_privilege then
    insert_denied := true;
  end;
  begin
    update public.plans set workflow_limit = 999 where id = 'free';
  exception when insufficient_privilege then
    update_denied := true;
  end;
  begin
    delete from public.plans where id = 'free';
  exception when insufficient_privilege then
    delete_denied := true;
  end;
  reset role;

  if insert_denied and update_denied and delete_denied then
    insert into probe_results values (75, 'plans: an authenticated user cannot INSERT/UPDATE/DELETE (read-only catalog)', true);
  else
    insert into probe_results values (75, 'plans: an authenticated user cannot INSERT/UPDATE/DELETE (read-only catalog)', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (75, 'plans read-only probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 76 — 0051_owner_plan_table.sql: a user CAN read their own
-- owner_plan row (auto-provisioned either by the backfill or by the
-- public."user" AFTER INSERT trigger, depending on when this fixture user
-- was created relative to the migration).
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_seen_user_id uuid;
begin
  perform pg_temp.act_as(v_member);
  select user_id into v_seen_user_id from public.owner_plan where user_id = v_member;
  reset role;

  if v_seen_user_id = v_member then
    insert into probe_results values (76, 'owner_plan: a user can read their own row', true);
  else
    insert into probe_results values (76, 'owner_plan: a user can read their own row', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (76, 'owner_plan read-own probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 77 — 0051_owner_plan_table.sql: a user CANNOT read another user's
-- owner_plan row.
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_admin  uuid := (select id from test_ids where key = 'admin');
  n_visible int;
begin
  perform pg_temp.act_as(v_member);
  select count(*) into n_visible from public.owner_plan where user_id = v_admin;
  reset role;

  if n_visible = 0 then
    insert into probe_results values (77, 'owner_plan: a user cannot read another user''s row', true);
  else
    insert into probe_results values (77, 'owner_plan: a user cannot read another user''s row', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (77, 'owner_plan read-other-user probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 78 — 0051_owner_plan_table.sql only ever added a SELECT-own grant —
-- confirm a user cannot INSERT/UPDATE/DELETE owner_plan at all (write-only
-- via service_role/the signup trigger).
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  insert_denied boolean := false;
  update_denied boolean := false;
  delete_denied boolean := false;
begin
  perform pg_temp.act_as(v_member);
  begin
    insert into public.owner_plan (user_id, plan_id) values (v_member, 'free');
  exception when insufficient_privilege then
    insert_denied := true;
  end;
  begin
    update public.owner_plan set workflow_limit_set = true, workflow_limit = 999 where user_id = v_member;
  exception when insufficient_privilege then
    update_denied := true;
  end;
  begin
    delete from public.owner_plan where user_id = v_member;
  exception when insufficient_privilege then
    delete_denied := true;
  end;
  reset role;

  if insert_denied and update_denied and delete_denied then
    insert into probe_results values (78, 'owner_plan: a user still cannot INSERT/UPDATE/DELETE (SELECT-own-only grant)', true);
  else
    insert into probe_results values (78, 'owner_plan: a user still cannot INSERT/UPDATE/DELETE (SELECT-own-only grant)', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (78, 'owner_plan member-cannot-write probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Fixture for probes 79-88 — 0054_project_members.sql (Subscription Phase
-- 2, Slice 2): a project in the main ('org') org created normally (through
-- RLS, not bypassed) by v_owner, so the creator-auto-membership trigger
-- has a real client-driven INSERT to fire on — probes 66-69's fixture
-- project inserts as postgres specifically to bypass insert-side policies
-- (not under test there), but the trigger itself is under test here, so
-- this fixture deliberately goes through act_as instead. v_owner (not
-- v_admin2) is used as the creator: v_admin2's own organization_members
-- row was permanently deleted by probe 6b above (another owner deleting
-- an owner's membership, by design — see probe 6b's own comment), so
-- v_admin2 is no longer an org member by this point in the script;
-- v_owner is never removed (probe 5's demote/delete attempts against it
-- are the ones the last-owner trigger is supposed to block, and it does).
--
-- Deliberately does NOT use `returning id into v_project` — see probe 73's
-- comment above for why: with this migration's tightened
-- projects_select_members policy, a plain (non-admin) creator's own
-- just-inserted row isn't visible to them yet at RETURNING-evaluation
-- time (the creator-auto-membership trigger fires AFTER insert, but
-- RETURNING's implicit SELECT-policy check happens before that), so this
-- looks the row up in a separate statement after reset role instead,
-- exactly like the real app code (apps/web/src/lib/dashboard/actions.ts's
-- createProject()) already does.
--
-- The main org's project_limit is already lifted by the root fixture above
-- (see its own comment) — this is just another org-scoped project against
-- the same org, same as probes 11/66-69/73's fixtures before it.
do $$
declare
  v_org uuid := (select id from test_ids where key = 'org');
  v_owner uuid := (select id from test_ids where key = 'owner');
  v_project uuid;
begin
  perform pg_temp.act_as(v_owner);
  insert into public.projects (org_id, name, created_by)
  values (v_org, 'Project members probe project', v_owner);
  reset role;

  select id into v_project
  from public.projects
  where org_id = v_org and created_by = v_owner and name = 'Project members probe project';

  insert into test_ids values ('pm_project', v_project);
exception when others then
  reset role;
  raise notice 'project_members probe fixture setup failed: %', sqlerrm;
end $$;

-- =========================================================================
-- Probe 79 — a plain member who was never added to project_members cannot
-- SELECT/UPDATE/DELETE a project created by someone else in their own,
-- healthy (non-suspended) org — this is the actual behavior change this
-- migration makes (previously any org member could touch any org project).
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_project uuid := (select id from test_ids where key = 'pm_project');
  n_visible int;
  n_updated int;
  n_deleted int;
begin
  perform pg_temp.act_as(v_member);
  select count(*) into n_visible from public.projects where id = v_project;
  update public.projects set name = 'Should stay blocked' where id = v_project;
  get diagnostics n_updated = row_count;
  delete from public.projects where id = v_project;
  get diagnostics n_deleted = row_count;
  reset role;

  if n_visible = 0 and n_updated = 0 and n_deleted = 0 then
    insert into probe_results values (79, 'member without project_members cannot SELECT/UPDATE/DELETE another member''s project', true);
  else
    insert into probe_results values (79, 'member without project_members cannot SELECT/UPDATE/DELETE another member''s project', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (79, 'member-without-project_members probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 80 — an admin who is NOT a project_member can still SELECT/
-- UPDATE/DELETE any project in their org — admins/owners bypass the
-- project_members check entirely (private.is_admin(org_id) branch).
-- =========================================================================
do $$
declare
  v_admin uuid := (select id from test_ids where key = 'admin');
  v_project uuid := (select id from test_ids where key = 'pm_project');
  n_visible int;
  n_updated int;
begin
  perform pg_temp.act_as(v_admin);
  select count(*) into n_visible from public.projects where id = v_project;
  update public.projects set name = 'Renamed by admin' where id = v_project;
  get diagnostics n_updated = row_count;
  reset role;

  if n_visible = 1 and n_updated = 1 then
    insert into probe_results values (80, 'admin without project_members can still SELECT/UPDATE any org project', true);
  else
    insert into probe_results values (80, 'admin without project_members can still SELECT/UPDATE any org project', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (80, 'admin-bypasses-project_members probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 81 — creator auto-membership: private.add_creator_as_project_member
-- inserted a project_members row for the creator (v_owner) automatically,
-- with no explicit client-side project_members insert.
-- =========================================================================
do $$
declare
  v_owner uuid := (select id from test_ids where key = 'owner');
  v_project uuid := (select id from test_ids where key = 'pm_project');
  n_rows int;
begin
  perform pg_temp.act_as(v_owner);
  select count(*) into n_rows from public.project_members where project_id = v_project and user_id = v_owner;
  reset role;

  if n_rows = 1 then
    insert into probe_results values (81, 'creator is auto-added to project_members on project INSERT', true);
  else
    insert into probe_results values (81, 'creator is auto-added to project_members on project INSERT', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (81, 'creator-auto-membership probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 82 — a member who is neither a project_member nor an org admin
-- cannot see ANY project_members rows for a project they can't access
-- (project_members_select_members_or_admins denies them, same as the
-- project row itself).
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_project uuid := (select id from test_ids where key = 'pm_project');
  n_rows int;
begin
  perform pg_temp.act_as(v_member);
  select count(*) into n_rows from public.project_members where project_id = v_project;
  reset role;

  if n_rows = 0 then
    insert into probe_results values (82, 'non-member/non-admin cannot see a project''s project_members rows', true);
  else
    insert into probe_results values (82, 'non-member/non-admin cannot see a project''s project_members rows', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (82, 'project_members select isolation probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 83 — a plain member (not an org admin/owner) cannot INSERT a
-- project_members row — granting project access is admin/owner-only.
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_project uuid := (select id from test_ids where key = 'pm_project');
  insert_denied boolean := false;
begin
  perform pg_temp.act_as(v_member);
  begin
    insert into public.project_members (project_id, user_id) values (v_project, v_member);
  exception when insufficient_privilege then
    insert_denied := true;
  end;
  reset role;

  if insert_denied then
    insert into probe_results values (83, 'plain member cannot INSERT their own project_members row (admin/owner-only grant)', true);
  else
    insert into probe_results values (83, 'plain member cannot INSERT their own project_members row (admin/owner-only grant)', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (83, 'project_members insert-denied-for-member probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 84 — an admin CAN grant project access by INSERTing a
-- project_members row for another user; that user can then SELECT the
-- project immediately (end-to-end proof of the intended "admin grants
-- access" flow, and of the exact mechanism the grandfathering backfill
-- itself relies on).
-- =========================================================================
do $$
declare
  v_admin uuid := (select id from test_ids where key = 'admin');
  v_member uuid := (select id from test_ids where key = 'member');
  v_project uuid := (select id from test_ids where key = 'pm_project');
  n_visible int;
begin
  perform pg_temp.act_as(v_admin);
  insert into public.project_members (project_id, user_id) values (v_project, v_member);
  reset role;

  perform pg_temp.act_as(v_member);
  select count(*) into n_visible from public.projects where id = v_project;
  reset role;

  if n_visible = 1 then
    insert into probe_results values (84, 'admin can grant a member project access via project_members; member can then SELECT it', true);
  else
    insert into probe_results values (84, 'admin can grant a member project access via project_members; member can then SELECT it', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (84, 'project_members admin-grants-access probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 85 — the newly-granted member cannot remove SOMEONE ELSE's
-- project_members row (not self, not admin) — e.g. cannot kick the
-- project's creator out.
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_owner uuid := (select id from test_ids where key = 'owner');
  v_project uuid := (select id from test_ids where key = 'pm_project');
  n_deleted int;
begin
  perform pg_temp.act_as(v_member);
  delete from public.project_members where project_id = v_project and user_id = v_owner;
  get diagnostics n_deleted = row_count;
  reset role;

  if n_deleted = 0 then
    insert into probe_results values (85, 'member cannot DELETE another user''s project_members row', true);
  else
    insert into probe_results values (85, 'member cannot DELETE another user''s project_members row', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (85, 'project_members delete-others-denied probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 86 — the member CAN remove their OWN project_members row (leaving
-- the project themselves needs no admin rights — mirrors
-- members_delete_admins_or_self's own self-delete branch), and immediately
-- loses SELECT visibility into the project afterward.
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_project uuid := (select id from test_ids where key = 'pm_project');
  n_deleted int;
  n_visible int;
begin
  perform pg_temp.act_as(v_member);
  delete from public.project_members where project_id = v_project and user_id = v_member;
  get diagnostics n_deleted = row_count;
  select count(*) into n_visible from public.projects where id = v_project;
  reset role;

  if n_deleted = 1 and n_visible = 0 then
    insert into probe_results values (86, 'member can leave a project themselves (self-delete), losing SELECT access immediately', true);
  else
    insert into probe_results values (86, 'member can leave a project themselves (self-delete), losing SELECT access immediately', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (86, 'project_members self-leave probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Fixture for probes 87-90 — an org-scoped project (with a workflow and a
-- workflow_run under it) that 'member' is NOT a project_member of —
-- 0055_workflow_project_membership.sql's analogue of the pm_project
-- fixture above. A fresh project is used rather than reusing pm_project,
-- since pm_project's own membership state was mutated by probes 84-86
-- (member was granted access, then removed itself); a clean project keeps
-- 87-90 unambiguous.
-- =========================================================================
do $$
declare
  v_org uuid := (select id from test_ids where key = 'org');
  v_owner uuid := (select id from test_ids where key = 'owner');
  v_project uuid;
  v_workflow uuid;
begin
  perform pg_temp.act_as(v_owner);
  insert into public.projects (org_id, name, created_by)
  values (v_org, 'Workflow project-membership probe project', v_owner);
  reset role;

  select id into v_project
  from public.projects
  where org_id = v_org and created_by = v_owner and name = 'Workflow project-membership probe project';

  -- Inserted as v_owner (a project_member via the creator-auto-membership
  -- trigger from 0054) rather than as postgres, so 0055's own insert-side
  -- check (private.is_admin(org_id) or private.is_project_member(project_id))
  -- is exercised by the fixture itself, same discipline as pm_project's own
  -- fixture comment above.
  perform pg_temp.act_as(v_owner);
  insert into public.workflows (project_id, org_id, name, created_by)
  values (v_project, v_org, 'Workflow project-membership probe workflow', v_owner);
  reset role;

  select id into v_workflow
  from public.workflows
  where project_id = v_project and name = 'Workflow project-membership probe workflow';

  -- workflow_runs has no client-facing insert policy (system-authored only,
  -- see 0002_projects_workflows.sql's own header comment), so this one is
  -- inserted as postgres.
  insert into public.workflow_runs (workflow_id, org_id, status, rows_processed)
  values (v_workflow, v_org, 'succeeded', 1);

  insert into test_ids values ('wpm_project', v_project), ('wpm_workflow', v_workflow);
exception when others then
  reset role;
  raise notice 'workflow project-membership probe fixture setup failed: %', sqlerrm;
end $$;

-- =========================================================================
-- Probe 87 — 0055_workflow_project_membership.sql: a member who is NOT a
-- project_member of a workflow's project cannot SELECT that workflow, even
-- though they ARE a member of the org (mirrors probe 79's project-level
-- behavior, one level down).
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_workflow uuid := (select id from test_ids where key = 'wpm_workflow');
  n_visible int;
begin
  perform pg_temp.act_as(v_member);
  select count(*) into n_visible from public.workflows where id = v_workflow;
  reset role;

  if n_visible = 0 then
    insert into probe_results values (87, 'member without project_members cannot SELECT a workflow in another member''s project', true);
  else
    insert into probe_results values (87, 'member without project_members cannot SELECT a workflow in another member''s project', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (87, 'workflow project-membership select probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 88 — same as probe 87, one level down: a member who is NOT a
-- project_member of the underlying workflow's project cannot SELECT its
-- workflow_run either (private.is_workflow_project_member(workflow_id)).
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_workflow uuid := (select id from test_ids where key = 'wpm_workflow');
  n_visible int;
begin
  perform pg_temp.act_as(v_member);
  select count(*) into n_visible from public.workflow_runs where workflow_id = v_workflow;
  reset role;

  if n_visible = 0 then
    insert into probe_results values (88, 'member without project_members cannot SELECT a workflow_run in another member''s project', true);
  else
    insert into probe_results values (88, 'member without project_members cannot SELECT a workflow_run in another member''s project', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (88, 'workflow_run project-membership select probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 89 — a member who is NOT a project_member of the project cannot
-- INSERT a new workflow into it, nor UPDATE/DELETE the existing one —
-- mirrors probe 70's suspended-org shape, but for the project-membership
-- check instead of org suspension.
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_org uuid := (select id from test_ids where key = 'org');
  v_project uuid := (select id from test_ids where key = 'wpm_project');
  v_workflow uuid := (select id from test_ids where key = 'wpm_workflow');
  insert_denied boolean := false;
  n_updated int;
  n_deleted int;
begin
  perform pg_temp.act_as(v_member);

  begin
    insert into public.workflows (project_id, org_id, name, created_by)
    values (v_project, v_org, 'Should be blocked', v_member);
  exception when insufficient_privilege then
    insert_denied := true;
  end;

  update public.workflows set name = 'Should stay blocked' where id = v_workflow;
  get diagnostics n_updated = row_count;
  delete from public.workflows where id = v_workflow;
  get diagnostics n_deleted = row_count;

  reset role;

  if insert_denied and n_updated = 0 and n_deleted = 0 then
    insert into probe_results values (89, 'member without project_members cannot INSERT/UPDATE/DELETE a workflow in another member''s project', true);
  else
    insert into probe_results values (89, 'member without project_members cannot INSERT/UPDATE/DELETE a workflow in another member''s project', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (89, 'workflow project-membership insert/update/delete probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 90 — an admin who is NOT a project_member can still SELECT/UPDATE
-- any workflow in their org — admins/owners bypass the project_members
-- check entirely, same as probe 80's project-level equivalent.
-- =========================================================================
do $$
declare
  v_admin uuid := (select id from test_ids where key = 'admin');
  v_workflow uuid := (select id from test_ids where key = 'wpm_workflow');
  n_visible int;
  n_updated int;
begin
  perform pg_temp.act_as(v_admin);
  select count(*) into n_visible from public.workflows where id = v_workflow;
  update public.workflows set name = 'Renamed by admin' where id = v_workflow;
  get diagnostics n_updated = row_count;
  reset role;

  if n_visible = 1 and n_updated = 1 then
    insert into probe_results values (90, 'admin without project_members can still SELECT/UPDATE any org workflow', true);
  else
    insert into probe_results values (90, 'admin without project_members can still SELECT/UPDATE any org workflow', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (90, 'workflow project-membership admin-bypass probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 91 — a personally-owned workflow (org_id null, owner_id = self) is
-- completely unaffected by the project-membership rule — the owner_id
-- branch of every 0055-amended policy was deliberately left untouched.
-- =========================================================================
do $$
declare
  v_individual uuid := (select id from test_ids where key = 'individual');
  v_workflow uuid := (select id from test_ids where key = 'personal_workflow');
  n_visible int;
  n_updated int;
begin
  perform pg_temp.act_as(v_individual);
  select count(*) into n_visible from public.workflows where id = v_workflow;
  update public.workflows set name = 'Renamed personal workflow' where id = v_workflow;
  get diagnostics n_updated = row_count;
  reset role;

  if n_visible = 1 and n_updated = 1 then
    insert into probe_results values (91, 'personally-owned workflow unaffected by the project-membership rule', true);
  else
    insert into probe_results values (91, 'personally-owned workflow unaffected by the project-membership rule', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (91, 'personal-workflow-unaffected-by-project-membership probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Fixture for probes 92-96 — 0056_viewer_role_enum.sql /
-- 0057_viewer_role_restrictions.sql (Subscription Phase 2, Slice 3): grants
-- v_viewer project_members access to the existing wpm_project fixture
-- (probes 87-91's project), so probe 92 can prove a viewer with real
-- project access can still read, while probe 93 proves that same access
-- still doesn't let them write. Same admin-grants-access mechanism as
-- probe 84.
-- =========================================================================
do $$
declare
  v_admin uuid := (select id from test_ids where key = 'admin');
  v_viewer uuid := (select id from test_ids where key = 'viewer');
  v_project uuid := (select id from test_ids where key = 'wpm_project');
begin
  perform pg_temp.act_as(v_admin);
  insert into public.project_members (project_id, user_id) values (v_project, v_viewer);
  reset role;
exception when others then
  reset role;
  raise notice 'viewer project-membership probe fixture setup failed: %', sqlerrm;
end $$;

-- =========================================================================
-- Probe 92 — a viewer who IS a project_member of a workflow's project CAN
-- still SELECT that workflow — viewer is read-only, not no-read.
-- =========================================================================
do $$
declare
  v_viewer uuid := (select id from test_ids where key = 'viewer');
  v_workflow uuid := (select id from test_ids where key = 'wpm_workflow');
  n_visible int;
begin
  perform pg_temp.act_as(v_viewer);
  select count(*) into n_visible from public.workflows where id = v_workflow;
  reset role;

  if n_visible = 1 then
    insert into probe_results values (92, 'viewer with project_members access CAN SELECT a workflow in that project', true);
  else
    insert into probe_results values (92, 'viewer with project_members access CAN SELECT a workflow in that project', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (92, 'viewer-can-read probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 93 — that same viewer, despite having project_members access,
-- cannot INSERT a new workflow into the project, nor UPDATE/DELETE the
-- existing one — private.is_write_member excludes 'viewer' regardless of
-- project membership.
-- =========================================================================
do $$
declare
  v_viewer uuid := (select id from test_ids where key = 'viewer');
  v_org uuid := (select id from test_ids where key = 'org');
  v_project uuid := (select id from test_ids where key = 'wpm_project');
  v_workflow uuid := (select id from test_ids where key = 'wpm_workflow');
  insert_denied boolean := false;
  n_updated int;
  n_deleted int;
begin
  perform pg_temp.act_as(v_viewer);

  begin
    insert into public.workflows (project_id, org_id, name, created_by)
    values (v_project, v_org, 'Should be blocked (viewer)', v_viewer);
  exception when insufficient_privilege then
    insert_denied := true;
  end;

  update public.workflows set name = 'Should stay blocked (viewer)' where id = v_workflow;
  get diagnostics n_updated = row_count;
  delete from public.workflows where id = v_workflow;
  get diagnostics n_deleted = row_count;

  reset role;

  if insert_denied and n_updated = 0 and n_deleted = 0 then
    insert into probe_results values (93, 'viewer with project_members access still cannot INSERT/UPDATE/DELETE a workflow', true);
  else
    insert into probe_results values (93, 'viewer with project_members access still cannot INSERT/UPDATE/DELETE a workflow', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (93, 'viewer-cannot-write-workflow probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 94 — a viewer cannot INSERT a new project into their org, and
-- cannot UPDATE/DELETE pm_project (an existing project they are not a
-- project_member of).
-- =========================================================================
do $$
declare
  v_viewer uuid := (select id from test_ids where key = 'viewer');
  v_org uuid := (select id from test_ids where key = 'org');
  v_project uuid := (select id from test_ids where key = 'pm_project');
  insert_denied boolean := false;
  n_updated int;
  n_deleted int;
begin
  perform pg_temp.act_as(v_viewer);

  begin
    insert into public.projects (org_id, name, created_by)
    values (v_org, 'Should be blocked (viewer project)', v_viewer);
  exception when insufficient_privilege then
    insert_denied := true;
  end;

  update public.projects set name = 'Should stay blocked (viewer)' where id = v_project;
  get diagnostics n_updated = row_count;
  delete from public.projects where id = v_project;
  get diagnostics n_deleted = row_count;

  reset role;

  if insert_denied and n_updated = 0 and n_deleted = 0 then
    insert into probe_results values (94, 'viewer cannot INSERT/UPDATE/DELETE a project', true);
  else
    insert into probe_results values (94, 'viewer cannot INSERT/UPDATE/DELETE a project', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (94, 'viewer-cannot-write-project probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 95 — a viewer cannot INSERT a new connection into their org, and
-- cannot UPDATE/DELETE the existing connection_org fixture (probe 14).
-- =========================================================================
do $$
declare
  v_viewer uuid := (select id from test_ids where key = 'viewer');
  v_org uuid := (select id from test_ids where key = 'org');
  v_conn uuid := (select id from test_ids where key = 'connection_org');
  insert_denied boolean := false;
  n_updated int;
  n_deleted int;
begin
  perform pg_temp.act_as(v_viewer);

  begin
    insert into public.connections
      (org_id, connector_id, handle, display_name, owner_user_id, vault_secret_ref)
    values
      (v_org, 'mysql', '@viewer-blocked-conn', 'Should be blocked (viewer)', v_viewer, 'vault://blocked');
  exception when insufficient_privilege then
    insert_denied := true;
  end;

  update public.connections set display_name = 'Should stay blocked (viewer)' where id = v_conn;
  get diagnostics n_updated = row_count;
  delete from public.connections where id = v_conn;
  get diagnostics n_deleted = row_count;

  reset role;

  if insert_denied and n_updated = 0 and n_deleted = 0 then
    insert into probe_results values (95, 'viewer cannot INSERT/UPDATE/DELETE a connection', true);
  else
    insert into probe_results values (95, 'viewer cannot INSERT/UPDATE/DELETE a connection', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (95, 'viewer-cannot-write-connection probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 96 — a viewer cannot SELECT a project they are not a
-- project_member of (pm_project) at all — read access is still scoped by
-- project membership same as any other non-admin role, viewer is not an
-- org-wide read bypass.
-- =========================================================================
do $$
declare
  v_viewer uuid := (select id from test_ids where key = 'viewer');
  v_project uuid := (select id from test_ids where key = 'pm_project');
  n_visible int;
begin
  perform pg_temp.act_as(v_viewer);
  select count(*) into n_visible from public.projects where id = v_project;
  reset role;

  if n_visible = 0 then
    insert into probe_results values (96, 'viewer cannot SELECT a project they are not a project_member of', true);
  else
    insert into probe_results values (96, 'viewer cannot SELECT a project they are not a project_member of', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (96, 'viewer-cannot-see-unowned-project probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 97 — an admin (non-owner) can create a member-role invite via
-- create_invite, and can SELECT it back — invite_links_select_admin covers
-- both admin and owner, not just owner (0058_invite_links.sql).
-- =========================================================================
do $$
declare
  v_admin uuid := (select id from test_ids where key = 'admin');
  v_org uuid := (select id from test_ids where key = 'org');
  v_invite_id uuid;
  n_visible int;
begin
  perform pg_temp.act_as(v_admin);

  select id into v_invite_id
  from public.create_invite(v_org, 'member', 'rls-probe-invite-member', now() + interval '7 days', null, null);

  select count(*) into n_visible from public.invite_links where id = v_invite_id;

  reset role;

  insert into test_ids values ('invite_member', v_invite_id);

  if v_invite_id is not null and n_visible = 1 then
    insert into probe_results values (97, 'admin can create a member-role invite and SELECT it back', true);
  else
    insert into probe_results values (97, 'admin can create a member-role invite and SELECT it back', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (97, 'admin-create-invite probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 98 — that same admin cannot create an owner-role invite (raises
-- "only an owner may create an owner-role invite"), but the org's owner
-- can.
-- =========================================================================
do $$
declare
  v_admin uuid := (select id from test_ids where key = 'admin');
  v_owner uuid := (select id from test_ids where key = 'owner');
  v_org uuid := (select id from test_ids where key = 'org');
  admin_denied boolean := false;
  v_owner_invite_id uuid;
begin
  perform pg_temp.act_as(v_admin);
  begin
    perform public.create_invite(v_org, 'owner', 'rls-probe-invite-owner-denied', now() + interval '7 days', null, null);
  exception when others then
    if sqlerrm like '%only an owner may create an owner-role invite%' then
      admin_denied := true;
    end if;
  end;
  reset role;

  perform pg_temp.act_as(v_owner);
  select id into v_owner_invite_id
  from public.create_invite(v_org, 'owner', 'rls-probe-invite-owner', now() + interval '7 days', null, null);
  reset role;

  if admin_denied and v_owner_invite_id is not null then
    insert into probe_results values (98, 'admin cannot create an owner-role invite, owner can', true);
  else
    insert into probe_results values (98, 'admin cannot create an owner-role invite, owner can', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (98, 'admin-cannot-create-owner-invite probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 99 — a plain member cannot SELECT any invite_links row for their
-- own org, even though invite_member (probe 97) exists — the select policy
-- is admin/owner-only, membership alone isn't enough.
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_org uuid := (select id from test_ids where key = 'org');
  n_visible int;
begin
  perform pg_temp.act_as(v_member);
  select count(*) into n_visible from public.invite_links where org_id = v_org;
  reset role;

  if n_visible = 0 then
    insert into probe_results values (99, 'plain member cannot SELECT any invite_links row for their org', true);
  else
    insert into probe_results values (99, 'plain member cannot SELECT any invite_links row for their org', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (99, 'member-cannot-see-invites probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 100 — a plain member cannot directly INSERT/UPDATE/DELETE
-- invite_links, bypassing create_invite/revoke_invite — writes are revoked
-- from authenticated wholesale (0058_invite_links.sql), so every attempt
-- must fail with insufficient_privilege, not merely 0 affected rows.
-- =========================================================================
do $$
declare
  v_member uuid := (select id from test_ids where key = 'member');
  v_org uuid := (select id from test_ids where key = 'org');
  v_invite uuid := (select id from test_ids where key = 'invite_member');
  insert_denied boolean := false;
  update_denied boolean := false;
  delete_denied boolean := false;
begin
  perform pg_temp.act_as(v_member);

  begin
    insert into public.invite_links (org_id, role, token_hash, expires_at, created_by)
    values (v_org, 'member', 'rls-probe-invite-direct-insert', now() + interval '7 days', v_member);
  exception when insufficient_privilege then
    insert_denied := true;
  end;

  begin
    update public.invite_links set max_uses = 1 where id = v_invite;
  exception when insufficient_privilege then
    update_denied := true;
  end;

  begin
    delete from public.invite_links where id = v_invite;
  exception when insufficient_privilege then
    delete_denied := true;
  end;

  reset role;

  if insert_denied and update_denied and delete_denied then
    insert into probe_results values (100, 'plain member cannot directly INSERT/UPDATE/DELETE invite_links', true);
  else
    insert into probe_results values (100, 'plain member cannot directly INSERT/UPDATE/DELETE invite_links', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (100, 'member-cannot-write-invite_links probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Probe 101 — a total outsider (not an org member at all) cannot SELECT
-- any invite_links row for the org either.
-- =========================================================================
do $$
declare
  v_outsider uuid := (select id from test_ids where key = 'outsider');
  v_org uuid := (select id from test_ids where key = 'org');
  n_visible int;
begin
  perform pg_temp.act_as(v_outsider);
  select count(*) into n_visible from public.invite_links where org_id = v_org;
  reset role;

  if n_visible = 0 then
    insert into probe_results values (101, 'outsider cannot SELECT any invite_links row for the org', true);
  else
    insert into probe_results values (101, 'outsider cannot SELECT any invite_links row for the org', false);
  end if;
exception when others then
  reset role;
  insert into probe_results values (101, 'outsider-cannot-see-invites probe (errored: ' || sqlerrm || ')', false);
end $$;

-- =========================================================================
-- Report
-- =========================================================================
do $$
declare
  r record;
  any_failed boolean := false;
begin
  raise notice '---------------------------------------------------------';
  for r in select * from probe_results order by n loop
    raise notice '[%] % — %', r.n, case when r.passed then 'PASS' else 'FAIL' end, r.name;
    if not r.passed then
      any_failed := true;
    end if;
  end loop;
  raise notice '---------------------------------------------------------';
  if any_failed then
    raise notice 'RESULT: ONE OR MORE PROBES FAILED';
  else
    raise notice 'RESULT: ALL PROBES PASSED';
  end if;
end $$;

select
  n,
  case when passed then 'PASS' else 'FAIL' end as result,
  name
from probe_results
order by n;

rollback;
