import type {
  ConnectorConfig,
  ConnectorManifest,
  CreateEntityRequest,
  CreateEntityResponse,
  CredentialRef,
  DropEntityRequest,
  DropEntityResponse,
  IntrospectResponse,
  PreflightRequest,
  PreflightResponse,
  StageRequest,
  StageResponse,
  TestResponse,
  WriteRequest,
  WriteResponse,
} from "@nia/schemas";
import {
  CreateEntityResponse as CreateEntityResponseSchema,
  DropEntityResponse as DropEntityResponseSchema,
  ExecuteResponse,
  IntrospectResponse as IntrospectResponseSchema,
  PreflightResponse as PreflightResponseSchema,
  StageResponse as StageResponseSchema,
  TestResponse as TestResponseSchema,
  WriteResponse as WriteResponseSchema,
} from "@nia/schemas";
import type { ValidatedQuery } from "@nia/guardrails";
import { env } from "../env.js";
import type { DispatchResult } from "./errors.js";
import { warnIfRouteMissing } from "./routeAwareness.js";

const DEFAULT_ROW_CAP = 1000;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_INTROSPECT_TIMEOUT_MS = 15000;
const DEFAULT_TEST_TIMEOUT_MS = 15000;
const DEFAULT_WRITE_TIMEOUT_MS = 15000;
const DEFAULT_STAGE_TIMEOUT_MS = 30000;
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 15000;
const DEFAULT_CREATE_ENTITY_TIMEOUT_MS = 30000;

function baseUrl(manifest: ConnectorManifest): string {
  // Same CONNECTOR_DEV_HOST override apps/api/src/lib/connectorDispatch.ts
  // uses — manifest.service.host is the Docker-internal address, unreachable
  // when the worker runs on the host via `pnpm dev`. Refused in production
  // by env.ts's schema, not just "unused."
  const host = env.CONNECTOR_DEV_HOST ?? manifest.service.host;
  return `http://${host}:${manifest.service.port}`;
}

/**
 * The last hop before a query leaves this process for a connector service's
 * /execute endpoint. Deliberately typed to accept ONLY a ValidatedQuery
 * (@nia/guardrails) — never a raw QueryPayload. Passing a plain QueryPayload
 * here is a compile error, not a runtime check (see connectorClient.test.ts
 * for the proof).
 *
 * dispatch.ts's top-level dispatch() function still takes a raw QueryPayload
 * — that's unavoidable, since it must resolve the connection before it even
 * knows which manifestId to validate against. This function is where the
 * structural guarantee actually lives: nothing can reach a connector service
 * without first going through @nia/guardrails' validateBeforeDispatch, the
 * only function able to mint a ValidatedQuery.
 */
export async function sendToConnector(
  manifest: ConnectorManifest,
  credential: CredentialRef,
  config: ConnectorConfig,
  validated: ValidatedQuery,
  opts: { rowCap?: number; timeoutMs?: number } = {},
): Promise<DispatchResult<ExecuteResponse>> {
  warnIfRouteMissing(manifest, "execute");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${baseUrl(manifest)}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        credential,
        config,
        query: validated.query,
        rowCap: opts.rowCap ?? DEFAULT_ROW_CAP,
        timeoutMs,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        error: {
          kind: "query-timeout",
          message: `Query against connector "${manifest.id}" timed out after ${timeoutMs}ms.`,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "service-unreachable",
        message: `Could not reach connector service "${manifest.id}": ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let message = `connector service "${manifest.id}" responded ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    return { ok: false, error: { kind: "service-error", message } };
  }

  const parsed = ExecuteResponse.safeParse(await res.json());
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: "service-error",
        message: `Malformed /execute response from connector "${manifest.id}": ${parsed.error.message}`,
      },
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Calls a connector service's /introspect endpoint. Used by
 * lib/introspection.ts to build the schema the chat pipeline feeds to
 * query generation — never called with a raw QueryPayload, so it doesn't
 * need the ValidatedQuery boundary sendToConnector enforces.
 */
