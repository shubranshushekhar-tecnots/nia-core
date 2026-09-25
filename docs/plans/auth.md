Context: we're migrating Nia Core off Supabase so it becomes a Postgres host and nothing more. Four steps: (1) secret storage replacing Vault — done and committed; (2) PostgREST replaced with direct SQL through the pg driver — done and committed; (3) this one, auth; (4) local dev and migrations off the Supabase CLI.

packages/db provides withActingUser and withServiceRole, which wrap a transaction that sets the Postgres role and request.jwt.claims so every RLS policy and SECURITY DEFINER function works unchanged. The only remaining Supabase dependency in apps/api and apps/web is the auth layer: 5 files in apps/api (lib/supabaseClient.ts, lib/cookieSupabaseClient.ts, middleware/auth.ts, middleware/cookieAuth.ts, types/express.d.ts) plus apps/web's middleware, session helper and auth pages.

Now do step 3: replace Supabase Auth with Better Auth.
Save this entire prompt verbatim to docs/plans/auth.md and re-read it if your context is compacted. Report findings before writing code. Don't commit. Never run a destructive database command (reset, drop, truncate) without asking me first.

Scope for this version:
- Email and password only. No Google sign-in, no email verification, no password reset — all deferred, so no email service is needed.
- Database sessions, not cookie sessions, so a session can be revoked instantly.
- Start fresh: the single existing production account is a QA login with nothing worth keeping. No user migration.

The contract that must not break: every RLS policy and SECURITY DEFINER function reads auth.uid(), which returns the 'sub' claim from request.jwt.claims. packages/db already sets that claim. So Better Auth must issue sessions whose user id is a UUID, and the API must pass that id into withActingUser exactly as it does today. Policies, probes and functions stay untouched.

Step 1: Inventory (report, then STOP for my approval)
- Every file that touches supabase.auth.* in apps/web and apps/api, with what each does.
- How a request's identity flows today, end to end: browser → cookie or bearer → apps/api → withActingUser.
- Every foreign key referencing auth.users, and every trigger on it (there's a handle_new_user trigger that creates a profiles row).
- How the e2e personas and the 52 RLS probes create users and sign in.
- Whether anything besides login depends on Supabase Auth: invites, org creation, the create_organization RPC.
STOP if anything depends on GoTrue behaviour that Better Auth doesn't provide.

Step 2: Design (implement after my approval)
- Better Auth in apps/api, with its tables in your own schema, user ids as UUIDs.
- A users table of your own; repoint every foreign key from auth.users to it. Keep the existing ids so nothing else changes.
- Replace the handle_new_user trigger with explicit profile creation in the signup path.
- apps/api: verify the Better Auth session and pass the user id to withActingUser through the existing getActingUser helper, so this is the only place identity is resolved.
- apps/web: replace middleware.ts, the session helper and the login/signup pages. Keep the same routes and redirects.
- An admin command to set a user's password directly, since there's no password reset yet.
- Remove @supabase/supabase-js from apps/api and apps/web once nothing imports it.

Step 3: Tests — keep lean
- One unit test: a valid session resolves to the right user id; an invalid or expired one is rejected.
- Update the e2e personas and the RLS probes to create users through the new path.
- All 52 RLS probes must pass unchanged. They are the proof that isolation survived; do not modify any policy to make them pass.
- The e2e suite must pass.
- One live check: sign up, log out, log in, open the dashboard, open a workflow.

Step 4: Close
- docs/decisions.md: how sessions work, how the user id reaches auth.uid(), and why policies were untouched.
- TODO.md: email verification, password reset, Google sign-in, and SSO, all deferred.

Output: the Step 1 inventory first, then stop.
