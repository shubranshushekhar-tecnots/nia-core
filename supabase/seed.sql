-- seed.sql
-- Local dev fixture data: one demo org with a realistic project/workflow/run
-- density, matching designs/Nia Core App.html's home screen (3 projects,
-- ~12 workflows in the reference copy — trimmed here to ~6 to keep the seed
-- readable while still exercising every UI state: draft/active/paused
-- workflows and running/succeeded/failed runs).
--
-- Only runs during `supabase db reset` / `supabase start` against the LOCAL
-- database — never applied to the linked remote project.

do $$
declare
  v_demo_user uuid := '00000000-0000-0000-0000-0000000000d1';
  v_org       uuid;
  v_proj_sales   uuid;
  v_proj_support uuid;
  v_proj_marketing uuid;
  v_wf_pipeline  uuid;
  v_wf_forecast  uuid;
  v_wf_tickets   uuid;
  v_wf_churn     uuid;
  v_wf_campaign  uuid;
  v_wf_attribution uuid;
begin
  -- GoTrue's Go structs scan confirmation_token/recovery_token/etc as
  -- plain strings, not nullable ones — a NULL here (the column default)
  -- makes every auth request against this user 500 with "Database error
  -- querying schema". Real signups never hit this because GoTrue's own
  -- insert path always writes '', not NULL; a raw SQL insert must match
  -- that explicitly.
  insert into auth.users
    (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
     raw_app_meta_data, raw_user_meta_data, confirmation_token, recovery_token, email_change_token_new,
     email_change, email_change_token_current, phone_change, phone_change_token)
  values
    ('00000000-0000-0000-0000-000000000000', v_demo_user, 'authenticated', 'authenticated', 'demo@nia.dev',
     crypt('password', gen_salt('bf')), now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{"full_name":"Demo User"}',
     '', '', '', '', '', '', '')
  on conflict (id) do nothing;

  -- password-grant login also requires a matching auth.identities row
  -- (GoTrue resolves the user through the identity, not auth.users
  -- directly) — a real /auth/v1/signup always creates one, a raw insert
  -- must add it explicitly too.
  insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (
    v_demo_user::text, v_demo_user,
    jsonb_build_object('sub', v_demo_user::text, 'email', 'demo@nia.dev', 'email_verified', true),
    'email', now(), now(), now()
  )
  on conflict (provider_id, provider) do nothing;

  insert into public.organizations (name, slug, created_by)
  values ('Ice Cream Co', 'icecream-co', v_demo_user)
  returning id into v_org;

  insert into public.organization_members (org_id, user_id, role)
  values (v_org, v_demo_user, 'owner');

  insert into public.projects (id, org_id, name, created_by, created_at, updated_at) values
    (gen_random_uuid(), v_org, 'Sales Analytics', v_demo_user, now() - interval '30 days', now() - interval '4 minutes'),
    (gen_random_uuid(), v_org, 'Support Insights', v_demo_user, now() - interval '21 days', now() - interval '2 hours'),
    (gen_random_uuid(), v_org, 'Marketing Ops', v_demo_user, now() - interval '9 days', now() - interval '1 day');

  select id into v_proj_sales from public.projects where org_id = v_org and name = 'Sales Analytics';
  select id into v_proj_support from public.projects where org_id = v_org and name = 'Support Insights';
  select id into v_proj_marketing from public.projects where org_id = v_org and name = 'Marketing Ops';

  insert into public.workflows (id, project_id, org_id, name, status, created_by, created_at, updated_at) values
    (gen_random_uuid(), v_proj_sales, v_org, 'Sales pipeline sync', 'active', v_demo_user, now() - interval '30 days', now() - interval '4 minutes'),
    (gen_random_uuid(), v_proj_sales, v_org, 'Revenue forecast', 'active', v_demo_user, now() - interval '28 days', now() - interval '3 hours'),
    (gen_random_uuid(), v_proj_support, v_org, 'Ticket triage feed', 'active', v_demo_user, now() - interval '21 days', now() - interval '2 hours'),
    (gen_random_uuid(), v_proj_support, v_org, 'Churn risk scoring', 'paused', v_demo_user, now() - interval '18 days', now() - interval '5 days'),
    (gen_random_uuid(), v_proj_marketing, v_org, 'Campaign performance', 'active', v_demo_user, now() - interval '9 days', now() - interval '1 day'),
    (gen_random_uuid(), v_proj_marketing, v_org, 'Attribution model', 'draft', v_demo_user, now() - interval '2 days', now() - interval '2 days');

  select id into v_wf_pipeline from public.workflows where project_id = v_proj_sales and name = 'Sales pipeline sync';
  select id into v_wf_forecast from public.workflows where project_id = v_proj_sales and name = 'Revenue forecast';
  select id into v_wf_tickets from public.workflows where project_id = v_proj_support and name = 'Ticket triage feed';
  select id into v_wf_churn from public.workflows where project_id = v_proj_support and name = 'Churn risk scoring';
  select id into v_wf_campaign from public.workflows where project_id = v_proj_marketing and name = 'Campaign performance';
  select id into v_wf_attribution from public.workflows where project_id = v_proj_marketing and name = 'Attribution model';

  insert into public.workflow_runs (workflow_id, org_id, status, rows_processed, duration_ms, started_at, finished_at) values
    (v_wf_pipeline,     v_org, 'running',   842000, null,    now() - interval '4 minutes', null),
    (v_wf_forecast,     v_org, 'succeeded', 128400, 96000,   now() - interval '3 hours', now() - interval '3 hours' + interval '96 seconds'),
    (v_wf_tickets,      v_org, 'succeeded', 5320,   14000,   now() - interval '2 hours', now() - interval '2 hours' + interval '14 seconds'),
    (v_wf_campaign,     v_org, 'failed',    0,      4000,    now() - interval '1 day', now() - interval '1 day' + interval '4 seconds'),
    (v_wf_pipeline,     v_org, 'succeeded', 811200, 143000,  now() - interval '1 day', now() - interval '1 day' + interval '143 seconds'),
    (v_wf_forecast,     v_org, 'succeeded', 127900, 91000,   now() - interval '2 days', now() - interval '2 days' + interval '91 seconds'),
    (v_wf_churn,        v_org, 'succeeded', 40210,  61000,   now() - interval '5 days', now() - interval '5 days' + interval '61 seconds'),
    (v_wf_tickets,      v_org, 'failed',    1200,   3000,    now() - interval '6 days', now() - interval '6 days' + interval '3 seconds'),
    (v_wf_campaign,     v_org, 'succeeded', 9840,   22000,   now() - interval '7 days', now() - interval '7 days' + interval '22 seconds'),
    (v_wf_pipeline,     v_org, 'succeeded', 798300, 138000,  now() - interval '8 days', now() - interval '8 days' + interval '138 seconds');
