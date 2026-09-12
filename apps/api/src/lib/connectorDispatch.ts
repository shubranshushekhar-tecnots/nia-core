import type { ConnectorManifest, ConnectorConfig, CredentialRef } from "@nia/schemas";
import { TestResponse } from "@nia/schemas";

/**
 * Thin HTTP client for the uniform connector-service contract
 * (packages/schemas/src/contract.ts). Only /test is wired for Step 4 — no
 * /execute route exists yet; that dispatch belongs to the workflow runner
 * (see the connections service's comment on why).
 *
 * Credentials never pass through here: only a CredentialRef (connectionId +
 * credVersion + vaultRef) crosses this boundary. The service resolves the
 * actual secret itself.
 */

function baseUrl(manifest: ConnectorManifest): string {
  // manifest.service.{host,port} is the Docker-internal-network address
  // (e.g. connector-mysql:4010), correct once apps/api runs in the compose
  // network. In local dev (apps/api runs on the host via `pnpm dev`, per
  // CLAUDE.md), CONNECTOR_DEV_HOST overrides just the host so the same
  // exposed "4010:4010" port mapping in docker-compose.yml is reachable.
  const host = process.env.CONNECTOR_DEV_HOST ?? manifest.service.host;
  return `http://${host}:${manifest.service.port}`;
}

export async function dispatchTest(
  manifest: ConnectorManifest,
  credential: CredentialRef,
  config: ConnectorConfig,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const res = await fetch(`${baseUrl(manifest)}/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential, config }),
  });
  if (!res.ok) {
    return { ok: false, error: `connector service responded ${res.status}` };
  }
  return TestResponse.parse(await res.json());
}

/**
 * Best-effort pool eviction on connection delete — closes the gap between
 * "the Postgres row is gone" and "the warm mysql2 pool for it dies on its
 * own idle-evict timer". Never blocks/fails the delete: an unreachable
 * connector service on delete is not a reason to refuse deleting the row.
 */
export async function dispatchInvalidate(manifest: ConnectorManifest, connectionId: string): Promise<void> {
  try {
    await fetch(`${baseUrl(manifest)}/invalidate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId }),
    });
  } catch {
    // Best-effort — see comment above.
  }
}
