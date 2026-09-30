-- 0064_processed_webhook_events.sql
-- Subscription Phase 4, Slice 1, step 4: webhook idempotency ledger.
-- Purely internal (no org/user scope, no client access at all — not even
-- read) — the same "RLS enabled, zero policies, no grant to
-- authenticated/anon" posture as org_plan (0042_org_plan.sql) started
-- with, except this table is expected to STAY that way permanently: there
-- is no product surface that should ever list raw webhook deliveries.
--
-- provider_event_id is the provider's own event id; the unique index below
-- is the actual idempotency guard a webhook handler relies on — it inserts
-- (provider, provider_event_id) in the same transaction as the state
-- update it guards, and a duplicate delivery hits a unique-violation and
-- is treated as already-processed, not re-applied.

create table public.processed_webhook_events (
  id                 uuid primary key default gen_random_uuid(),
  provider           text not null,
  provider_event_id  text not null,
  event_type         text not null,
  processed_at       timestamptz not null default now(),
  constraint processed_webhook_events_provider_check check (provider in ('razorpay', 'stripe'))
);

comment on table public.processed_webhook_events is
  'Idempotency ledger for payment-provider webhook deliveries. A handler'
  ' inserts (provider, provider_event_id) in the same transaction as the'
  ' state update it guards; the unique index below turns a duplicate'
  ' delivery into a unique-violation instead of a double-applied event. No'
  ' client access at all — service_role/postgres only, permanently (not a'
  ' placeholder to relax later).';

create unique index processed_webhook_events_provider_event_id_idx
  on public.processed_webhook_events (provider, provider_event_id);

alter table public.processed_webhook_events enable row level security;

-- Deliberately no grant to authenticated/anon and no policies at all —
-- default-deny, service_role/postgres only.
