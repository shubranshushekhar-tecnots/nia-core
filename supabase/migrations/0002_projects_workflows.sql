-- 0002_projects_workflows.sql
-- Projects/workflows slice: projects, workflows, workflow_runs, RLS.
-- Same discipline as 0001: RLS on every table, explicit revokes/grants,
-- search_path pinned on functions, no dashboard-authored objects.

-- =========================================================================
-- 1. projects
-- =========================================================================

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index projects_org_id_idx on public.projects (org_id);

alter table public.projects enable row level security;

create trigger projects_set_updated_at
  before update on public.projects
  for each row
  execute function public.set_updated_at();

-- Membership is the only gate for now — project-level roles arrive later.
create policy "projects_select_members"
  on public.projects for select
  using (private.is_member(org_id));

create policy "projects_insert_members"
  on public.projects for insert
  with check (private.is_member(org_id) and created_by = auth.uid());

create policy "projects_update_members"
  on public.projects for update
  using (private.is_member(org_id))
  with check (private.is_member(org_id));

create policy "projects_delete_members"
  on public.projects for delete
  using (private.is_member(org_id));

grant select, insert, update, delete on public.projects to authenticated;

-- =========================================================================
-- 2. workflows
-- =========================================================================

create type public.workflow_status as enum ('draft', 'active', 'paused');

create table public.workflows (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  -- Denormalized from projects.org_id so RLS can key off org_id directly
  -- without a join back to projects on every row check.
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  status public.workflow_status not null default 'draft',
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index workflows_org_id_updated_at_idx
  on public.workflows (org_id, updated_at desc);
create index workflows_project_id_idx on public.workflows (project_id);

alter table public.workflows enable row level security;

create trigger workflows_set_updated_at
  before update on public.workflows
  for each row
  execute function public.set_updated_at();

create policy "workflows_select_members"
  on public.workflows for select
  using (private.is_member(org_id));

create policy "workflows_insert_members"
  on public.workflows for insert
  with check (private.is_member(org_id) and created_by = auth.uid());

create policy "workflows_update_members"
  on public.workflows for update
  using (private.is_member(org_id))
  with check (private.is_member(org_id));

create policy "workflows_delete_members"
  on public.workflows for delete
  using (private.is_member(org_id));

grant select, insert, update, delete on public.workflows to authenticated;

-- =========================================================================
-- 3. workflow_runs — system-authored, no client writes
-- =========================================================================

create type public.workflow_run_status as enum ('running', 'succeeded', 'failed');

create table public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows (id) on delete cascade,
  org_id uuid not null references public.organizations (id) on delete cascade,
  status public.workflow_run_status not null default 'running',
  rows_processed bigint not null default 0,
  duration_ms integer,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index workflow_runs_org_id_started_at_idx
  on public.workflow_runs (org_id, started_at desc);
create index workflow_runs_workflow_id_idx on public.workflow_runs (workflow_id);

alter table public.workflow_runs enable row level security;

create policy "workflow_runs_select_members"
  on public.workflow_runs for select
  using (private.is_member(org_id));

-- No insert/update/delete policies, and no grants beyond select: runs are
-- written exclusively by the worker via the service_role key, which
-- bypasses RLS entirely and needs no explicit grant.
grant select on public.workflow_runs to authenticated;
