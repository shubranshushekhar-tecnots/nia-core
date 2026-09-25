# e2e (Playwright)

Real authenticated e2e against local Postgres (Supabase CLI hosts it) — no
mocked sessions. The `setup` Playwright project (`auth.setup.ts`) logs each
persona in through the real `/login` form (Better Auth) and saves its
session to `apps/web/playwright/.auth/*.json`; the main `chromium` project
depends on `setup` and specs opt into a persona via
`test.use({ storageState: personas.demo.storageStatePath })`.

## Personas

The identities themselves are created via Better Auth's own signUpEmail
path — `pnpm --filter @nia/api seed:fixtures` (see
`apps/api/src/scripts/seedFixtureUsers.ts`) — never raw SQL, since the
password hash format is internal to Better Auth. The org/project/dataset
fixtures around them are seeded by `supabase/seed.sql`'s "Canvas E2E
fixtures" block (+ the original demo block above it) and, for connections,
`apps/worker/scripts/dev-bootstrap.ts`. Password for all of them: `password`.

| Persona   | Email                    | Workspace                                    |
|-----------|--------------------------|-----------------------------------------------|
| `demo`    | demo@nia.dev             | Owner of "Ice Cream Co" (`icecream-co`)       |
| `canvasA` | canvas-e2e-a@nia.dev     | **Member** (not owner) of `canvas-e2e` org    |
| `canvasB` | canvas-e2e-b@nia.dev     | Owner of separate `canvas-e2e-b` org          |
| `canvasC` | canvas-e2e-c@nia.dev     | No org — personal/individual workspace        |

`canvasA`'s org has real mysql + mongodb connections (seeded by
`dev-bootstrap.ts`) so canvas tests can drag real source nodes.

## Running locally

```
supabase start
docker compose up -d dev-mysql dev-mongo
supabase db reset                              # applies migrations; seed.sql no-ops until fixtures exist
pnpm --filter @nia/api seed:fixtures           # creates fixture users via Better Auth
psql "$DATABASE_URL" -f supabase/seed.sql      # now populates demo/e2e org data
pnpm --filter @nia/worker bootstrap            # seeds connections (Vault RPC, not plain SQL)
pnpm --filter @nia/web test:e2e
```

`test:e2e` starts `next dev -p 3100` itself (see `playwright.config.ts`'s
`webServer`) if it isn't already running.
