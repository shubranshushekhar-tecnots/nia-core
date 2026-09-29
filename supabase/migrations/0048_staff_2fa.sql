-- Console v1 Slice 4 (docs/plans/console-plan.md §4b): staff 2FA enrollment
-- + per-session 2FA-verified stamp.
--
-- Adds Better Auth's own two-factor plugin tables/columns (schema shape
-- taken verbatim from better-auth's plugins/two-factor/schema.mjs, same
-- column-naming convention as 0035_better_auth.sql's hand-written core
-- tables: double-quoted camelCase, uuid PKs via gen_random_uuid()), plus
-- one additional column not owned by the twoFactor plugin itself —
-- session."twoFactorVerifiedAt" — added by this project's own custom
-- twoFactorSession plugin (packages/auth/src/twoFactorSession.ts) to stamp
-- the exact moment a session passed a 2FA challenge (sign-in or
-- enrollment), independent of session.expiresAt's normal rolling refresh.
--
-- No RLS changes: public.user/session/account/verification carry no RLS
-- policies (Better Auth's adapter runs over a raw pg.Pool, not PostgREST),
-- and public.twoFactor follows the same precedent — it's read only by
-- better-auth's own adapter and by manageStaff.ts's reset-2fa command,
-- both of which run outside any RLS-scoped request path.

alter table public."user"
  add column if not exists "twoFactorEnabled" boolean not null default false;

alter table public."session"
  add column if not exists "twoFactorVerifiedAt" timestamptz;

create table if not exists public."twoFactor" (
  id uuid primary key default gen_random_uuid(),
  secret text not null,
  "backupCodes" text not null,
  "userId" uuid not null references public."user"(id) on delete cascade,
  verified boolean not null default true,
  "failedVerificationCount" integer not null default 0,
  "lockedUntil" timestamptz
);

create index if not exists "twoFactor_userId_idx" on public."twoFactor"("userId");
create index if not exists "twoFactor_secret_idx" on public."twoFactor"(secret);
