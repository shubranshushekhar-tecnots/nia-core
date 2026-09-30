-- 0063_invoices.sql
-- Subscription Phase 4, Slice 1, step 3: invoices/payments. Scope is
-- derived from the parent subscription (no separate org_id/owner_user_id
-- columns here — avoids a second xor constraint that would need to stay
-- in sync with the subscription's own). Amounts are integer minor units
-- (paise/cents), per CONVENTIONS.md's money rule — never floats.
--
-- RLS mirrors subscriptions: read-only for the scoped org/user, no
-- client write policy — service_role/the webhook-processing RPC only.

create table public.invoices (
  id                    uuid primary key default gen_random_uuid(),
  subscription_id       uuid not null references public.subscriptions (id) on delete cascade,
  amount_minor          integer not null,
  currency              text not null,
  gst_amount_minor      integer,
  gstin                 text,
  provider              text not null,
  provider_invoice_id   text,
  provider_payment_id   text,
  status                text not null,
  created_at            timestamptz not null default now(),
  constraint invoices_status_check check (status in ('pending', 'paid', 'failed', 'refunded')),
  constraint invoices_provider_check check (provider in ('razorpay', 'stripe'))
);

comment on table public.invoices is
  'One row per payment/invoice event against a subscription.'
  ' amount_minor/gst_amount_minor are integer minor units (paise), never'
  ' floats (CONVENTIONS.md). Written only by service_role/the'
  ' webhook-processing RPC. gstin is the payer''s GSTIN when supplied at'
  ' checkout, not this company''s own.';

create index invoices_subscription_id_idx on public.invoices (subscription_id);
create unique index invoices_provider_invoice_id_idx
  on public.invoices (provider, provider_invoice_id)
  where provider_invoice_id is not null;

alter table public.invoices enable row level security;

grant select on public.invoices to authenticated;

create policy "invoices_select_scoped"
  on public.invoices for select
  using (
    exists (
      select 1 from public.subscriptions s
      where s.id = invoices.subscription_id
        and (
          (s.org_id is not null and private.is_member(s.org_id))
          or (s.owner_user_id is not null and s.owner_user_id = auth.uid())
        )
    )
  );
