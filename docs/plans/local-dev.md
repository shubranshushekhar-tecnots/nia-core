Context: we're migrating Nia Core off Supabase so it becomes a Postgres host and nothing more. Steps 1 (secret storage), 2 (PostgREST → pg driver) and 3 (Better Auth) are done and committed. This is step 4, the last one: local development and migrations off the Supabase CLI.

Save this entire prompt verbatim to docs/plans/local-dev.md and re-read it if your context is compacted. Report findings before writing code. Don't commit. Never run a destructive database command (reset, drop, truncate) without asking me first.

Step 1: Inventory (report, then STOP for my approval)
- Everything the Supabase CLI currently provides that we still use: the local Postgres container, migration apply and status, seeding, config.toml settings, Studio, and anything else.
- Every script, package.json entry, Dockerfile, CI step and doc that calls the supabase CLI.
- Which Postgres extensions and roles the migrations depend on (pgcrypto, the authenticated and service_role roles, the auth schema if anything still references it, and so on). Some of these come from Supabase's image rather than plain Postgres.
- Whether anything still reads config.toml at runtime.
STOP if a migration depends on something only Supabase's Postgres image provides.

Step 2: Design (implement after my approval)
- Local Postgres as a container in the existing docker-compose.yml, on its own port so it doesn't clash with the sandbox databases. Pin the version to match what production will run on Azure.
- A bootstrap step that creates the roles and extensions the migrations expect (authenticated, service_role, pgcrypto and whatever else step 1 finds), so a fresh database matches what the migrations assume.
- A migration tool of your choice — recommend one and say why. It must support: apply, status showing applied versus pending, a dry-run check for CI that fails if an applied migration file changed, and running as a one-off release step, never on service startup.
- Import the existing supabase/migrations files as-is. Don't rewrite or squash them.
- Seeding through the existing Better Auth path, as the auth step already does.
- Update DEPLOYMENT.md and README.md: how to run locally, how to apply migrations, and the fact that Studio is gone (any Postgres client replaces it).

Step 3: Tests — keep lean
- A fresh database from empty: bootstrap, apply every migration, seed, and confirm the app starts and a login works.
- All 50 RLS probes pass against the new local Postgres.
- The unit suites and typecheck.

Step 4: Close
- docs/decisions.md: why we left the CLI, the migration tool chosen, and the rule that migrations run as a release step and must be compatible with both old and new code during a deploy.
- TODO.md: anything still tied to Supabase, with the reason.

Output: the Step 1 inventory first, then stop.
