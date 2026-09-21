-- 0021_staging_registry.sql
-- Phase 11: staging + quarantine registry, and the run's staging-table
-- pointer for resumable staged writes.
--
-- Structured-write-only rule (per Phase 11 decision, docs/decisions.md):
-- staging/quarantine objects are never touched via raw SQL issued by the
-- worker. The worker issues structured StageRequest ops (create/apply/
-- drop) carrying a signed WriteContext that names the exact staging/
-- quarantine entity; each connector independently re-verifies that HMAC
-- signature (writeSignature.ts, duplicated per-connector) and refuses to
-- CREATE, DROP, DELETE, or apply against any table the signed context
-- doesn't name. This registry is a second, independent layer on the
-- worker side ("only ever drop names in the registry") — not the sole
-- enforcement point; connector-side signed-context verification is.
--
-- No client RLS policy on staging_objects: written/read exclusively by
-- the worker's service_role Supabase client, mirroring workflow_runs
-- (0002_projects_workflows.sql) and write_grants (0016_write_grants.sql)'s
-- posture for worker-internal bookkeeping that clients never touch
-- directly.

create table public.staging_objects (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.workflow_runs(id) on delete cascade,
  connection_id uuid not null references public.connections(id) on delete cascade,
  schema_name text not null,
  object_name text not null,
  kind text not null check (kind in ('staging', 'quarantine')),
  status text not null default 'active' check (status in ('active', 'dropped')),
  created_at timestamptz not null default now(),
  dropped_at timestamptz
);

comment on table public.staging_objects is
  'Phase 11: registry of per-run staging tables and per-destination '
  'quarantine tables. Worker-only bookkeeping (service_role) — no client '
  'RLS policy, see this migration''s header comment. Connector-side '
  'signed-WriteContext verification is the primary enforcement layer for '
  'which names a connector will CREATE/DROP/apply against; this table is '
  'the worker''s own record, used to reuse staging names across resumed '
  'chunks and to sweep abandoned staging tables.';
comment on column public.staging_objects.run_id is
  'Null for quarantine rows, which are one-per-destination-database and '
  'outlive any single run. Always set for kind = ''staging''.';
comment on column public.staging_objects.kind is
  'staging: per-run table dropped after a successful apply or a terminal '
  'run failure. quarantine: long-lived per-destination-database sink '
  'table, never swept by the 24h staging sweeper.';
comment on column public.staging_objects.status is
  '''active'' until the worker records a successful drop (or, for '
  'quarantine rows, never). The 24h sweeper only considers kind = '
  '''staging'' rows with status = ''active'' and created_at older than '
  'its cutoff.';

create index staging_objects_run_id_idx on public.staging_objects(run_id);
create index staging_objects_sweep_idx on public.staging_objects(kind, status, created_at)
  where kind = 'staging' and status = 'active';
create unique index staging_objects_connection_quarantine_idx on public.staging_objects(connection_id)
  where kind = 'quarantine' and status = 'active';

-- RLS enabled with zero policies (default-deny for every non-service_role
-- caller), unlike workflow_runs' select-for-members policy: this table has
-- no client-facing read surface at all (staging/quarantine table names are
-- worker-internal plumbing, not shown in any UI today), so there is
-- nothing to grant `authenticated` here.
alter table public.staging_objects enable row level security;

alter table public.workflow_runs add column staging_table text;
comment on column public.workflow_runs.staging_table is
  'Phase 11: schema-qualified name of this run''s staging table (also '
  'registered in staging_objects), persisted so a resumed run''s chunk '
  'loop reuses the same staging table instead of creating a new one. '
  'Null for direct-mode (non-staged) runs and for staged runs before '
  'their first chunk creates the staging table.';