export async function sendIntrospectRequest(
  manifest: ConnectorManifest,
  credential: CredentialRef,
  config: ConnectorConfig,
  opts: { timeoutMs?: number } = {},
): Promise<DispatchResult<IntrospectResponse>> {
  warnIfRouteMissing(manifest, "introspect");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_INTROSPECT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${baseUrl(manifest)}/introspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential, config }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        error: {
          kind: "query-timeout",
          message: `Introspection of connector "${manifest.id}" timed out after ${timeoutMs}ms.`,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "service-unreachable",
        message: `Could not reach connector service "${manifest.id}": ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let message = `connector service "${manifest.id}" responded ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    return { ok: false, error: { kind: "service-error", message } };
  }

  const parsed = IntrospectResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: "service-error",
        message: `Malformed /introspect response from connector "${manifest.id}": ${parsed.error.message}`,
      },
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Calls a connector service's /test endpoint — apps/worker's counterpart to
 * apps/api/src/lib/connectorDispatch.ts's dispatchTest, needed here for the
 * checks engine's "credentials" check (Phase 5 Session 3 Task 2), which the
 * worker runs so it can share the same testConnection injection point
 * checks.ts already defines. Same DispatchResult<T> shape as
 * sendToConnector/sendIntrospectRequest so callers handle all three
 * uniformly.
 */
export async function sendTestRequest(
  manifest: ConnectorManifest,
  credential: CredentialRef,
  config: ConnectorConfig,
  opts: { timeoutMs?: number } = {},
): Promise<DispatchResult<TestResponse>> {
  warnIfRouteMissing(manifest, "test");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${baseUrl(manifest)}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential, config }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        error: {
          kind: "query-timeout",
          message: `Test of connector "${manifest.id}" timed out after ${timeoutMs}ms.`,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "service-unreachable",
        message: `Could not reach connector service "${manifest.id}": ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let message = `connector service "${manifest.id}" responded ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    return { ok: false, error: { kind: "service-error", message } };
  }

  const parsed = TestResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: "service-error",
        message: `Malformed /test response from connector "${manifest.id}": ${parsed.error.message}`,
      },
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Calls a connector service's /write endpoint (Phase 6 Block 2). Takes a
 * fully-built WriteRequest — writeDispatch.ts owns resolving the write
 * credential/grant and signing the WriteContext before this function is
 * ever reached, mirroring sendToConnector's split with dispatch.ts (the
 * caller assembles a trusted, validated payload; this function's only job
 * is the HTTP hop and response-shape validation).
 */
export async function sendWriteRequest(
  manifest: ConnectorManifest,
  request: WriteRequest,
  opts: { timeoutMs?: number } = {},
): Promise<DispatchResult<WriteResponse>> {
  warnIfRouteMissing(manifest, "write");
  const timeoutMs = opts.timeoutMs ?? request.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${baseUrl(manifest)}/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        error: {
          kind: "query-timeout",
          message: `Write against connector "${manifest.id}" timed out after ${timeoutMs}ms.`,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "service-unreachable",
        message: `Could not reach connector service "${manifest.id}": ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let message = `connector service "${manifest.id}" responded ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    return { ok: false, error: { kind: "service-error", message } };
  }

  const parsed = WriteResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: "service-error",
        message: `Malformed /write response from connector "${manifest.id}": ${parsed.error.message}`,
      },
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Calls a connector service's /stage endpoint (Phase 11 Block 2A/2B) — the
 * staging lifecycle's create/apply/drop ops. Takes a fully-built
 * StageRequest; same split as sendWriteRequest: the caller (staging
 * orchestration in runEtl.ts) owns resolving the write credential/grant and
 * signing the WriteContext before this function is ever reached. This
 * function's only job is the HTTP hop and response-shape validation — it
 * has no opinion on `op` and doesn't special-case connectors that refuse
 * staged mode (e.g. connector-mongodb): that refusal comes back as an
 * ordinary non-2xx `service-error`, same as any other connector-side
 * rejection, for the caller to handle.
 */
