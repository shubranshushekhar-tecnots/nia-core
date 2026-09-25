import type { ConnectorManifest, ConnectorConfig, CredentialRef, IntrospectResponse } from "@nia/schemas";
import { TestResponse, IntrospectResponse as IntrospectResponseSchema } from "@nia/schemas";

/**
 * Thin HTTP client for the uniform connector-service contract
 * (packages/schemas/src/contract.ts). /test and /introspect are wired here
 * (Step 4 + Session 2's schema endpoint) — no /execute route exists yet;
 * that dispatch belongs to the workflow runner (see the connections
 * service's comment on why).
 *
 * Credentials never pass through here: only a CredentialRef (connectionId +
 * credVersion + vaultRef) crosses this boundary. The service resolves the
 * actual secret itself.
 */

function baseUrl(manifest: ConnectorManifest): string {
  // manifest.service.{host,port} is the Docker-internal-network address
  // (e.g. connector-mysql:4010), correct once apps/api runs in the compose
  // network. In local dev (apps/api runs on the host via `pnpm dev`, per
  // CONVENTIONS.md), CONNECTOR_DEV_HOST overrides just the host so the same
  // exposed "4010:4010" port mapping in docker-compose.yml is reachable.
  const host = process.env.CONNECTOR_DEV_HOST ?? manifest.service.host;
  return `http://${host}:${manifest.service.port}`;
}

/**
 * A secret-store failure whose underlying cause is a network error (the
 * connector's `resolveSecret` — see pool-manager.ts in each connector
 * service — resolves via @nia/secrets's createEnvKeySecretStore, which
 * wraps ANY nia_secrets read failure as "nia_secrets read failed for ref X:
 * <reason>", so this only matches when <reason> itself looks like
 * connectivity, not e.g. "ref not found" or an RLS denial, which are real
 * secret-store errors worth showing as-is).
 */
const SECRET_STORE_UNREACHABLE_PATTERN =
  /nia_secrets read failed.*(fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network)/i;

type ConnectorErrorInfo = { message: string; details: string };

/**
 * Bug fix: a non-2xx connector response used to collapse to
 * `"connector service responded 500"`, discarding whatever the connector
 * actually said (e.g. Fastify's default error handler already returns
 * `{statusCode, code, error, message}` — see connector-supabase's /introspect,
 * which surfaces pg errors like "connection is insecure (try using
 * `sslmode=require`)" in `message`). Only `message` is ever read out of the
 * body — never `stack` — so nothing beyond what the connector service chose
 * to put in that one field can reach the UI; connector services never put
 * credentials in it (secrets are resolved and used entirely inside the
 * service, never echoed back).
 *
 * `details` always carries the connector's raw message (or the bare status
 * if the body had none) so callers that want the unfiltered text — e.g. for
 * an AppError's `details` field, surfaced to the UI separately from the
 * headline message — have it, even when `message` itself gets rewritten to
 * something friendlier (see SECRET_STORE_UNREACHABLE_PATTERN below: a raw
 * `TypeError: fetch failed` means literally nothing to a user, so that case
 * gets a plain-language headline instead of the connector's raw text).
 */
async function connectorErrorMessage(res: Response): Promise<ConnectorErrorInfo> {
  const body = await res.json().catch(() => null);
  const rawMessage = body && typeof body === "object" ? (body as Record<string, unknown>).message : undefined;
  const details =
    typeof rawMessage === "string" && rawMessage.length > 0
      ? `connector service responded ${res.status}: ${rawMessage}`
      : `connector service responded ${res.status}`;

  if (typeof rawMessage === "string" && SECRET_STORE_UNREACHABLE_PATTERN.test(rawMessage)) {
    return { message: "Can't reach the credential store.", details };
  }
  return { message: details, details };
}

export async function dispatchTest(
  manifest: ConnectorManifest,
  credential: CredentialRef,
  config: ConnectorConfig,
): Promise<{ ok: boolean; latencyMs?: number; error?: ConnectorErrorInfo }> {
  const res = await fetch(`${baseUrl(manifest)}/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential, config }),
  });
  if (!res.ok) {
    return { ok: false, error: await connectorErrorMessage(res) };
  }
  // Connector's own self-reported test failure (e.g. the query ran but
  // failed) — a plain string per TestResponse's contract schema. Wrapped
  // into the same {message, details} shape as the !res.ok branch above so
  // every caller only ever handles one error shape.
  const parsed = TestResponse.parse(await res.json());
  return parsed.error === undefined
    ? { ok: parsed.ok, latencyMs: parsed.latencyMs }
    : { ok: parsed.ok, latencyMs: parsed.latencyMs, error: { message: parsed.error, details: parsed.error } };
}

export async function dispatchIntrospect(
  manifest: ConnectorManifest,
  credential: CredentialRef,
  config: ConnectorConfig,
): Promise<{ ok: true; value: IntrospectResponse } | { ok: false; error: ConnectorErrorInfo }> {
  const res = await fetch(`${baseUrl(manifest)}/introspect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential, config }),
  });
  if (!res.ok) {
    return { ok: false, error: await connectorErrorMessage(res) };
  }
  return { ok: true, value: IntrospectResponseSchema.parse(await res.json()) };
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
