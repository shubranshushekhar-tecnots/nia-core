# nia-core

## Overview
Data-workflow SaaS. Turborepo + pnpm monorepo, Supabase (Postgres + Auth) as
the backend, RLS as the sole authorization boundary (server code never
re-implements access checks — it trusts Postgres RLS).

**Stack:** Next.js 15 App Router (`apps/web`), BullMQ/ioredis worker
(`apps/worker`), Supabase Postgres/Auth, Zustand (client UI state only),
inline `CSSProperties` design-token styles (no Tailwind, no CSS-in-JS lib).

## Key files
- `supabase/migrations/*.sql` — forward-only, additive migrations. RLS
  policies + `SECURITY DEFINER` helpers live in a `private` schema with
  `search_path=''` pinned. Never edit a past migration in place — add a new
  one.
- `supabase/tests/rls_probes.sql` — RLS regression suite. Wrapped in
  `begin; ... rollback;` so it never persists data. Run with
  `supabase db query --linked --file supabase/tests/rls_probes.sql`.
- `packages/schemas/src/can.ts` — `ActorRole` (`individual | member | admin |
  owner`) capability matrix. UI-gating convenience only; RLS is the real
  enforcement. Roles separate GOVERNANCE from WORK: every role can do every
  piece of building work (install/uninstall connectors, create/update/
  delete/test connections, create/rename/delete projects and workflows,
  edit workflow definitions, run workflows, mint/revoke grants) — `member`
  is NOT restricted on any of those. Only org/member/billing/audit-log
  actions stay admin/owner-gated. This means `can()`/`assertCan()`
  currently gate nothing outside org-governance; don't "fix" that by
  re-restricting member on work actions — it's intentional (see can.ts's
  DECISION-C comment). Because of this, the audit log is load-bearing: it's
  the only record of who installed/deleted/minted what.
- `apps/web/src/lib/auth/session.ts` — `requireUser()` (org-optional;
  org-less users are `role: "individual"`, personal workspace) and
  `requireUserWithOrg()` (thin wrapper, redirects org-less users to
  `/onboarding`; only for routes that truly require an org).
- `apps/web/src/lib/dashboard/queries.ts` / `actions.ts` — all take a
  `WorkspaceScope = { orgId: string } | { ownerId: string }` (or
  `orgId: string | null`) and branch org-scoped vs personal-workspace reads
  the same way the RLS policies do (mirror, don't duplicate, the DB logic).
- `apps/web/src/app/app/**` — the post-login dashboard (`/app`,
  `/app/connections`, `/app/billing`), each a Server Component composing
  `AppShell` + `Sidebar` + `TopBar`.
- `packages/ui/src/theme.css` — design tokens, scoped via `[data-app-theme]`
  / `[data-auth-theme]` + `data-om-theme="light"|"dark"`. The app shell
  (`AppShell.tsx`) is light-only by design; the auth screens still have a
  dark/light toggle.

## Development
```
pnpm install
pnpm --filter @nia/web typecheck
cd apps/web && ./node_modules/.bin/next dev -p 3100   # see note below
cd apps/web && PORT=3100 npx playwright test
```
Migrations: `supabase link` once, then `supabase db push` (review the SQL
first) and `supabase migration list` to confirm remote sync.

**Dev server note:** never start `next dev` with a backgrounded/detached
process tied to the current session — it dies when the session ends. Run it
as a plain foreground command from `apps/web/` (the IDE routes long-running
foreground commands to a persistent terminal). Standardized on port 3100.

## Conventions
- Server-side RLS is the only trust boundary. `can()`/`assertCan()` in
  `can.ts` is a UI/DX convenience, never the last line of defense.
- Every `lib/dashboard/*` function takes an explicit workspace scope
  (org or personal) rather than assuming an org exists.
- Styles are colocated per feature in a `styles.ts` exporting
  `CSSProperties` objects, using CSS custom properties from `theme.css` —
  never hardcoded hex or literal font names.
- e2e tests (`apps/web/e2e/`) avoid creating real Supabase auth sessions ad
  hoc (no service-role key available by design); tests that need one are
  written but `test.skip`/documented until a seeded test account exists
  out-of-band.

## Common tasks
- **Add a migration:** new `NNNN_description.sql` in `supabase/migrations/`,
  additive only. Add matching probes to `supabase/tests/rls_probes.sql`.
- **Add a capability:** extend the matrix in `packages/schemas/src/can.ts`,
  then mirror the same rule in the relevant table's RLS policy.
- **Add an `/app` page:** follow `apps/web/src/app/app/connections/page.tsx`
  as the template (`requireUser()` → `WorkspaceScope` → `AppShell` +
  `Sidebar` + `TopBar`).
