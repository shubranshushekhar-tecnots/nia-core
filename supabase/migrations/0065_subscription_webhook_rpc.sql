-- 0065_subscription_webhook_rpc.sql
-- Subscription Phase 4, Slice 2 (docs/plans/subscription-model.md): individual
-- Free/Legacy -> Pro checkout via Razorpay. Two new columns on subscriptions
-- plus the two RPCs that are the only writers of subscriptions/owner_plan for
-- this flow — plan changes happen exclusively inside
-- apply_subscription_webhook(), never on the checkout redirect (per the
-- slice's own instructions).
--
-- Individual-only in this slice: both RPCs below only ever touch
-- owner_user_id-scoped rows (org_id stays out of scope — a future slice's
-- concern, same "don't build what isn't asked for" posture as everywhere
-- else in this codebase).

-- =========================================================================
-- 1. New columns
-- =========================================================================

alter table public.subscriptions
  add column last_webhook_event_at timestamptz,
  add column previous_plan_id text references public.plans (id);

comment on column public.subscriptions.last_webhook_event_at is
  'Razorpay/provider''s own webhook event created_at timestamp (not local'
  ' processing time) for the most recently APPLIED event on this'
  ' subscription — guards apply_subscription_webhook() against out-of-order'
  ' delivery: an incoming event no newer than this is treated as stale and'
  ' skipped, even though its (provider, provider_event_id) is still logged'
  ' in processed_webhook_events for idempotency.';

comment on column public.subscriptions.previous_plan_id is
  'owner_plan.plan_id captured at checkout time'
  ' (create_individual_subscription()), restored on a canceled webhook event'
  ' instead of hardcoding everyone back to ''free'' — a Legacy user who'
  ' upgrades to Pro and later cancels returns to Legacy, not Free.';

-- =========================================================================
-- 2. Status vocabulary: add 'incomplete' — a checkout that has been created
--    (create_individual_subscription()) but not yet confirmed by any
--    webhook. Postgres has no ALTER CHECK; drop + re-add is the only way.
-- =========================================================================

alter table public.subscriptions drop constraint subscriptions_status_check;
alter table public.subscriptions add constraint subscriptions_status_check
  check (status in ('incomplete', 'trialing', 'active', 'past_due', 'paused', 'canceled'));

-- =========================================================================
-- 3. create_individual_subscription() — called by apps/api's checkout route
--    (as the acting user, via req.withUser) right after creating the
--    Razorpay subscription. Captures previous_plan_id from the caller's
--    current owner_plan row so a later cancellation knows what to restore.
--    Inserts status='incomplete': the row only becomes 'active' once the
--    matching webhook arrives — this function itself never touches
--    owner_plan.
-- =========================================================================

create or replace function public.create_individual_subscription(
  p_plan_id text,
  p_provider text,
  p_provider_subscription_id text,
  p_provider_customer_id text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_subscription_id uuid;
  v_previous_plan_id text;
begin
  if auth.uid() is null then
    raise exception 'must be authenticated';
  end if;

  select plan_id into v_previous_plan_id
  from public.owner_plan
  where user_id = auth.uid();

  insert into public.subscriptions (
    owner_user_id, plan_id, provider, provider_subscription_id,
    provider_customer_id, status, previous_plan_id
  )
  values (
    auth.uid(), p_plan_id, p_provider, p_provider_subscription_id,
    p_provider_customer_id, 'incomplete', coalesce(v_previous_plan_id, 'free')
  )
  returning id into new_subscription_id;

  perform private.log_audit_personal(
    auth.uid(),
    'billing.checkoutCreated',
    jsonb_build_object('subscriptionId', new_subscription_id, 'planId', p_plan_id, 'provider', p_provider)
  );

  return new_subscription_id;
end;
$$;

revoke execute on function public.create_individual_subscription(text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_individual_subscription(text, text, text, text) to authenticated;

-- =========================================================================
-- 4. apply_subscription_webhook() — the ONLY writer of subscriptions'
--    status/period/plan-affecting columns and of invoices. Called from
--    apps/api's public webhook route via withServiceRole (that route has no
--    acting user at all — a server-to-server call from Razorpay, not a
--    browser session — so this is the same "deliberate, narrow exception"
--    to apps/api's general never-withServiceRole rule already established
--    by requireStaff.ts). Lives in `public` (not `private`) specifically so
--    it inherits the EXECUTE grant to service_role that
--    docker/local-postgres-bootstrap.sql's / Supabase's own default
--    privileges apply automatically to every new function in this schema —
--    the revoke below only needs to strip the PUBLIC-role default grant
--    Postgres itself applies to every new function, not add anything back.
--
--    Idempotency: the processed_webhook_events insert is the guard — a
--    duplicate (provider, provider_event_id) hits the unique index and is
--    caught here as a no-op 'duplicate' result, same transaction as
--    everything else so a partial apply can never happen.
--
--    Ordering: last_webhook_event_at is Razorpay's own per-event
--    created_at, not local processing time — an event no newer than the
--    subscription's current value is 'stale' and skipped (but still logged
--    above for its own idempotency), so delivery order never matters for
--    final state.
-- =========================================================================

create or replace function public.apply_subscription_webhook(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_event_created_at timestamptz,
  p_provider_subscription_id text,
  p_status text,
  p_current_period_start timestamptz default null,
  p_current_period_end timestamptz default null,
  p_payment jsonb default null
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_subscription public.subscriptions%rowtype;
  v_new_plan_id text;
begin
  begin
    insert into public.processed_webhook_events (provider, provider_event_id, event_type)
    values (p_provider, p_provider_event_id, p_event_type);
  exception when unique_violation then
    return 'duplicate';
  end;

  select * into v_subscription
  from public.subscriptions
  where provider = p_provider and provider_subscription_id = p_provider_subscription_id
  for update;

  if not found then
    return 'unknown_subscription';
  end if;

  if v_subscription.last_webhook_event_at is not null
     and p_event_created_at <= v_subscription.last_webhook_event_at then
    return 'stale';
  end if;

  update public.subscriptions
  set
    status = p_status,
    current_period_start = coalesce(p_current_period_start, current_period_start),
    current_period_end = coalesce(p_current_period_end, current_period_end),
    grace_until = case
      when p_status = 'past_due' and grace_until is null then now() + interval '7 days'
      when p_status in ('active', 'canceled') then null
      else grace_until
    end,
    last_webhook_event_at = p_event_created_at,
    updated_at = now()
  where id = v_subscription.id;

  if p_payment is not null then
    insert into public.invoices (
      subscription_id, amount_minor, currency, gst_amount_minor, gstin,
      provider, provider_invoice_id, provider_payment_id, status
    )
    values (
      v_subscription.id,
      (p_payment ->> 'amountMinor')::integer,
      p_payment ->> 'currency',
      nullif(p_payment ->> 'gstAmountMinor', '')::integer,
      p_payment ->> 'gstin',
      p_provider,
      p_payment ->> 'providerInvoiceId',
      p_payment ->> 'providerPaymentId',
      p_payment ->> 'status'
    )
    on conflict (provider, provider_invoice_id) where provider_invoice_id is not null do nothing;
  end if;

  -- Plan changes only here, never on the checkout redirect. org_id-scoped
  -- subscriptions are out of scope for this slice — deliberately untouched.
  if v_subscription.owner_user_id is not null then
    if p_status = 'active' then
      v_new_plan_id := v_subscription.plan_id;
    elsif p_status = 'canceled' then
      v_new_plan_id := coalesce(v_subscription.previous_plan_id, 'free');
    else
      v_new_plan_id := null;
    end if;

    if v_new_plan_id is not null then
      update public.owner_plan
      set plan_id = v_new_plan_id, updated_at = now()
      where user_id = v_subscription.owner_user_id;
    end if;
  end if;

  return 'applied';
end;
$$;

revoke execute on function public.apply_subscription_webhook(
  text, text, text, timestamptz, text, text, timestamptz, timestamptz, jsonb
) from public, anon, authenticated;