export async function sendStageRequest(
  manifest: ConnectorManifest,
  request: StageRequest,
  opts: { timeoutMs?: number } = {},
): Promise<DispatchResult<StageResponse>> {
  warnIfRouteMissing(manifest, "stage");
  const timeoutMs = opts.timeoutMs ?? request.timeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${baseUrl(manifest)}/stage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        error: {
          kind: "query-timeout",
          message: `Stage op "${request.op}" against connector "${manifest.id}" timed out after ${timeoutMs}ms.`,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "service-unreachable",
        message: `Could not reach connector service "${manifest.id}": ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let message = `connector service "${manifest.id}" responded ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    return { ok: false, error: { kind: "service-error", message } };
  }

  const parsed = StageResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: "service-error",
        message: `Malformed /stage response from connector "${manifest.id}": ${parsed.error.message}`,
      },
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Calls a connector service's /preflight endpoint (Phase 11 Block 2D).
 * Unsigned and read-only — mirrors sendIntrospectRequest's posture, not
 * sendWriteRequest's (there's no WriteContext to build here). Called once
 * before extraction starts a staged run, so a missing privilege fails fast
 * with an actionable message instead of partway through staging DDL.
 */
export async function sendPreflightRequest(
  manifest: ConnectorManifest,
  request: PreflightRequest,
  opts: { timeoutMs?: number } = {},
): Promise<DispatchResult<PreflightResponse>> {
  warnIfRouteMissing(manifest, "preflight");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${baseUrl(manifest)}/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        error: {
          kind: "query-timeout",
          message: `Preflight against connector "${manifest.id}" timed out after ${timeoutMs}ms.`,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "service-unreachable",
        message: `Could not reach connector service "${manifest.id}": ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let message = `connector service "${manifest.id}" responded ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    return { ok: false, error: { kind: "service-error", message } };
  }

  const parsed = PreflightResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: "service-error",
        message: `Malformed /preflight response from connector "${manifest.id}": ${parsed.error.message}`,
      },
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Schema layer, Part 4 — calls a connector service's /create-entity
 * endpoint. Same signed-request posture as sendWriteRequest/
 * sendStageRequest (the WriteContext HMAC is verified connector-side, not
 * here); this is purely the HTTP hop, mirroring sendStageRequest's
 * template exactly.
 */
export async function sendCreateEntityRequest(
  manifest: ConnectorManifest,
  request: CreateEntityRequest,
  opts: { timeoutMs?: number } = {},
): Promise<DispatchResult<CreateEntityResponse>> {
  warnIfRouteMissing(manifest, "create-entity");
  const timeoutMs = opts.timeoutMs ?? request.timeoutMs ?? DEFAULT_CREATE_ENTITY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${baseUrl(manifest)}/create-entity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        error: {
          kind: "query-timeout",
          message: `create-entity against connector "${manifest.id}" timed out after ${timeoutMs}ms.`,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "service-unreachable",
        message: `Could not reach connector service "${manifest.id}": ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let message = `connector service "${manifest.id}" responded ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    return { ok: false, error: { kind: "service-error", message } };
  }

  const parsed = CreateEntityResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: "service-error",
        message: `Malformed /create-entity response from connector "${manifest.id}": ${parsed.error.message}`,
      },
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Orphaned-destination-table lifecycle fix — calls a connector service's
 * /drop-entity endpoint. Same signed-request posture and template as
 * sendCreateEntityRequest.
 */
export async function sendDropEntityRequest(
  manifest: ConnectorManifest,
  request: DropEntityRequest,
  opts: { timeoutMs?: number } = {},
): Promise<DispatchResult<DropEntityResponse>> {
  warnIfRouteMissing(manifest, "drop-entity");
  const timeoutMs = opts.timeoutMs ?? request.timeoutMs ?? DEFAULT_CREATE_ENTITY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${baseUrl(manifest)}/drop-entity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        error: {
          kind: "query-timeout",
          message: `drop-entity against connector "${manifest.id}" timed out after ${timeoutMs}ms.`,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "service-unreachable",
        message: `Could not reach connector service "${manifest.id}": ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let message = `connector service "${manifest.id}" responded ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    return { ok: false, error: { kind: "service-error", message } };
  }

  const parsed = DropEntityResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: "service-error",
        message: `Malformed /drop-entity response from connector "${manifest.id}": ${parsed.error.message}`,
      },
    };
  }
  return { ok: true, value: parsed.data };
}
