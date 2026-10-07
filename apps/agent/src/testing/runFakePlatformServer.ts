#!/usr/bin/env node
import { FakePlatformServer } from "./fakePlatformServer.js";

/**
 * Foreground fake platform server for manual/CI end-to-end testing
 * (the windows-installer workflow's own stand-in for the agent-bridge).
 * Unlike runFakePlanometryServer.ts, no separate control server is
 * needed — FakePlatformServer serves its own `/control/*` routes on
 * the same port as `/agent-api/*`.
 *
 * Not used by any automated vitest run; `apps/agent/package.json`'s
 * `manual:platform` script is this file's only caller.
 */

const PORT = Number(process.env.NIA_AGENT_FAKE_PLATFORM_PORT ?? 4466);
const HOLD_MS = Number(process.env.NIA_AGENT_FAKE_PLATFORM_HOLD_MS ?? 200);

async function main(): Promise<void> {
  const fake = await FakePlatformServer.start({ port: PORT, holdMs: HOLD_MS });
  console.log(`[fake-platform] agent-api + control listening at ${fake.baseUrl}`);
  console.log(`[fake-platform] e.g. curl -X POST ${fake.baseUrl}/control/pairing-codes -d "{}"`);

  const shutdown = async () => {
    console.log("\n[fake-platform] shutting down...");
    await fake.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
