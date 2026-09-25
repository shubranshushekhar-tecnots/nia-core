import path from 'node:path';
import dotenv from 'dotenv';
import { Queue } from 'bullmq';
import { Pool } from 'pg';
import { personas } from './fixtures/personas';

// Not imported from @nia/schemas — that package only publishes an ESM
// "import" condition (packages/schemas/package.json), which Playwright's
// CJS-loaded globalSetup can't resolve ("No exports main defined"). Keep
// in sync with packages/schemas/src/jobs.ts's QUEUE_INTERACTIVE.
const QUEUE_INTERACTIVE = 'interactive';

/**
 * Playwright globalSetup (see playwright.config.ts) — runs once, before the
 * "setup" project's persona logins. Fails fast with a pointed message for
 * two environment gaps that have each silently blocked/hung this suite
 * before, both surfacing inside a spec as an opaque assertion timeout with
 * no clue what actually went wrong (see PHASE12_EXIT.md's "Bugs found"):
 *
 *  1. apps/worker isn't running — apps/api's propose-plan route enqueues a
 *     BullMQ job and waits on it (lib/planQueue.ts's waitUntilFinished);
 *     with no worker consuming the queue that just hangs until its own
 *     timeout, which Playwright sees as a generic ECONNRESET/timeout.
 *  2. canvasC (the org-less e2e persona) has no seeded connections —
 *     copilot.spec.ts's prompt needs a real mysql connection to propose
 *     against; without one the LLM correctly returns a "no connections"
 *     reply instead of a plan, which also just looks like a stuck
 *     plan-banner wait from inside the spec.
 *
 * Both are environment/setup state, never product bugs — this check names
 * the actual cause instead of letting a spec fail cryptically 90s later.
 */
export default async function globalSetup(): Promise<void> {
  dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

  await assertWorkerRunning();
  await assertCanvasCHasConnections();
}

async function assertWorkerRunning(): Promise<void> {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const { hostname, port } = new URL(redisUrl);
  const queue = new Queue(QUEUE_INTERACTIVE, {
    connection: { host: hostname, port: Number(port) || 6379 },
  });
  try {
    const count = await queue.getWorkersCount();
    if (count === 0) {
      throw new Error(
        `e2e preflight: no worker is consuming the BullMQ "${QUEUE_INTERACTIVE}" queue ` +
          `(checked ${redisUrl}). apps/api's propose-plan route will hang until its own ` +
          'timeout instead of failing fast. Start the worker before running e2e:\n' +
          '  cd apps/worker && npx tsx watch src/index.ts',
      );
    }
  } finally {
    await queue.close();
  }
}

/**
 * Reads canvasC's connection count directly off Postgres rather than
 * signing in through Better Auth first — this check only ever cared about
 * seeded data, not about proving auth works (auth.setup.ts's real /login
 * runs cover that), so a superuser-role dbPool read is simpler and doesn't
 * need a live session. canvasC is an individual (org-less) persona, so its
 * connections are scoped by owner_id, not org_id (0005_individual_workspace.sql).
 */
async function assertCanvasCHasConnections(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('e2e preflight: DATABASE_URL is missing (apps/web/.env.local) — cannot check seeded connections.');
  }

  const pool = new Pool({ connectionString });
  const canvasC = personas.canvasC;

  try {
    const { rows } = await pool.query<{ count: string }>(
      `select count(c.id)::text as count
       from public.connections c
       join public."user" u on u.id = c.owner_id
       where u.email = $1`,
      [canvasC.email],
    );
    const count = Number(rows[0]?.count ?? 0);

    if (!count) {
      throw new Error(
        `e2e preflight: ${canvasC.email} has no seeded connections. copilot.spec.ts needs at least ` +
          'one (it drives the LLM to propose a plan against a real mysql connection). Seed it with:\n' +
          '  pnpm --filter @nia/worker bootstrap',
      );
    }
  } finally {
    await pool.end();
  }
}
