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
  insert into auth.users
    (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000', v_demo_user, 'authenticated', 'authenticated', 'demo@nia.dev',
     crypt('password', gen_salt('bf')), now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{"full_name":"Demo User"}')
  on conflict (id) do nothing;

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