end $$;

-- =========================================================================
-- Canvas E2E fixtures (Task 3/4) — 3 personas exercising every workspace
-- shape the new React Flow canvas + its Playwright suite need: an org
-- member (deliberately NOT owner — proves can.ts's "member does all work
-- actions" rule, see CONVENTIONS.md's DECISION-C), a second org's owner (the
-- cross-org 403/empty negative fixture, shares nothing with the first org),
-- and a personal/individual-workspace user (org_id null, owner_id set, per
-- 0005_individual_workspace.sql). Password is a fixed, documented,
-- non-secret local-fixture value, same spirit as demo@nia.dev/password
-- above — duplicated as a literal constant in
-- apps/web/e2e/fixtures/personas.ts; keep the two in sync if it ever
-- changes.
-- =========================================================================
do $$
declare
  v_password_hash text := crypt('password', gen_salt('bf'));
  v_user_a uuid := '00000000-0000-0000-0000-0000000000e1'; -- canvas-e2e-a@nia.dev — member of canvas-e2e org
  v_user_b uuid := '00000000-0000-0000-0000-0000000000e2'; -- canvas-e2e-b@nia.dev — owner of canvas-e2e-b org
  v_user_c uuid := '00000000-0000-0000-0000-0000000000e3'; -- canvas-e2e-c@nia.dev — personal workspace
  v_org_a uuid;
  v_org_b uuid;
  v_proj_a uuid;
  v_proj_c uuid;
  v_wf_unknown uuid;
