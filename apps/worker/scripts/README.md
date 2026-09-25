# apps/worker/scripts

Dev-only smoke tests, golden-eval runners, and one-off verification tools —
run via `pnpm --filter @nia/worker <script>` (see `package.json`), never
imported by `src/` and never shipped in the built worker image
(`apps/worker/Dockerfile` only copies `dist/`, built from `src/`).

**Known exception to the `@nia/db`/`pg` data-access migration:** most files
in this directory still `import { createClient } from "@supabase/supabase-js"`
and connect against the local sandbox's Supabase project (see each script's
own header for its specific prerequisites — some also need
`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_ANON_KEY` set locally,
which is why those aren't in `apps/worker/.env.example`: they're not
required by the built worker, only by these scripts). This predates the
PostgREST→`@nia/db` migration (`docs/plans/data-access.md`) and was never
migrated alongside `src/` — see CONVENTIONS.md's "Known Supabase-client
exceptions" and the matching `TODO.md` entry. There is no production code
path here; treat this as a documented gap, not a bug, until someone
prioritizes migrating these scripts too.
