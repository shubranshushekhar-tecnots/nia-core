Step 3 of the Supabase migration: replace PostgREST with direct SQL through the pg driver, behind one data-access module.
First, save this entire prompt verbatim to docs/plans/data-access.md and re-read it if your context is compacted. Report findings before writing code. Don't commit. Never run a destructive database command (reset, drop, truncate) without asking me first.

Goal: Supabase becomes a Postgres host and nothing more. Every supabase.from() and .rpc() call becomes SQL through the pg driver, routed through one module, with RLS still enforced by the database exactly as today.

Step 0: Confirm the tree is clean apart from the known untracked files (the apps/web scratch .mjs scripts, and landing-page work from another session). Don't touch the landing-page files or 0034_sales_leads.sql.

Step 1: Inventory (report, then STOP for my approval)
- Every supabase.from() and .rpc() call site in apps/web and apps/api, grouped by file, with a count. Note which run as the user (RLS enforced) and which use the service-role key.
- How the user's identity currently reaches the database: which header or token, and how PostgREST turns it into auth.uid().
- Every SECURITY DEFINER RPC that would need calling directly, and whether any depend on PostgREST-specific behaviour.
- Anywhere a query relies on PostgREST features that don't map to plain SQL: embedded resource selects, .single()/.maybeSingle() semantics, returning representations, upserts with onConflict, range headers, count modes.
- Whether apps/worker still uses the Supabase client, and how (it uses the service-role key today, with manual workspace scoping).
STOP if any call site can't be expressed as plain SQL without changing behaviour.

Step 2: The module (implement after my approval, then STOP again)
- A new packages/db module with a connection pool and one entry point: a function that takes the acting user's id, opens a connection, sets the session so auth.uid() returns that id, runs the caller's queries, and releases the connection. Use the same mechanism PostgREST uses (set_config on request.jwt.claims plus SET LOCAL ROLE authenticated) so every existing policy and SECURITY DEFINER function keeps working untouched.
- A service-role variant for the worker that sets no user and connects as the owner role, matching today's behaviour. It must be a separate, clearly named function, so a caller cannot reach it by accident.
- Parameterised queries only. No string interpolation of values anywhere.
- Transactions: one helper that runs a set of queries in a single transaction on one connection, since the session setting must apply to all of them.
- Connection pooling sized per service, with settings documented in DEPLOYMENT.md.
- Tests: the acting user is set correctly and cleared on release; a query as user A cannot read user B's rows (a real RLS check against local Postgres); a failed transaction rolls back; a connection is returned to the pool on error.
STOP here and report before migrating any call sites.

Step 3: Migrate call sites (after my approval)
- Convert file by file, starting with apps/api, then apps/web. Keep each file's behaviour identical; this is a mechanical change, not a redesign.
- Match PostgREST semantics exactly: .single() errors when not exactly one row, .maybeSingle() returns null for none, upserts use ON CONFLICT with the same conflict target, and count modes return the same numbers.
- Don't change any SQL semantics to "improve" a query. Anything that looks wrong gets reported, not fixed here.
- After each file, run that package's tests.

Step 4: Verify
- The 44 RLS probes must pass unchanged. They are the proof that isolation still holds.
- The e2e suite must pass, since it exercises the real request path.
- Run the full unit suites and typecheck every package.
- One live check: log in, list connections, open a workflow, and run one pipeline end to end.

Step 5: Close
- docs/decisions.md: how the acting user is set per connection, why RLS is unchanged, and pooling choices.
- TODO.md: anything deliberately left on the Supabase client, with the reason.

Output: the Step 1 inventory first, then stop. Don't commit.
