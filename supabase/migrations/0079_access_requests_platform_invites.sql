-- 0079_access_requests_platform_invites.sql
-- Email Phase 3: Access Requests + Invites.
--
-- SIGNUP_MODE=request (apps/web) gates new-account creation behind an
-- allowlist, enforced server-side by packages/auth/src/config.ts's
-- `user.validateUserInfo` hook (see apps/web/src/lib/auth/signupGate.ts).
-- An email is allowed to sign up if it has an `approved` row here, or a
-- `pending`+unexpired row in platform_invites, or (for org invites, which
-- aren't email-bound) a short-lived Redis flag set by the signup Server
-- Action after it validates an invite_links token out-of-band. See
-- docs/plans — no separate plan doc written for this yet, see the PR
-- description.
--
-- Both tables are staff-only data: RLS enabled with zero policies, same
-- posture as platform_staff (0039)/staff_audit_log (0040) — no
-- authenticated/anon grant at all, not even read. All access goes through
-- withServiceRole() from trusted backend code: apps/api's console routes
-- (staff reads/writes, via requireStaff), and a handful of apps/web
-- Server Actions that run before any session exists (the public request
-- form) or that only ever read a single row by exact token hash (the
-- signup gate, the accept-invite flow). This matches the current
-- (post-Supabase-migration) convention observed in apps/api/src/routes/
-- console.ts's own mutations (plain parameterized insert/update inside
-- withServiceRole, no SECURITY DEFINER RPC wrapper) rather than
-- invite_links' (0058) older RPC-only pattern.
--
-- plan_id/grant_plan_id are `text` (not uuid) to match public.plans.id's
-- actual type (0049_plans_table.sql) and mirror org_plan/owner_plan's
-- grant_plan_id columns (0078_console_copilot_rows_overrides.sql) exactly.

create type access_request_status as enum ('pending', 'approved', 'rejected');

create table public.access_requests (
  id                uuid primary key default gen_random_uuid(),
  email             text not null,
  full_name         text not null,
  company           text not null,
  job_role          text,
  use_case          text not null,
  data_sources      text[] not null default '{}',
  referral_source   text,
  consent_at        timestamptz not null default now(),
  status            access_request_status not null default 'pending',
  rejected_reason   text,
  plan_id           text references public.plans (id),
  grant_plan_id     text references public.plans (id),
  grant_expires_at  timestamptz,
  reviewed_by       uuid references public."user" (id),
  reviewed_at       timestamptz,
  signed_up_user_id uuid references public."user" (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.access_requests is
  'Public "Request access" submissions (Email Phase 3). One row per email '
  '(resubmitting after a rejection flips the same row back to pending — '
  'see the ON CONFLICT upsert in apps/web/src/lib/accessRequests/actions.ts '
  '— rather than ever creating a second row for the same email). Staff-only: '
  'RLS enabled, zero policies. Read/written exclusively via withServiceRole.';
comment on column public.access_requests.data_sources is
  'Checkbox selections from the request form, e.g. {sqlserver,mysql,postgres,mongodb,supabase,other}. Free-text list, not an enum — the form''s own options are the only validation.';
comment on column public.access_requests.consent_at is
  'When the requester checked the consent box — the box is required at submission time (app-level validation), this column is provenance, not a nullable/optional flag.';
comment on column public.access_requests.plan_id is
  'Base plan chosen by staff at approval time, applied to owner_plan once the requester actually signs up (packages/auth/src/config.ts''s databaseHooks.user.create.after). Null = leave the signup default plan alone.';
comment on column public.access_requests.grant_plan_id is
  'Optional temporary grant plan chosen at approval, same semantics as org_plan/owner_plan.grant_plan_id (0078). Only meaningful together with grant_expires_at.';
comment on column public.access_requests.signed_up_user_id is
  'Set once the approved requester actually completes signup, purely for traceability in the Console detail view — nothing reads this to drive behavior.';

create unique index access_requests_email_key on public.access_requests (lower(email));
create index access_requests_status_created_at_idx on public.access_requests (status, created_at desc);

alter table public.access_requests enable row level security;

create type platform_invite_status as enum ('pending', 'accepted', 'revoked');

create table public.platform_invites (
  id                uuid primary key default gen_random_uuid(),
  email             text not null,
  name              text,
  token_hash        text not null,
  status            platform_invite_status not null default 'pending',
  note              text,
  plan_id           text references public.plans (id),
  grant_plan_id     text references public.plans (id),
  grant_expires_at  timestamptz,
  invited_by        uuid not null references public."user" (id),
  expires_at        timestamptz not null default (now() + interval '7 days'),
  accepted_at       timestamptz,
  accepted_user_id  uuid references public."user" (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.platform_invites is
  'Staff-initiated direct platform invites (Email Phase 3) — distinct from '
  'public.invite_links (0058), which are org-scoped and not email-bound. '
  'token_hash is sha256(raw token), same convention as invite_links; the '
  'raw token only ever appears in the one-time email link. "Expired" is '
  'computed at read time (status=''pending'' and expires_at < now()), not '
  'stored, so resend/revoke never needs to race a background job. '
  'Staff-only: RLS enabled, zero policies.';
comment on column public.platform_invites.email is
  'The one email allowed to accept this invite — checked case-insensitively against the signup form''s email at signup time (apps/web/src/lib/auth/actions.ts''s signup()), unlike invite_links'' advisory-only email_domain.';
comment on column public.platform_invites.expires_at is
  'Defaults to 7 days out (spec). Resend extends this on the same row rather than creating a new one.';
comment on column public.platform_invites.accepted_user_id is
  'Set by apps/web/src/lib/platformInvites/actions.ts''s acceptPlatformInvite() once the invited email actually signs up and visits /accept-invite/<token>.';

create unique index platform_invites_token_hash_key on public.platform_invites (token_hash);
-- At most one *pending* invite per email — resend reuses this same row
-- instead of creating a new one; a prior accepted or revoked row for the
-- same email doesn't block a fresh invite. Deliberately NOT narrowed to
-- "and expires_at >= now()": a partial index's predicate is only
-- evaluated at write time, not continuously, so a volatile now() clause
-- here would leave a stale index entry for an expired-but-still-'pending'
-- row once real time moves past its expires_at — blocking a legitimate
-- re-invite. "Expired" stays a read-time-only concept (status still
-- 'pending', expires_at < now()); re-inviting an expired row updates the
-- same row (bumping expires_at) rather than inserting a new one.
create unique index platform_invites_active_email_key
  on public.platform_invites (lower(email))
  where status = 'pending';
create index platform_invites_status_created_at_idx on public.platform_invites (status, created_at desc);

alter table public.platform_invites enable row level security;
