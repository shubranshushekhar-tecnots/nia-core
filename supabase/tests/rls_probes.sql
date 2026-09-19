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
  select * into v_grant from public.confirm_write_grant(v_grant.id, 'vault:write-cred-probe-36');
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
  select * into v_grant from public.confirm_write_grant(v_grant.id, 'vault:write-cred-probe-38');

  begin
    perform public.confirm_write_grant(v_grant.id, 'vault:write-cred-probe-38-again');
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
  select * into v_grant from public.confirm_write_grant(v_grant.id, 'vault:write-cred-probe-39');
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
  select * into v_grant from public.confirm_write_grant(v_grant.id, 'vault:write-cred-probe-40');
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
