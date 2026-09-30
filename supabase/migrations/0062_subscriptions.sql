-- 0062_subscriptions.sql
-- Subscription Phase 4, Slice 1, step 2 (docs/plans/subscription-model.md's
-- payments build order): the subscriptions table itself.
--
-- One row per subscription lifecycle event (a canceled/expired
-- subscription is never overwritten in place; a new checkout creates a
-- new row) rather than a single mutable per-org/per-user record — same
-- keep-history-not-overwrite posture as workflow_runs.
--
-- org_id/owner_user_id follow this project's standard xor-scope pattern
-- (see e.g. connections.org_id/owner_id, 0007_connectors.sql) rather than
-- the separate-table pattern org_plan/owner_plan used: those are 1:1
-- default-override rows keyed by their own natural PK, but a subscription
-- is neither 1:1 nor a simple override — an org/user can have several
-- subscription rows over its lifetime (canceled, then resubscribed).
--
-- Amounts live on invoices (0063), not here — this table is the
-- lifecycle/entitlement record, not a ledger.
--
-- RLS enabled with a read-only policy now (billing.view in can.ts already
-- includes every role, individual through viewer) so a later checkout UI
-- slice has something to query against without its own follow-up RLS
-- migration. No insert/update/delete policy: writes are service_role/the
-- webhook-processing RPC only (a later slice) — same "RLS enabled, zero
-- write policies" posture org_plan (0042_org_plan.sql) started with.

create table public.subscriptions (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid references public.organizations (id) on delete cascade,
  owner_user_id             uuid references public."user" (id) on delete cascade,
  plan_id                   text not null references public.plans (id),
  provider                  text not null,
  provider_subscription_id  text,
  provider_customer_id      text,
  status                    text not null,
  seats                     integer,
  current_period_start      timestamptz,
  current_period_end        timestamptz,
  cancel_at_period_end      boolean not null default false,
  grace_until               timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint subscriptions_org_xor_owner check (
    (org_id is not null and owner_user_id is null)
    or (org_id is null and owner_user_id is not null)
  ),
  constraint subscriptions_status_check check (
    status in ('trialing', 'active', 'past_due', 'paused', 'canceled')
  ),
  constraint subscriptions_provider_check check (provider in ('razorpay', 'stripe'))
);

comment on table public.subscriptions is
  'One row per subscription lifecycle (never overwritten across a'
  ' cancel/resubscribe cycle — a new checkout creates a new row).'
  ' org_id/owner_user_id are mutually exclusive, same xor-scope pattern as'
  ' connections/projects/workflows. seats is Team-only (null for'
  ' individual/Free/Pro). grace_until is set on the first failed-payment'
  ' webhook (subscription-model.md: 7-day grace before pausing schedules).'
  ' Written only by service_role/the webhook-processing RPC, never by a'
  ' client directly.';

create index subscriptions_org_id_idx on public.subscriptions (org_id) where org_id is not null;
create index subscriptions_owner_user_id_idx on public.subscriptions (owner_user_id) where owner_user_id is not null;
create unique index subscriptions_provider_subscription_id_idx
  on public.subscriptions (provider, provider_subscription_id)
  where provider_subscription_id is not null;

alter table public.subscriptions enable row level security;

grant select on public.subscriptions to authenticated;

create policy "subscriptions_select_scoped"
  on public.subscriptions for select
  using (
    (org_id is not null and private.is_member(org_id))
    or (owner_user_id is not null and owner_user_id = auth.uid())
  );
