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

do $$
declare
  v_owner    uuid := gen_random_uuid(); -- owner, org creator
  v_admin2   uuid := gen_random_uuid(); -- second owner
  v_admin    uuid := gen_random_uuid(); -- plain admin
  v_member   uuid := gen_random_uuid(); -- plain member
  v_outsider uuid := gen_random_uuid(); -- not a member of the org
  v_org      uuid;
begin
  insert into auth.users
    (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000', v_owner,    'authenticated', 'authenticated', 'owner@rls-probe.test',    crypt('password', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}'),
    ('00000000-0000-0000-0000-000000000000', v_admin2,   'authenticated', 'authenticated', 'admin2@rls-probe.test',   crypt('password', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}'),
    ('00000000-0000-0000-0000-000000000000', v_admin,    'authenticated', 'authenticated', 'admin@rls-probe.test',    crypt('password', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}'),
    ('00000000-0000-0000-0000-000000000000', v_member,   'authenticated', 'authenticated', 'member@rls-probe.test',   crypt('password', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}'),
    ('00000000-0000-0000-0000-000000000000', v_outsider, 'authenticated', 'authenticated', 'outsider@rls-probe.test', crypt('password', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}');
  -- handle_new_user() trigger auto-creates matching public.profiles rows.

  insert into public.organizations (name, slug, created_by)
  values ('RLS Probe Org', 'rls-probe-org', v_owner)
  returning id into v_org;

  insert into public.organization_members (org_id, user_id, role) values
    (v_org, v_owner,  'owner'),
    (v_org, v_admin2, 'owner'),
    (v_org, v_admin,  'admin'),
    (v_org, v_member, 'member');

  insert into test_ids values
    ('owner', v_owner), ('admin2', v_admin2), ('admin', v_admin),
    ('member', v_member), ('outsider', v_outsider), ('org', v_org);
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
  v_new uuid := gen_random_uuid();
  denied boolean := false;
begin
  -- Fixture: give the target user a profile-less row is fine; FK only needs auth.users.
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  values ('00000000-0000-0000-0000-000000000000', v_new, 'authenticated', 'authenticated', 'newperson@rls-probe.test', crypt('password', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}');

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
  v_individual uuid := gen_random_uuid();
begin
  insert into auth.users
    (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000', v_individual, 'authenticated', 'authenticated', 'individual@rls-probe.test', crypt('password', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}');

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
  v_org_b_owner uuid := gen_random_uuid();
  v_org_b uuid;
  v_project_a uuid;
  v_project_b uuid;
  v_workflow_a uuid;
  v_workflow_b uuid;
  v_member uuid := (select id from test_ids where key = 'member');
begin
  insert into auth.users
    (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000', v_org_b_owner, 'authenticated', 'authenticated', 'orgb-owner@rls-probe.test', crypt('password', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}');

  insert into public.organizations (name, slug, created_by)
  values ('RLS Probe Org B', 'rls-probe-org-b', v_org_b_owner)
  returning id into v_org_b;

  insert into public.organization_members (org_id, user_id, role) values (v_org_b, v_org_b_owner, 'owner');

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
-- org's connection; an outsider cannot see it.
do $$
declare
  v_member   uuid := (select id from test_ids where key = 'member');
  v_outsider uuid := (select id from test_ids where key = 'outsider');
  v_conn     uuid := (select id from test_ids where key = 'connection_org');
  v_grant    uuid;
  n_outsider_sees int;
begin
  perform pg_temp.act_as(v_member);
  insert into public.write_grants (connection_id, granted_by_user_id, scope)
  values (v_conn, v_member, '{"schemas":["sales"]}'::jsonb)
  returning id into v_grant;
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
