-- 0066_usage_events.sql
-- Subscription model Phase 3 (docs/plans/subscription-model.md, build order
-- step 3), Slice 1: the usage-metering ledger. One row per metered event —
-- a finished ETL run's row count, or one Copilot user request — never
-- updated after insert. Monthly usage is "sum on read"
-- (sum(quantity) where occurred_at >= date_trunc('month', now())), per the
-- decision recorded in docs/plans/subscription-model.md: this is simpler
-- than a running counter table and gets idempotency for free via the
-- (kind, subject_id) unique index below, matching workflow_runs' own
-- "idempotent upsert keyed by run_id" pattern (workflowRuns.ts's startRun).
--
-- org_id/owner_id xor, same shape as workflow_runs/messages/conversations
-- since 0005_individual_workspace.sql / 0013_chat_personal_workspace.sql —
-- a personal workspace's usage is scoped by owner_id, an org's by org_id.
--
-- subject_id is the natural idempotency key per kind:
--   kind = 'rows_moved'     -> subject_id = workflow_runs.id (the run)
--   kind = 'copilot_action' -> subject_id = messages.id (the user message)
-- A stalled-job/request retry redelivering the same run/message is a safe
-- no-op insert (on conflict do nothing), never a double-count.
--
-- No insert/update/delete grant to authenticated at all — usage_events is
-- written exclusively via service_role (apps/worker records rows_moved on
-- run finish; apps/api records copilot_action right before enqueuing a chat
-- job), same "system-authored, select-only for members" posture as
-- workflow_runs (0002_projects_workflows.sql's own comment).

create table public.usage_events (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations (id) on delete cascade,
  owner_id    uuid references public."user" (id),
  kind        text not null check (kind in ('rows_moved', 'copilot_action')),
  quantity    integer not null check (quantity >= 0),
  subject_id  uuid not null,
  occurred_at timestamptz not null default now()
);

alter table public.usage_events add constraint usage_events_org_xor_owner check (
  (org_id is not null and owner_id is null) or (org_id is null and owner_id is not null)
);

-- Idempotency: one usage row per (kind, subject_id) — see header comment.
create unique index usage_events_kind_subject_id_key on public.usage_events (kind, subject_id);

-- Monthly sum-on-read queries filter by (scope, kind, occurred_at range) —
-- same index shape as workflow_runs_org_id_started_at_idx /
-- workflow_runs_owner_id_started_at_idx (0002/0005).
create index usage_events_org_id_kind_occurred_at_idx on public.usage_events (org_id, kind, occurred_at);
create index usage_events_owner_id_kind_occurred_at_idx on public.usage_events (owner_id, kind, occurred_at);

alter table public.usage_events enable row level security;

grant select on public.usage_events to authenticated;

create policy "usage_events_select_own"
  on public.usage_events for select
  using (
    (org_id is not null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

-- No insert/update/delete policies, and no grants beyond select — written
-- exclusively via service_role, same as workflow_runs.
