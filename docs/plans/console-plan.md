Yes, append your Step 1 findings to docs/plans/superadmin-discovery.md.

Then, planning only, no code. Save this prompt verbatim to docs/plans/console-plan.md.

Read designs/Nia Console (superadmin).html and produce a Console v1 plan using these decided principles:
- Staff is a separate identity: a platform_staff table (user_id, granted_by, granted_at, revoked_at), granted/revoked only via a CLI script run by existing staff — never via the app.
- Separate server routes under /console/* with a requireStaff middleware on every request. No general RLS bypass: staff reads go through explicit, read-only server queries.
- v1 capabilities: list/search orgs and users; view plan, limits and usage; view run history and errors (metadata only); view connector health. Actions: change plan/limits, suspend/unsuspend org, send password-reset link, revoke a user's sessions.
- Never: decrypted secrets, customer data rows, or impersonation (out of scope for v1).
- Append-only staff_audit_log for every staff read of an org and every action; customer-affecting actions also written to that org's audit_log.
- Staff accounts must use 2FA; shorter staff sessions.

Deliver:
1. Each screen in the design → which v1 capability it maps to, or "out of v1" (with why).
2. Data model changes (tables, columns, RLS) and migrations needed.
3. API routes with the capability check for each.
4. Whether Better Auth supports 2FA today in this setup, and what enabling it involves.
5. Build order in small steps, each independently testable.
6. Risks and open questions.
Then stop and wait. Don't commit.

---

# Console v1 Plan

## 1. Screens in `designs/Nia Console (superadmin).html` → v1 mapping

| Screen (mockup id) | Maps to v1 capability | In v1? |
|---|---|---|
| Staff sign-in (`isLogin`) — email + 2FA code | Staff auth gate (foundational, not a "capability" itself) | **In v1** — required for any of the below to exist safely |
| Platform Dashboard (`isDash`) — KPI cards, daily-runs chart, runs-by-connector donut, top-failing-connectors, export | Overlaps with "view run history/errors" and "view connector health," but as cross-org aggregate analytics/charts/export | **Out of v1** — the decided v1 scope is per-org run history and per-org connector health, not platform-wide analytics/exports. Revisit as v1.1 once the underlying per-org endpoints exist (the charts can be built on top of them later). |
| Directory (`isDirectory`) — search/filter orgs & users, type/plan filters | "List/search orgs and users" | **In v1** |
| Organization Detail (`isOrgDetail`) — org info, plan/MRR, members table, **"View as"**, **Suspend org**, **Delete org (soft/purge)**, password reset | Plan/limits/usage view, members view, suspend/unsuspend | **Partially in v1**: plan/limits/usage view ✓, suspend/unsuspend ✓, members list (read-only) ✓. **"View as" (impersonation) is out of v1** per the decided principles. **Delete org (soft-delete/purge) is out of v1**. **Password reset is out of v1** (decision 1, 2026-09-28): no email service exists, and staff generating/viewing a one-time reset link/token is functionally impersonation by another name — tracked in `TODO.md` for revisit once transactional email exists. |
| Customer/Account Detail (`isCustomerView`) — individual user, explicit "credentials never rendered / secrets not sent to this console" copy | View a user's profile, session metadata, revoke sessions | **Partially in v1**: user detail (profile, org memberships, session count/last-active) ✓, revoke sessions ✓. **Password reset dropped from v1** (decision 1 — same reasoning as above). "View as" impersonation → **out of v1**. The design's explicit "no secrets" language matches the decided "never: decrypted secrets" principle — keep as a hard constraint. |
| Revenue Dashboard (`isRevenue`) — MRR, churn, expansion, LTV/CAC | Not in the decided v1 capability list | **Out of v1** — also blocked structurally: no billing/subscription/revenue data model exists anywhere in the schema today (see §2). Would require a whole separate billing-data project. |
| Invoices (`isInvoices`) | Not in the decided v1 capability list | **Out of v1** — no invoice data model exists; would need a billing/payments integration first. |
| Notifications/Alerts (`isNotify`) | Not in the decided v1 capability list | **Out of v1** |
| Settings (`isSettings`) | Not in the decided v1 capability list (staff 2FA enrollment is handled as part of the auth flow, not a "settings" screen) | **Out of v1** |
| Support/Help (`isSupport`) | Not in the decided v1 capability list | **Out of v1** |
| Impersonation banner / "End session" (shown when `sessionOn`) | Impersonation | **Out of v1** — explicitly excluded by the decided principles; nothing in the console should be able to act *as* a customer. |

## 2. Data model changes

Current state (from discovery): there is no `platform_staff`/staff concept, no plan/subscription/usage tables, no org suspension column, and `workflow_runs` has no error-detail column. Proposed migration `0038_console_v1.sql` (single migration for v1, split into logical sections; can be split into multiple files if preferred to keep each step independently revertable — see §5):

**`platform_staff`** — who is staff, append-only-ish (rows are never deleted, only revoked):
```sql
create table public.platform_staff (
  user_id     uuid primary key references public.user (id) on delete cascade,
  granted_by  uuid not null references public.user (id),
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
```
- RLS: `alter table public.platform_staff enable row level security;` with **zero policies** — nothing is grantable to `authenticated`/`anon`. Only reachable via `service_role` (the console API's DB layer, using `withServiceRole`, per the existing `packages/db` pattern) and the CLI grant/revoke script. This matches the decided "granted/revoked only via a CLI script — never via the app."
- No UPDATE/DELETE policy either — revocation is a service-role `UPDATE ... SET revoked_at = now()` done only by the CLI script, never exposed via any route.

**`staff_audit_log`** — append-only, one row per staff read or action:
```sql
create table public.staff_audit_log (
  id             uuid primary key default gen_random_uuid(),
  staff_user_id  uuid not null references public.user (id),
  org_id         uuid references public.organizations (id),
  target_user_id uuid references public.user (id),
  action         text not null,        -- e.g. 'org.read', 'org.plan.update', 'org.suspend', 'user.revoke_sessions'
  detail         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index staff_audit_log_staff_user_id_created_at_idx
  on public.staff_audit_log (staff_user_id, created_at desc);
create index staff_audit_log_org_id_created_at_idx
  on public.staff_audit_log (org_id, created_at desc) where org_id is not null;
```
- RLS enabled, zero policies — append-only via service role only, following the same convention as `public.audit_log`'s `private.log_audit()` (0001_auth_orgs.sql:280-300): a `private.log_staff_action(...)` SECURITY DEFINER helper, not granted to `authenticated`/`anon`, called from the console's server-side service layer.
- No console screen in v1 reads this table back (not in the decided v1 capability list) — it exists purely as the audit trail; direct DB inspection is the only "read" path for now.

**`org_plan`** — new, since no plan/subscription/usage schema exists at all today. Corrected per decision 6 (2026-09-28): the *only* thing that currently exists to preserve is `apps/web/src/lib/billing/plan.ts`'s hardcoded `getPlanUsage()`, which returns `{ plan: 'Pro', limit: 25 }` (a workflow-count limit) for every org — there is no seat limit or run limit anywhere today, so this table must not invent columns with no current default to backfill from:
```sql
create table public.org_plan (
  org_id          uuid primary key references public.organizations (id) on delete cascade,
  plan_tier       text not null default 'Pro',
  workflow_limit  integer,      -- null = unlimited; matches getPlanUsage()'s existing "limit" semantics
  updated_at      timestamptz not null default now(),
  updated_by      uuid references public.user (id)
);
```
- Backfill (same migration): `insert into public.org_plan (org_id, plan_tier, workflow_limit) select id, 'Pro', 25 from public.organizations;` — this exactly reproduces today's hardcoded `getPlanUsage()` behavior for every existing org, so no org's effective limit changes the moment this migration runs.
- **Test required by decision 6**: a migration/integration test asserting that for every pre-existing org, `org_plan.plan_tier = 'Pro'` and `org_plan.workflow_limit = 25` after backfill — i.e. proving the new explicit table reproduces the old implicit constant exactly.
- `run_limit`/`seat_limit` columns from the earlier draft of this plan are dropped — nothing today enforces or even displays a run or seat limit, so there is no "current limit" to preserve for them; can be added later if a real need appears.
- RLS enabled, **zero policies for v1** — only the console (service role) reads/writes it. (Wiring a customer-facing "your plan" view would need a `private.is_member(org_id)` SELECT policy later; deliberately deferred — see open questions.)
- "Usage" itself is **not stored** — computed on read from `workflow_runs` (count in current period) via `organization_members` if seat usage is ever added later, avoiding a duplicate/driftable counter.

**`organizations` — suspension columns:**
```sql
alter table public.organizations
  add column suspended_at     timestamptz,
  add column suspended_by     uuid references public.user (id),
  add column suspended_reason text;
```
- No RLS change needed for the column itself (existing SELECT policy already covers it for members).
- **Enforcement semantics, decided (decision 2, 2026-09-28):** suspension blocks every API request for that org with a clear `403 { error: "organization suspended" }`; it blocks new runs including scheduled/queued ones; **in-flight runs finish normally** (never killed mid-run). This is enforced in two separate places, each with its own test:
  1. Shared API request path (likely `attachActor`/`requireOrgActor` in `apps/api/src/middleware/actor.ts`) — short-circuits to 403 before any route handler runs, for the actor's org.
  2. `apps/worker` dispatch path — the run-dispatch entrypoint (`apps/worker/src/lib/etl/...`, exact hook TBD at that build step) must check org suspension **before** starting a new run (covers both a manually-triggered run and anything pulled off a schedule/queue) and refuse to start it; a run already executing when suspension happens is explicitly left alone to finish.
  - Per decision 5 below, touching `apps/worker` requires telling the user first — this enforcement step (build order step, see §5) will do so before any worker code changes.

**`workflow_runs` — error metadata column:**
```sql
alter table public.workflow_runs
  add column error jsonb;  -- e.g. {"code": "...", "message": "..."} — metadata only, never row-level customer data
```
- **Research required by decision 5 (2026-09-28), completed:** checked whether `/explain`'s `explain_last_error` copilot tool already surfaces run errors from somewhere reusable. It does not — `apps/api/src/copilot/tools/explainLastError.ts` explicitly documents that `workflow_runs` has no persisted failure-message column and that the original error text is only ever streamed live over the run's SSE connection (`apps/worker/src/lib/etl/publish.ts`, Redis pub/sub with a TTL) and never persisted; `apps/worker/src/lib/etl/runEtl.ts`'s `fail()` and `apps/worker/src/lib/etl/workflowRuns.ts`'s `finishRun()` only ever set `status`/`finished_at`/`duration_ms`, never the error text. **Conclusion: nothing reusable exists — this column and a small `apps/worker` change genuinely are necessary.** Per decision 5, the build-order step that adds this (§5) will explicitly ask for go-ahead before touching `apps/worker`, rather than doing it silently as part of a larger PR.
- Populated by `apps/worker`'s existing failure path when it sets `status = 'failed'` (in `runEtl.ts`'s `fail()` / `workflowRuns.ts`'s `finishRun()`).

## 3. API routes (`apps/api/src/routes/console.ts`, mounted at `/console`)

All routes: `consoleRouter.use(requireAuth, attachDb, requireStaff)` (new `requireStaff` middleware checks `platform_staff` for the current user via a service-role query, `revoked_at is null`; throws 403 otherwise). Every GET writes one `staff_audit_log` row per org/user touched (`action: '<resource>.read'`); every mutating route writes one `staff_audit_log` row **and**:
- when the action targets a specific org (plan change, suspend/unsuspend), also calls the existing `private.log_audit(org_id, action, detail)` RPC so it shows up in that org's own audit log;
- when the action targets a *user* rather than a single org (decision 4, 2026-09-28 — e.g. revoke-sessions), it is written to the `audit_log` of **every org the target user belongs to** (queried via `organization_members` for that `user_id`), since the action is potentially customer-affecting for all of them, not just one. If the user belongs to zero orgs (individual workspace), only `staff_audit_log` gets the row.

| Route | Capability | Notes |
|---|---|---|
| `GET /console/orgs` | List/search orgs | query params: `search`, `plan`, `cursor`; explicit `SELECT` joining `organizations` + `org_plan`, no `SELECT *` |
| `GET /console/orgs/:orgId` | Org detail: profile, plan/limits, usage summary, members (read-only) | usage computed via `workflow_runs`/`organization_members` counts scoped to `:orgId` |
| `GET /console/orgs/:orgId/runs` | Run history + error metadata | reads `workflow_runs.status/error/started_at/finished_at`, never touches result rows/customer data |
| `GET /console/orgs/:orgId/connectors` | Connector health | reads existing `connections.last_test_status/last_test_at/last_test_latency_ms` — no new health model needed for v1 |
| `GET /console/users` | List/search users | query params: `search`; explicit `SELECT` from `public.user` |
| `GET /console/users/:userId` | User detail: profile, org memberships, session count/last-active | session **metadata only** (count, most recent `createdAt`/`ipAddress`/`userAgent`) — never the session token |
| `PATCH /console/orgs/:orgId/plan` | Change plan/limits | body: `{ plan_tier, workflow_limit }` (corrected per decision 6, §2); writes `org_plan` + both audit logs |
| `POST /console/orgs/:orgId/suspend` | Suspend org | body: `{ reason }`; sets `suspended_at/by/reason`; writes both audit logs |
| `POST /console/orgs/:orgId/unsuspend` | Unsuspend org | clears the three columns; writes both audit logs |
| `POST /console/users/:userId/revoke-sessions` | Revoke a user's sessions | **Finalized per decision 3 (2026-09-28):** raw `DELETE FROM public.session WHERE "userId" = $1` via service role, not better-auth's `admin` plugin API. Researched both options — better-auth 1.7.6 *does* have a native `revokeUserSessions` server API, but only inside the `admin` plugin, which bundles it together with impersonate-user, ban-user and setRole as live HTTP endpoints the moment the plugin is enabled. That conflicts directly with the decided "never: impersonation" principle — enabling the plugin would put an impersonation endpoint on the wire even if console code never calls it. A raw service-role `DELETE` gets the same effect (session rows deleted → subsequent requests with that session's cookie/bearer token fail auth) without adding any new endpoint surface. Writes `staff_audit_log` + the target user's every-org `audit_log` entries (decision 4). |

**Dropped from v1 (decision 1, 2026-09-28):** `POST /console/users/:userId/password-reset` is removed entirely — no email service exists, and staff generating/viewing a one-time reset link/token would be impersonation by another name. Tracked in `TODO.md` for revisit once transactional email exists.

No separate `/console/auth/login` route — staff use the existing better-auth sign-in; `requireStaff` (and the 2FA/session-duration hooks in §4) are what make that session "a staff session," not a different login endpoint.

## 4. Better Auth 2FA feasibility — spike findings (decision 7, 2026-09-28)

Current version: `better-auth@^1.7.6` (`packages/auth/package.json:20`). No `twoFactor` plugin is currently imported or configured anywhere (`packages/auth/src/config.ts`). This section reports the spike outcome per decision 7 — **report only, no implementation**, per the instruction to stop before building on it.

**2FA is per-user, not per-role — and that's actually the right primitive, not a gap.** Read `better-auth/dist/plugins/two-factor/index.d.mts` directly: the `twoFactor()` plugin adds a `user.twoFactorEnabled` boolean column (default `false`) and a separate `twoFactor` table (`secret`, `backupCodes`, `userId`, plus lockout fields). Enrollment is opt-in per user — enabling the plugin does **not** force 2FA on anyone who hasn't set it up. Sign-in for a user with `twoFactorEnabled = true` returns a `twoFactorRedirect` flag instead of immediately issuing a full session, requiring a follow-up `/two-factor/verify-totp` (or `verify-otp`) call. Net effect: turning the plugin on has **zero effect on existing customers** unless they opt in themselves. "Staff-only 2FA" then just means: (a) enroll every `platform_staff` row in 2FA via the plugin's own enroll flow (no custom fork of the plugin needed), and (b) `requireStaff` additionally checks `user.twoFactorEnabled === true`, refusing console access for any staff account that hasn't completed enrollment — enforcement lives in the console's own middleware, not in a patched auth core.

**Shorter staff sessions are also achievable with an existing, confirmed mechanism.** Read `better-auth/dist/db/with-hooks.mjs` directly: `databaseHooks[model].create.before` is a **generic mechanism available for any model**, not just `user` — `packages/auth/src/config.ts:69-85` already uses `databaseHooks.user.create.after` for the `profiles` insert, proving the plumbing pattern is already live in this codebase. The same mechanism works for `databaseHooks.session.create.before`: a hook can look up `platform_staff` by the session's `userId` and return `{ data: { expiresIn: <shorter value> } }` (or equivalent) to override the session's TTL specifically for staff, while every other session keeps the existing 30-day/1-day-refresh values (`SESSION_EXPIRES_IN_SECONDS`/`SESSION_UPDATE_AGE_SECONDS`, `config.ts:11-12`) unchanged.

**One real risk found, unrelated to 2FA itself:** better-auth also ships a separate `admin` plugin (`dist/plugins/admin/admin.d.mts`) bundling `revokeUserSessions`/`banUser`/`setRole`/**impersonate-user** as one all-or-nothing plugin. This plugin must **not** be enabled for this project — enabling it to get its native session-revoke API (considered for decision 3) would also put a live impersonation endpoint on the wire, which conflicts with the "never: impersonation" principle even if console code never calls it. Decision 3 already resolved this by using a raw `DELETE FROM session` instead (see §3) — noted here again because the same avoidance applies if anyone is tempted to reach for the `admin` plugin for 2FA-adjacent session listing later.

**Conclusion: staff-only 2FA + shorter staff sessions can both be done cleanly, using only the `twoFactor()` plugin (as-is, no fork) plus one new `databaseHooks.session.create.before` hook in `packages/auth`, without touching the `admin` plugin and without any change to non-staff auth behavior.** This is more favorable than originally assumed in the first draft of this plan (which incorrectly stated 2FA "is not natively per-role" — per-user opt-in *is* the correct primitive for "staff only," since staff are simply the only accounts that will ever have `twoFactorEnabled = true` in practice, enforced by `requireStaff`).

**Per decision 7, this spike is Build Order Step 1 (see §5) and stops here for review** — no `twoFactor()` plugin wiring, no session hook, and no `platform_staff`-gated enrollment flow will be written until this report is explicitly approved. Separately, per decision 7: the console overall must stay behind an environment flag defaulting to **off** in production until staff 2FA is actually enforced, even if the console's other routes/screens are built and tested first.

### 4b. Follow-up spike questions, round 2 (2026-09-28)

User approved the Step 1 conclusion above and asked four follow-up questions before Step 2 begins. Answered by reading the installed `better-auth@1.7.6` source directly (not just `.d.mts` declarations) plus this repo's actual `createAuth()` call sites — not just the type surface.

**1. Session revocation delay — is `cookieCache`/`secondaryStorage` enabled?**
Confirmed **not enabled**: `packages/auth/src/config.ts` sets neither `session.cookieCache` nor `secondaryStorage`, and a repo-wide grep for both terms returns zero matches anywhere. Read the actual `/get-session` handler (`better-auth/dist/api/routes/session.mjs:39`): `cookieCacheEnabled = ctx.context.options.session?.cookieCache?.enabled === true` — false here — so every `getSession()` call falls straight through to `ctx.context.internalAdapter.findSession(sessionCookieToken)`, a live DB read (line 153), never a cached copy. **Real revocation delay: effectively zero** — a raw `DELETE FROM session` takes effect on the very next request that calls `getSession()` (i.e. apps/api's or apps/web's normal auth middleware on the very next request), since no cache layer sits between the DB row and the check.
- Caveat for the future: if `cookieCache`/`secondaryStorage` is ever turned on for performance, this conclusion flips and revoke-sessions would additionally need to bust that cache. Worth a one-line warning comment at the revoke-sessions implementation site.
- **Test**: revoke a session via the console route, then immediately replay a request using that session's old cookie/bearer token against apps/api; assert 401.

**2. Detecting that *the current session* (not just the account) passed 2FA — including rejecting pre-2FA sessions and trust-device.**
There is no existing session-level "passed 2FA" field — only account-wide `user.twoFactorEnabled`. But better-auth's own first-party `admin` plugin proves the needed mechanism exists: it adds a field to the *existing* `session` table via `schema: { session: { fields: { impersonatedBy: {...} } } }` (`dist/plugins/admin/schema.mjs:26-30`) — a plugin can extend core `session` without forking better-auth or enabling `admin` itself.
Proposed design — a small first-party plugin (same shape as the existing `bearer()`), added to `createAuth()`'s `plugins` array:
  - `schema: { session: { fields: { twoFactorVerifiedAt: { type: "date", required: false, input: false } } } }`.
  - A `hooks.after` matcher (the identical technique `twoFactor()` itself uses for sign-in, `two-factor/index.mjs:244-329`) on the three verify endpoints — confirmed exact paths: `/two-factor/verify-totp` (`totp/index.mjs:150`), `/two-factor/verify-otp` (`otp/index.mjs:133`), `/two-factor/verify-backup-code` (`backup-codes/index.mjs:89`). On success `ctx.context.newSession` is populated (`setSessionCookie()` → `ctx.context.setNewSession(session)`, confirmed `dist/cookies/index.mjs:179`); the hook stamps that session: `internalAdapter.updateSession(newSession.session.token, { twoFactorVerifiedAt: new Date() })`.
  - `requireStaff` then checks **`session.twoFactorVerifiedAt !== null`**, not `user.twoFactorEnabled`. A session that never hit one of the three verify-* endpoints — including one created before 2FA was ever enabled for that user — has `twoFactorVerifiedAt = null` and is rejected. No separate "enabled at" bookkeeping needed.
  - **Trust-device is covered for free, plus a config backstop**: reading `two-factor/index.mjs`'s sign-in hook (lines 244-329), a valid trust-device cookie makes it return *early*, leaving the original credential-sign-in session intact and skipping the verify-* round trip entirely. Since the stamping hook only fires on verify-*, a trust-device-skipped session never gets `twoFactorVerifiedAt` set, so `requireStaff` rejects it automatically. As defense-in-depth, also set `twoFactor({ trustDeviceMaxAge: 0 })` in this project's config — the cookie's own maxAge becomes 0, making "remembered 2FA" structurally unavailable app-wide (zero effect on customers, since none are expected to ever enable 2FA in practice).
- **Tests**: (a) plain `/sign-in/email` session (2FA-enabled user, no verify-* call) → `twoFactorVerifiedAt = null` → `requireStaff` 403s; (b) session that completed `/two-factor/verify-totp` → stamped → `requireStaff` 200s; (c) manually null the column on an old row (simulating a session that predates the stamping plugin) → rejected; (d) sign in with `trustDevice: true` once, then sign out and back in again → second session's `twoFactorVerifiedAt` is still `null` (took the early-return branch) → rejected.

**3. Session refresh (rolling `updateAge`/`expiresIn`) must not extend a staff session past a hard maximum.**
Read the refresh branch directly (`dist/api/routes/session.mjs:178-221`, inside `/get-session`): it calls `internalAdapter.updateSession(token, { expiresAt: getDate(ctx.context.sessionConfig.expiresIn, "sec"), updatedAt })` — always recomputed from the single global `sessionConfig.expiresIn`, no per-user branch point in this path. `databaseHooks.session.update.before` does exist generically (`dist/db/with-hooks.mjs:44-61`, same mechanism as `create.before`), **but** unlike `create.before`, the `data` payload here is only `{expiresAt, updatedAt}` — no `userId` — so a hook can't cheaply tell "is this staff?" from the payload alone, and how to reliably resolve the current row from inside `update.before` is not confirmed by static reading; it would need a runtime prototype, not just type inspection.
- **Better design that avoids needing that uncertain interception point at all**: `createdAt` is confirmed never touched by the refresh update above (only `expiresAt`/`updatedAt` change), so enforce the staff cap by comparing `now() - session.createdAt` against a fixed `STAFF_SESSION_MAX_AGE_SECONDS` constant **inside `requireStaff` itself**, independent of whatever `expiresAt` says. No matter how many times rolling refresh extends `expiresAt`, `requireStaff` independently rejects (and can proactively delete) any staff session past its own age ceiling. A shorter *initial* `expiresIn` via `session.create.before` for staff is still worth doing (keeps the raw DB row self-documenting), but it becomes a nice-to-have, not the security backstop.
- **Test**: create a staff session, backdate `createdAt` in the DB past `STAFF_SESSION_MAX_AGE_SECONDS` (simulating many refreshes' worth of elapsed time), call a `/console/*` route, assert 403 even though ordinary refresh would otherwise have kept pushing `expiresAt` into the future.

**4. Every sign-in path enabled today, confirming none bypasses 2FA.**
Re-read `packages/auth/src/config.ts` in full: only `emailAndPassword: { enabled: true, autoSignIn: true }` plus `plugins: [bearer(), ...extraPlugins]` — no `socialProviders`, `magicLink()`, `passkey()`, `phoneNumber()`, or `emailOTP()` anywhere. Read both call sites: `apps/api/src/lib/auth.ts` (no extra plugins) and `apps/web/src/lib/auth/auth.ts` (adds only `nextCookies()`, a response-header-forwarding plugin with no auth semantics). Read the only place sign-in is actually invoked, `apps/web/src/lib/auth/actions.ts`: exactly `signInEmail` (login) and `signUpEmail` (signup, `autoSignIn: true` mints a session immediately, no email-verification step) — plus `signOut`.
- Coverage check against `twoFactor()`'s own sign-in matcher (`/sign-in/email` / `/sign-in/username` / `/sign-in/phone-number`, `two-factor/index.mjs:246`): `/sign-in/email` **is** matched — every credential login is gated once `twoFactorEnabled` is true. `/sign-up/email`'s auto-sign-in is **not** matched (sign-up isn't a sign-in path) — reviewed and judged not exploitable here, since a brand-new signup can't already be a `platform_staff` account with 2FA enabled (both are granted only after the account already exists). `bearer()` doesn't create sessions, only re-presents an existing session's token — inherits whatever `twoFactorVerifiedAt` stamp (Q2) that session already has.
- **Conclusion**: exactly one sign-in-creating path exists today (email+password), fully covered by both better-auth's built-in 2FA redirect and the proposed `twoFactorVerifiedAt` stamp. No social/magic-link/passkey plugin exists to create a gap.
- **Test**: assert the auth instance's registered endpoints contain exactly `signInEmail`/`signUpEmail`/`signOut` as sign-in/out surface (e.g. enumerate `auth.api` keys matching `/sign-in|sign-up|sign-out/`) — so a future PR adding a new sign-in plugin without updating console 2FA enforcement fails this test loudly instead of silently opening a bypass.

**Tests to include when building the 2FA pieces (approved, 2026-09-28):**
- `twoFactorVerifiedAt` is stamped only after a successful `verify-totp`/`verify-otp`/`verify-backup-code`, and only on the session that endpoint issues (not on any other session belonging to the same user).
- A failed verification attempt stamps nothing (session's `twoFactorVerifiedAt` stays `null`).
- A staff session created before 2FA was enabled for that user is rejected by `requireStaff`.
- A staff session older than `STAFF_SESSION_MAX_AGE_SECONDS` is rejected by `requireStaff` even if `expiresAt` is still in the future (proves the `createdAt` cap is independent of rolling refresh).
- Revoke-sessions logs the target user out on their very next request (proves the zero-delay conclusion from Q1 above, not just that the DB row is gone).

## 5. Build order (small, independently testable steps)

Per decision 7, **Step 1 is the 2FA/session spike report only** (§4) — already delivered above, stopped for review before any of the code steps below begin. Everything from Step 2 onward is plan-only until that report is approved.

1. **2FA/shorter-staff-session spike — report only, no code.** Delivered in §4 above. **Stop here for review** before proceeding to Step 2.
2. **Migration**: `platform_staff` table + a CLI script (`apps/api/src/scripts/` or similar, following the existing `setUserPassword.ts` pattern) to grant/revoke. Test: run script, query table directly — no app code depends on it yet.
3. **Migration**: `staff_audit_log` table + `private.log_staff_action()` helper. Test: call the helper via a one-off script under service role; confirm RLS blocks it under `authenticated`.
4. **`requireStaff` middleware** + an empty `/console` router with one trivial route (e.g. `GET /console/ping`) gated by it, mounted only when a new env flag (e.g. `CONSOLE_ENABLED=false` by default) is on. Test: staff session → 200; non-staff session → 403; flag off → router not mounted at all.
5. **`GET /console/orgs`** (list/search), explicit service-role query, writes `staff_audit_log`. Test: integration test with a staff and a non-staff session.
6. **`GET /console/orgs/:orgId`** (profile + members, no plan yet). Same pattern.
7. **Migration**: `org_plan` table + backfill (`plan_tier='Pro'`, `workflow_limit=25` for every existing org — decision 6). Test proving the backfill reproduces `getPlanUsage()`'s current constant exactly for every pre-existing org. Then extend `GET /console/orgs/:orgId` to include plan/limits/usage.
8. **`PATCH /console/orgs/:orgId/plan`** — writes `org_plan` + both audit logs. Test: verify both `staff_audit_log` and the org's `audit_log` get a row.
9. **Migration**: `organizations` suspension columns. **`POST /console/orgs/:orgId/suspend`** and **`/unsuspend`**. Separately, per decision 2: add the enforcement checks — (a) shared API request path returns 403 "organization suspended" for a suspended org, (b) `apps/worker` dispatch refuses to start new/queued/scheduled runs for a suspended org while letting in-flight runs finish — each with its own test. This is cross-cutting and should be its own reviewed step, not bundled silently into the console PR.
10. **Before this step, explicitly confirm with the user before touching `apps/worker`** (decision 5). Then: migration for `workflow_runs.error` column; small `apps/worker` change (`runEtl.ts`'s `fail()`, `workflowRuns.ts`'s `finishRun()`) to populate it on failure. **`GET /console/orgs/:orgId/runs`**.
11. **`GET /console/orgs/:orgId/connectors`** — reuses existing `connections.last_test_*` columns, no migration needed.
12. **`GET /console/users`** and **`GET /console/users/:userId`** (profile, org memberships, session count/last-active metadata).
13. **`POST /console/users/:userId/revoke-sessions`** — raw `DELETE FROM public.session WHERE "userId" = $1` (finalized, decision 3 — see §3); writes `staff_audit_log` + every-org `audit_log` entries for the target user (decision 4).
14. **2FA + shorter-session hooks in `packages/auth`**, built per the Step 1 spike's conclusion (§4) — functionally independent of the console routes; can be built/tested in parallel with steps 5–13, but must land, be verified working, and have the `CONSOLE_ENABLED` flag flipped on only after 2FA is actually enforced for staff — the console stays off in production until then, even if steps 2–13 are already built and tested (decision 7).
15. **Console frontend screens** (staff sign-in, directory, org detail, user detail) — last, since they only consume already-tested APIs from steps 2–14.

Note: `password-reset` no longer appears in this build order — dropped from v1 entirely (decision 1).

## 6. Risks and open questions

Resolved by the 2026-09-28 decisions (kept here for traceability, no longer open):
- ~~No email service / password-reset delivery~~ → dropped from v1 entirely (decision 1).
- ~~Suspension enforcement undefined~~ → concrete semantics decided (decision 2, see §2/§5 step 9).
- ~~Session-revoke mechanism unconfirmed~~ → resolved to raw `DELETE FROM session`, `admin` plugin rejected (decision 3, see §3/§4).
- ~~Ambiguity on which org's audit_log gets account-level actions~~ → resolved: every org the target user belongs to (decision 4, see §3).
- ~~`org_plan` shape unconfirmed~~ → resolved to `plan_tier` + `workflow_limit` only, matching `getPlanUsage()` exactly (decision 6, see §2).
- ~~Better Auth 2FA/session-hook feasibility unverified~~ → spiked and confirmed feasible (decision 7, see §4). Still gated: the actual hook code has not been written yet — Step 1 stops for review before that happens.

Still open / newly identified:
- **`workflow_runs` currently has no error-detail column**, and populating it requires a change in `apps/worker`, not just `apps/api`. Per decision 5, the user must be explicitly asked before that specific build step (§5 step 10) touches `apps/worker` — not yet asked, since we haven't reached that step.
- **Better Auth's `admin` plugin must stay uninstalled/unused.** It's the only place a native session-revoke API lives, but it bundles impersonate-user/ban-user/setRole as live endpoints the moment it's enabled — permanently avoid it for this project, not just for the current session-revoke decision, since it would also be tempting to reach for later (e.g. for session listing UI). Called out explicitly so a future contributor doesn't "helpfully" enable it.
- **The `session` table has no RLS and is normally only touched through better-auth's own APIs.** The chosen raw `DELETE FROM session` bypasses better-auth's session-management layer; should confirm there's no other cache/side-table that also needs invalidating (e.g. a token allowlist) — check at implementation time (§5 step 13), not assumed clean just because no such table was found in the discovery pass.
- **The Directory screen's "type filter" (orgs / users / individual accounts)** implies users with no org membership ("individual" workspace users, per `packages/schemas/src/can.ts`'s `ActorRole`) are first-class search targets too — confirming `GET /console/users` must include them, not just org members.
- **Scope boundary vs. the full mockup.** The design includes impersonation, org delete/purge, a revenue dashboard, invoices, notifications, settings, and support — all explicitly out of v1 per the decided principles and/or missing data models. Worth stating plainly so nobody expects the v1 console UI to visually match the full mockup.
- **`org_plan` is being introduced here purely for console purposes.** If there's a separate, unstated plan to build customer-facing billing/plan UI, the two efforts should be coordinated so the schema isn't built twice with diverging shapes.
- **`CONSOLE_ENABLED` env flag naming/location** (decision 7) not yet decided — likely alongside other `apps/api` env vars in `apps/api/src/env.ts`, defaulting to `false`; exact name/placement to be confirmed at build step 4.
- **`databaseHooks.session.update.before`'s payload shape for identifying "is this staff" is unconfirmed** (round 2, Q3, 2026-09-28) — its `data` argument is only `{expiresAt, updatedAt}`, no `userId`, and how to reliably resolve the row from inside that hook wasn't confirmed by static source reading. This is judged **moot, not just deferred**: the chosen design enforces the staff session-age cap via a `createdAt` comparison inside `requireStaff` itself, which needs no hook at all and is immune to however the refresh path is implemented internally. If a future need arises to actually mutate/reject the refresh at the hook level (rather than just checking age downstream in `requireStaff`), this open point would need a runtime prototype, not static reading, before relying on it.
- **Standing risk, not a one-time check**: re-audit every sign-in path for staff-2FA bypass whenever any auth plugin is added or `packages/auth/src/config.ts` changes (e.g. adding `socialProviders`, `magicLink()`, `passkey()`, `phoneNumber()`, `emailOTP()`, or any other plugin that can create a session). The round-2 Q4 audit found exactly one sign-in-creating path today and confirmed it's covered by the 2FA gate, but that conclusion is a snapshot, not a standing guarantee — the "enumerate `auth.api` sign-in/out keys" test above should run in CI so a newly added plugin fails loudly instead of silently opening a bypass, but the test alone doesn't replace an actual human re-read of the new plugin's session-issuing behavior (e.g. does it also have its own trust-device-style skip path that the `twoFactorVerifiedAt` stamp wouldn't catch?).

Then stop and wait. Don't commit — nothing above has been implemented; this is the plan only.
