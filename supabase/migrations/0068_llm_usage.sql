-- 0068_llm_usage.sql
-- Console v2: dashboard + LLM token usage. Two tables:
--
--   1. public.llm_usage — one append-only row per LLM call (apps/worker's
--      gatewayClient.ts and apps/api's copilot/gatewayClient.ts both write
--      here via the shared usage recorder, never the client directly).
--      Never updated after insert. Deliberately carries NO prompt/response
--      content column — this table exists for cost/volume observability
--      only, never for replaying or auditing what was actually said (see
--      docs/plans/console-plan.md's "never customer content" principle).
--      org_id/owner_user_id xor, same shape as usage_events
--      (0066_usage_events.sql) — an individual workspace's calls are scoped
--      by owner_user_id, an org's by org_id. `user_id` is separate from
--      `owner_user_id`: it's the specific acting user on an org-scoped call
--      (e.g. who triggered a copilot turn or a mapping/cleaning proposal),
--      nullable because some org-scoped calls (e.g. a scheduled run's
--      chat-less pipeline nodes) have no single acting user. `run_id` is
--      deliberately NOT a foreign key: it holds either a workflow_runs.id
--      (ETL-triggered features) or a chat pipeline's jobId (no backing
--      table — see chat/state.ts), and the two aren't a single FK target.
--      `usage_known=false` marks a row where the call was aborted/cut off
--      before the gateway reported a token count (e.g. a cancelled stream)
--      — token columns must be null in that case, enforced below. Zero
--      grant to authenticated/anon (same posture as platform_staff,
--      0039_platform_staff.sql): this is a staff-only table, read only via
--      the Console API's withServiceRole connection, written only by
--      apps/worker/apps/api's own service-role DB connections.
--
--   2. public.model_prices — editable per-model price catalog, history kept
--      via new rows rather than updates (append-only, same spirit as
--      plans/0049_plans_table.sql's catalog shape but versioned over time
--      instead of a single current row per model). Cost for a given
--      llm_usage row is computed by joining to the model_prices row with
--      the latest effective_from <= that row's occurred_at — done in SQL
--      by the Console API, never in JS. Same zero-grant posture: only
--      staff (via Console API CRUD) and service_role ever touch this.

create table public.llm_usage (
  id            uuid primary key default gen_random_uuid(),
  occurred_at   timestamptz not null default now(),
  org_id        uuid references public.organizations (id) on delete cascade,
  owner_user_id uuid references public."user" (id),
  user_id       uuid references public."user" (id),
  workflow_id   uuid references public.workflows (id) on delete set null,
  run_id        uuid,
  feature       text not null,
  model         text not null,
  input_tokens  integer,
  output_tokens integer,
  cached_tokens integer,
  total_tokens  integer,
  latency_ms    integer not null,
  status        text not null check (status in ('ok', 'error', 'aborted')),
  usage_known   boolean not null default true,
  error_code    text
);

alter table public.llm_usage add constraint llm_usage_org_xor_owner check (
  (org_id is not null and owner_user_id is null) or (org_id is null and owner_user_id is not null)
);

-- A row with usage_known = false (aborted/cut-off before the gateway
-- reported a count) must not carry fabricated token numbers.
alter table public.llm_usage add constraint llm_usage_usage_known_tokens check (
  usage_known = true
  or (input_tokens is null and output_tokens is null and cached_tokens is null and total_tokens is null)
);

comment on table public.llm_usage is
  'Append-only LLM call ledger (Console v2 token usage page). No prompt/'
  'response content column by design — see docs/plans/console-plan.md''s '
  '"never customer content" principle. Written only via the shared usage '
  'recorder from apps/worker''s and apps/api''s service-role DB connections. '
  'Zero grant to authenticated/anon, same posture as platform_staff '
  '(0039_platform_staff.sql) — read only via the Console API.';

comment on column public.llm_usage.run_id is
  'Not a foreign key: holds a workflow_runs.id for ETL-triggered features '
  'or a chat pipeline''s jobId (no backing table) depending on the call '
  'site, and the two share no single FK target.';

comment on column public.llm_usage.usage_known is
  'False when the call was aborted/cut off before the gateway reported a '
  'token count (e.g. a cancelled stream) — token columns are null in that '
  'case, enforced by llm_usage_usage_known_tokens.';

create index llm_usage_occurred_at_idx on public.llm_usage (occurred_at);
create index llm_usage_org_id_occurred_at_idx on public.llm_usage (org_id, occurred_at) where org_id is not null;
create index llm_usage_owner_user_id_occurred_at_idx on public.llm_usage (owner_user_id, occurred_at) where owner_user_id is not null;
create index llm_usage_model_idx on public.llm_usage (model);
create index llm_usage_feature_idx on public.llm_usage (feature);

alter table public.llm_usage enable row level security;

-- No policies, no grants to authenticated/anon at all — staff-only via
-- service_role (Console API's withServiceRole), same posture as
-- platform_staff. service_role already has full access via
-- docker/local-postgres-bootstrap.sql's default privileges.

create table public.model_prices (
  id                  uuid primary key default gen_random_uuid(),
  model               text not null,
  input_price_per_1m  numeric(12, 6) not null,
  output_price_per_1m numeric(12, 6) not null,
  cached_price_per_1m numeric(12, 6),
  currency            text not null default 'USD',
  effective_from      timestamptz not null default now(),
  created_by          uuid references public."user" (id),
  created_at          timestamptz not null default now()
);

comment on table public.model_prices is
  'Per-model price catalog for Console v2 cost estimates. History kept via '
  'new rows, never updates — a usage row''s cost is computed by joining to '
  'the model_prices row with the latest effective_from <= occurred_at for '
  'that model (computed in SQL by the Console API, never in JS). Staff-only '
  'CRUD via the Console API; zero grant to authenticated/anon.';

create index model_prices_model_effective_from_idx on public.model_prices (model, effective_from desc);

alter table public.model_prices enable row level security;

-- No policies, no grants to authenticated/anon — same staff-only,
-- service_role-only posture as llm_usage above.
