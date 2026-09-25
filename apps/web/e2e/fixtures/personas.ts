import path from 'node:path';

/**
 * Real Better Auth personas for e2e tests. The identities themselves are
 * created via apps/api/src/scripts/seedFixtureUsers.ts (Better Auth's own
 * signUpEmail path — run once with `pnpm --filter @nia/api seed:fixtures`),
 * and the org/project/dataset fixtures around them are seeded by
 * supabase/seed.sql's "Canvas E2E fixtures" block (+ demo@nia.dev from the
 * original seed block above it) and, for connections,
 * apps/worker/scripts/dev-bootstrap.ts.
 *
 * Password is a fixed, documented, non-secret local-fixture value — it is
 * duplicated as a literal in seedFixtureUsers.ts's FIXTURES list. If you
 * change it here, change it there too (that file's comment points back at
 * this one).
 *
 * auth.setup.ts drives the real /login form for each persona and saves the
 * resulting storageState here; specs opt in via
 * `test.use({ storageState: personas.demo.storageStatePath })`.
 */

const PASSWORD = 'password';
const AUTH_DIR = path.join(__dirname, '..', '..', 'playwright', '.auth');

export type Persona = {
  email: string;
  password: string;
  storageStatePath: string;
};

function persona(name: string, email: string): Persona {
  return { email, password: PASSWORD, storageStatePath: path.join(AUTH_DIR, `${name}.json`) };
}

export const personas = {
  // Owner of "Ice Cream Co" (icecream-co) — the original demo org/dataset.
  demo: persona('demo', 'demo@nia.dev'),
  // Member (not owner) of the `canvas-e2e` org — primary canvas e2e actor,
  // has real mysql/mongodb connections via dev-bootstrap.ts.
  canvasA: persona('canvas-a', 'canvas-e2e-a@nia.dev'),
  // Owner of the separate `canvas-e2e-b` org — cross-org negative fixture,
  // shares no data with canvasA.
  canvasB: persona('canvas-b', 'canvas-e2e-b@nia.dev'),
  // No org — personal/individual workspace.
  canvasC: persona('canvas-c', 'canvas-e2e-c@nia.dev'),
} as const;

export type PersonaName = keyof typeof personas;