begin
  insert into auth.users
    (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
     raw_app_meta_data, raw_user_meta_data, confirmation_token, recovery_token, email_change_token_new,
     email_change, email_change_token_current, phone_change, phone_change_token)
  values
    ('00000000-0000-0000-0000-000000000000', v_user_a, 'authenticated', 'authenticated', 'canvas-e2e-a@nia.dev',
     v_password_hash, now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{"full_name":"Canvas E2E A"}',
     '', '', '', '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', v_user_b, 'authenticated', 'authenticated', 'canvas-e2e-b@nia.dev',
     v_password_hash, now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{"full_name":"Canvas E2E B"}',
     '', '', '', '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', v_user_c, 'authenticated', 'authenticated', 'canvas-e2e-c@nia.dev',
     v_password_hash, now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{"full_name":"Canvas E2E C"}',
     '', '', '', '', '', '', '')
  on conflict (id) do nothing;

  insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values
    (v_user_a::text, v_user_a,
     jsonb_build_object('sub', v_user_a::text, 'email', 'canvas-e2e-a@nia.dev', 'email_verified', true),
     'email', now(), now(), now()),
    (v_user_b::text, v_user_b,
     jsonb_build_object('sub', v_user_b::text, 'email', 'canvas-e2e-b@nia.dev', 'email_verified', true),
     'email', now(), now(), now()),
    (v_user_c::text, v_user_c,
     jsonb_build_object('sub', v_user_c::text, 'email', 'canvas-e2e-c@nia.dev', 'email_verified', true),
     'email', now(), now(), now())
  on conflict (provider_id, provider) do nothing;

  insert into public.organizations (name, slug, created_by)
  values ('Canvas E2E Org', 'canvas-e2e', v_user_a)
  returning id into v_org_a;

  insert into public.organizations (name, slug, created_by)
  values ('Canvas E2E Org B', 'canvas-e2e-b', v_user_b)
  returning id into v_org_b;

  insert into public.organization_members (org_id, user_id, role)
  values (v_org_a, v_user_a, 'member');

  insert into public.organization_members (org_id, user_id, role)
  values (v_org_b, v_user_b, 'owner');

  insert into public.projects (id, org_id, name, created_by, created_at, updated_at)
  values (gen_random_uuid(), v_org_a, 'Canvas E2E Project', v_user_a, now(), now())
  returning id into v_proj_a;

  -- 'Canvas E2E Workflow' deliberately gets no workflow_graphs row — the
  -- e2e suite's beforeEach fetches the (absent -> default) version and PUTs
  -- an empty graph before each run. This is the drag/connect/reload and
  -- two-tab-conflict fixture, always reset to a known starting state.
  --
  -- 'Canvas E2E Unknown Tool' is pre-seeded below with a node whose
  -- manifestId doesn't exist in the connector registry — the
  -- crash-proof/unknown-tool render fixture. Never touched by any other
  -- test.
  insert into public.workflows (id, project_id, org_id, name, status, created_by, created_at, updated_at)
  values
    (gen_random_uuid(), v_proj_a, v_org_a, 'Canvas E2E Workflow', 'draft', v_user_a, now(), now()),
    (gen_random_uuid(), v_proj_a, v_org_a, 'Canvas E2E Unknown Tool', 'draft', v_user_a, now(), now());

  select id into v_wf_unknown from public.workflows where project_id = v_proj_a and name = 'Canvas E2E Unknown Tool';

  insert into public.workflow_graphs (workflow_id, graph, version)
  values (
    v_wf_unknown,
    jsonb_build_object(
      'nodes', jsonb_build_array(
        jsonb_build_object(
          'id', 'n1',
          'type', 'source',
          'manifestId', 'not-a-real-connector',
          'position', jsonb_build_object('x', 120, 'y', 120),
          'config', '{}'::jsonb
        )
      ),
      'edges', '[]'::jsonb
    ),
    1
  );

  -- Personal/individual workspace (org_id null, owner_id set) — proves the
  -- WorkspaceScope/individual-role path end-to-end.
  insert into public.projects (id, owner_id, name, created_by, created_at, updated_at)
  values (gen_random_uuid(), v_user_c, 'Canvas E2E Personal Project', v_user_c, now(), now())
  returning id into v_proj_c;

  insert into public.workflows (id, project_id, owner_id, name, status, created_by, created_at, updated_at)
  values (gen_random_uuid(), v_proj_c, v_user_c, 'Canvas E2E Personal Workflow', 'draft', v_user_c, now(), now());
end $$;
