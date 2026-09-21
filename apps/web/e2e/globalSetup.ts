import path from 'node:path';
import dotenv from 'dotenv';
import { Queue } from 'bullmq';
import { createClient } from '@supabase/supabase-js';
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

async function assertCanvasCHasConnections(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'e2e preflight: NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_ANON_KEY are missing ' +
        '(apps/web/.env.local) — cannot check seeded connections.',
    );
  }

  const supabase = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const canvasC = personas.canvasC;

  const { error: authError } = await supabase.auth.signInWithPassword({
    email: canvasC.email,
    password: canvasC.password,
  });
  if (authError) {
    throw new Error(
      `e2e preflight: could not sign in as ${canvasC.email} to check seeded connections ` +
        `(${authError.message}). Is local Supabase running and seeded ("supabase db reset")?`,
    );
  }

  const { count, error } = await supabase.from('connections').select('id', { count: 'exact', head: true });
  await supabase.auth.signOut();

  if (error) {
    throw new Error(`e2e preflight: failed to check ${canvasC.email}'s connections (${error.message}).`);
  }
  if (!count) {
    throw new Error(
      `e2e preflight: ${canvasC.email} has no seeded connections. copilot.spec.ts needs at least ` +
        'one (it drives the LLM to propose a plan against a real mysql connection). Seed it with:\n' +
        '  pnpm --filter @nia/worker bootstrap',
    );
  }
}
