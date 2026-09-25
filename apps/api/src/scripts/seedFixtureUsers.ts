import { auth } from "../lib/auth.js";
import { dbPool } from "../lib/dbPool.js";

/**
 * Idempotently creates every fixture identity the e2e suite
 * (apps/web/e2e/fixtures/personas.ts) and the RLS probe suite
 * (supabase/tests/rls_probes.sql) depend on, through Better Auth's own
 * signUpEmail path — never raw SQL — since the password hash format is
 * internal to Better Auth (docs/plans/auth.md Step 2, requirement 4).
 *
 * Safe to re-run: skips any email that already has a public.user row.
 * Targets whichever database DATABASE_URL (apps/api/.env) points at, so
 * run it once per environment before relying on these fixtures — e.g.
 * once against local dev, and once against the linked remote project
 * before running rls_probes.sql there via `supabase db query --linked`.
 *
 *   pnpm --filter @nia/api seed:fixtures
 */
const FIXTURES: Array<{ email: string; password: string; name: string }> = [
  // apps/web/e2e/fixtures/personas.ts — password duplicated there as a
  // literal; keep the two in sync if it ever changes.
  { email: "demo@nia.dev", password: "password", name: "Demo User" },
  { email: "canvas-e2e-a@nia.dev", password: "password", name: "Canvas E2E A" },
  { email: "canvas-e2e-b@nia.dev", password: "password", name: "Canvas E2E B" },
  { email: "canvas-e2e-c@nia.dev", password: "password", name: "Canvas E2E C" },
  // supabase/tests/rls_probes.sql — looked up by email there instead of
  // being created inline via `insert into auth.users`.
  { email: "owner@rls-probe.test", password: "password", name: "RLS Probe Owner" },
  { email: "admin2@rls-probe.test", password: "password", name: "RLS Probe Admin2" },
  { email: "admin@rls-probe.test", password: "password", name: "RLS Probe Admin" },
  { email: "member@rls-probe.test", password: "password", name: "RLS Probe Member" },
  { email: "outsider@rls-probe.test", password: "password", name: "RLS Probe Outsider" },
  { email: "newperson@rls-probe.test", password: "password", name: "RLS Probe New Person" },
  { email: "individual@rls-probe.test", password: "password", name: "RLS Probe Individual" },
  { email: "orgb-owner@rls-probe.test", password: "password", name: "RLS Probe Org B Owner" },
];

async function main() {
  for (const fixture of FIXTURES) {
    const existing = await dbPool.query<{ id: string }>('select id from "user" where email = $1', [fixture.email]);
    if (existing.rows[0]) {
      console.log(`skip (already exists): ${fixture.email} -> ${existing.rows[0].id}`);
      continue;
    }
    const result = await auth.api.signUpEmail({ body: fixture });
    console.log(`created: ${fixture.email} -> ${result.user.id}`);
  }
  await dbPool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
