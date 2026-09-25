import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CONNECTOR_MANIFESTS } from "@nia/schemas";
import { env } from "../env.js";

/**
 * Dev-time guard against the "stale connector image" failure mode: twice
 * now (see docs/decisions.md), a connector container kept running an old
 * image after its source changed — `docker compose up -d` reuses an
 * existing image unless `--build` is passed, so nothing ever surfaced this
 * until a request failed in a confusing way (a vault RPC that no longer
 * existed in the new code; secret-store wiring missing entirely).
 *
 * Each connector's Dockerfile bakes a BUILD_HASH file (scripts/compute-
 * build-hash.mjs, over the same paths as its own COPY list) into the image
 * at build time and reports it on /health. On apps/api startup we
 * recompute that same hash from the live working tree and compare — a
 * mismatch means the running container's code no longer matches what's on
 * disk. This never blocks startup or throws: it's a loud console warning,
 * not a hard failure, since apps/api itself doesn't need the connectors to
 * be reachable to boot.
 *
 * Only runs meaningfully in a local monorepo checkout: apps/api's real
 * production image is a self-contained `pnpm --prod deploy` output with no
 * sibling services/* source (see apps/api/Dockerfile), so the hash
 * computation naturally no-ops there via the try/catch below.
 */

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const HASH_SCRIPT = path.join(REPO_ROOT, "scripts", "compute-build-hash.mjs");

function sourceRootsFor(serviceDir: string): string[] {
  return [
    path.join(REPO_ROOT, "packages/schemas/package.json"),
    path.join(REPO_ROOT, "packages/schemas/src"),
    path.join(REPO_ROOT, "packages/db/package.json"),
    path.join(REPO_ROOT, "packages/db/src"),
    path.join(REPO_ROOT, "packages/secrets/package.json"),
    path.join(REPO_ROOT, "packages/secrets/src"),
    path.join(REPO_ROOT, "services", serviceDir, "package.json"),
    path.join(REPO_ROOT, "services", serviceDir, "src"),
  ];
}

async function expectedHash(serviceDir: string): Promise<string> {
  const { stdout } = await execFileAsync("node", [HASH_SCRIPT, ...sourceRootsFor(serviceDir)], { cwd: REPO_ROOT });
  return stdout.trim();
}

export async function checkConnectorFreshness(): Promise<void> {
  // CONNECTOR_MANIFESTS has 4 entries (mysql, mongodb, supabase, postgres)
  // but only 3 distinct backing services — postgres and supabase both
  // point at connector-supabase:4030. Dedupe by host so it's only checked
  // once.
  const services = new Map<string, number>();
  for (const manifest of Object.values(CONNECTOR_MANIFESTS)) {
    services.set(manifest.service.host, manifest.service.port);
  }

  // Parsed `env` (env.ts normalizes "" -> undefined), not raw process.env —
  // see connectorDispatch.ts's baseUrl() for the same reasoning.
  const devHost = env.CONNECTOR_DEV_HOST;
  await Promise.all(
    [...services.entries()].map(async ([serviceHost, port]) => {
      try {
        const expected = await expectedHash(serviceHost);
        const res = await fetch(`http://${devHost ?? serviceHost}:${port}/health`);
        if (!res.ok) return;
        const body = (await res.json()) as { buildHash?: string };
        if (!body.buildHash || body.buildHash === "dev") return;
        if (body.buildHash !== expected) {
          console.warn(
            `[connector-freshness] STALE IMAGE: ${serviceHost} is running a build that no longer ` +
              `matches its source on disk (running ${body.buildHash}, expected ${expected}). Rebuild it: ` +
              `docker compose build ${serviceHost} && docker compose up -d ${serviceHost}`,
          );
        }
      } catch {
        // Source dirs missing (prod deploy, no services/* sibling) or the
        // connector isn't reachable yet — not this check's job to report;
        // real dispatch calls will surface connectivity errors separately.
      }
    }),
  );
}
