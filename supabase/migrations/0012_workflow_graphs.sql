-- 0012_workflow_graphs.sql
-- Builder canvas persistence — Phase 5 Session 1. One row per workflow,
-- versioned for optimistic concurrency (two tabs autosaving the same
-- canvas). This is a REPLACEMENT for the ad hoc workflows.definition jsonb
-- column (0006_workflow_definition.sql), which was a { nodes, wires }
-- shape hand-maintained by the old WorkflowCanvas.tsx (5 node kinds, flat
-- x/y, tuple wires, a hardcoded node catalog). definition itself is left
-- untouched here — still readable, no longer written by the new canvas —
-- pending an explicit later migration to drop it once the new canvas has
-- fully proven out (see the app-layer migration script for how existing
-- rows are best-effort carried over into the new shape).
--
-- Ownership: workflow_graphs deliberately does NOT denormalize org_id.
-- workflows.org_id is nullable (personal/individual-workspace workflows
-- use owner_id instead, per 0005_individual_workspace.sql) — a NOT NULL
-- org_id here would silently break graph persistence for every personal
-- workflow. Instead this introduces private.can_access_workflow(), a
-- single helper that resolves access via the parent workflows row (org
-- membership OR personal ownership). Every future workflow-child table
-- should reuse this helper rather than re-deriving org_id/owner_id
-- locally — it is the one place that logic lives now.
--
-- Audit note (raised during review): checked whether workflow_runs (0002)
-- was left with a NOT NULL org_id after 0005 added personal workspaces.
-- It was not — 0005 section 3 already dropped `not null` from
-- workflow_runs.org_id and added owner_id + the same xor check/RLS
-- OR-branch as projects/workflows. No conflict; nothing to fix there.

-- =========================================================================
-- 1. private.can_access_workflow — shared workflow-child access helper
-- =========================================================================

create or replace function private.can_access_workflow(p_workflow uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.workflows w
    where w.id = p_workflow
      and (
        (w.org_id is not null and private.is_member(w.org_id))
        or (w.org_id is null and w.owner_id = auth.uid())
      )
  );
$$;

revoke execute on function private.can_access_workflow(uuid) from public, anon, authenticated;
grant execute on function private.can_access_workflow(uuid) to authenticated;

-- =========================================================================
-- 2. workflow_graphs
-- =========================================================================

create table public.workflow_graphs (
  workflow_id uuid primary key references public.workflows (id) on delete cascade,
  -- Server-side Zod-parsed (packages/schemas GraphDoc) on every write — this
  -- column never stores anything the schema didn't bless. Postgres only
  -- enforces "is valid jsonb", not the GraphDoc shape.
  graph jsonb not null default '{"nodes":[],"edges":[]}'::jsonb,
  -- Optimistic concurrency: the API's UPDATE always includes
  -- `where version = :expected` and sets `version = version + 1`; zero rows
  -- affected means a 409 (another tab/save won the race) back to the client.
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.workflow_graphs enable row level security;

create trigger workflow_graphs_set_updated_at
  before update on public.workflow_graphs
  for each row
  execute function public.set_updated_at();

-- Server-side version-increment guarantee (raised during review): RLS lets
-- any authorized member UPDATE this row directly via PostgREST, and
-- WITH CHECK can't reference OLD — so a policy alone can't stop a client
-- from setting `version` to an arbitrary value or leaving it unchanged
-- while still changing `graph`, silently defeating optimistic concurrency
-- for every other writer. This trigger makes the increment invariant hold
-- unconditionally, independent of what any client (API included) supplies:
-- whatever NEW.version arrives with is discarded and replaced with
-- OLD.version + 1 whenever NEW.graph actually differs from OLD.graph; if
-- graph is unchanged, version is left alone. The API's own conditional
-- `UPDATE ... WHERE version = :expected` (0 rows affected -> 409) is still
-- the mechanism that decides *whether* a write proceeds — this trigger
-- only guarantees that a write which does proceed always bumps version by
-- exactly 1, no matter who issued it.
create or replace function private.bump_workflow_graph_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.graph is distinct from old.graph then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end;
$$;

revoke execute on function private.bump_workflow_graph_version() from public, anon, authenticated;

create trigger workflow_graphs_bump_version
  before update on public.workflow_graphs
  for each row
  execute function private.bump_workflow_graph_version();

create policy "workflow_graphs_select_access"
  on public.workflow_graphs for select
  using (private.can_access_workflow(workflow_id));

create policy "workflow_graphs_insert_access"
  on public.workflow_graphs for insert
  with check (private.can_access_workflow(workflow_id));

create policy "workflow_graphs_update_access"
  on public.workflow_graphs for update
  using (private.can_access_workflow(workflow_id))
  with check (private.can_access_workflow(workflow_id));

-- No delete policy/grant: a graph dies with its workflow via the FK
-- cascade above, never via a direct client delete.

grant select, insert, update on public.workflow_graphs to authenticated;
