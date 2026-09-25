import "dotenv/config";
import { z } from "zod";

/**
 * Fail fast on boot rather than surfacing a confusing runtime error the
 * first time a route touches auth.
 */
const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  /**
   * Direct Postgres connection for @nia/db (docs/plans/data-access.md,
   * Step 3) and for @nia/auth's Better Auth instance (docs/plans/auth.md,
   * Step 2) — both share this service's one pool (lib/dbPool.ts). Connects
   * as the `postgres` role (see DEPLOYMENT.md's "Database connection
   * pooling" section for why); per-request privilege narrowing to
   * `authenticated` for data access happens via withActingUser's SET LOCAL
   * ROLE, not via this connection string. Better Auth reads/writes its own
   * user/session/account/verification tables on this same unprivileged-by-
   * RLS connection, same as the old handle_new_user trigger did.
   */
  DATABASE_URL: z.string().min(1),
  /**
   * Public origin of apps/api itself. Passed to Better Auth as `baseURL`
   * (packages/auth/src/config.ts) — this instance never issues cookies of
   * its own (login/signup happens in apps/web), it only ever verifies
   * sessions via auth.api.getSession(), but Better Auth still wants a
   * baseURL to avoid a startup warning and to reason about secure-cookie
   * defaults.
   */
  API_URL: z.string().url(),
  /**
   * Must be byte-identical to apps/web's BETTER_AUTH_SECRET — it signs the
   * session token embedded in both the Set-Cookie value and the
   * `set-auth-token` bearer value apps/web forwards, and this instance
   * verifies that signature independently of whichever app issued it.
   */
  BETTER_AUTH_SECRET: z.string().min(1),
  WEB_ORIGIN: z.string().url(),
  PORT: z.coerce.number().int().positive().default(4001),
  /**
   * Dev-only override for connectorDispatch.ts: manifest.service.host is the
   * Docker-internal address (e.g. "connector-mysql"), unreachable when
   * apps/api runs on the host via `pnpm dev`. Must never be set in
   * production — a prod apps/api silently pointing at localhost instead of
   * the real Docker-network service host is a bad, quiet failure mode, so
   * this is refused outright at boot (see the `.refine()` below), same
   * reasoning as apps/worker's copy of this var.
   *
   * Normalizes "" -> undefined: a compose override setting this to an
   * empty string (the usual way to un-leak it from a shared `env_file`
   * without deleting the key) must behave identically to it being fully
   * unset, both for the production `.refine()` guard below and for every
   * `env.CONNECTOR_DEV_HOST ?? manifest.service.host` fallback read
   * elsewhere — an empty string previously survived as a real value and
   * silently produced host-less URLs like "http://:4010/test".
   */
  CONNECTOR_DEV_HOST: z
    .string()
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
  /** BullMQ producer + chat-event pub/sub subscriber, same as apps/worker. */
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  /**
   * Upper bound on a single /chat/stream connection. Past this, the SSE
   * lifecycle force-emits a terminal `error` event and closes rather than
   * holding the connection (and its Redis subscriber) open forever — the
   * client-side guarantee that pairs with the worker-side try/finally in
   * apps/worker/src/index.ts's chat_query handler.
   */
  CHAT_SSE_MAX_DURATION_MS: z.coerce.number().int().positive().default(120_000),
  /** Comment-only keep-alive so intermediary proxies don't time out an idle SSE connection. */
  CHAT_SSE_HEARTBEAT_MS: z.coerce.number().int().positive().default(15_000),
  /**
   * Upper bound on checksQueue.ts's synchronous await of the worker's
   * check_run job (see that file's header comment for why this is a
   * blocking request/response, not SSE). Past this, the route fails clean
   * with a 503 naming the worker unavailable rather than hanging the HTTP
   * request indefinitely.
   */
  CHECK_RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * Upper bound on mappingsQueue.ts's synchronous await of the worker's
   * mappings_propose job (an LLM call, so a longer budget than
   * CHECK_RUN_TIMEOUT_MS's pure-graph-inspection default). Past this, the
   * route fails clean with a 503 naming the worker unavailable rather than
   * hanging the HTTP request indefinitely.
   */
  MAPPING_PROPOSE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * Upper bound on planQueue.ts's synchronous await of the worker's
   * plan_propose job (Phase 7). Same "single request/response outcome,
   * not SSE" reasoning as MAPPING_PROPOSE_TIMEOUT_MS (runPlanPropose.ts's
   * header comment: one graph.invoke() call, no incremental events) — but
   * budgeted longer than a plain mappings_propose call, since generatePlan
   * does its own LLM call AND validateFeasibility can issue one real
   * cardinality-probe connector dispatch per proposed aggregate step on
   * top of that. Past this, the route fails clean with a 503 naming the
   * worker unavailable rather than hanging the HTTP request indefinitely.
   */
  PLAN_PROPOSE_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  /**
   * Upper bound on previewQueue.ts's synchronous await of the worker's
   * preview_run job. No LLM call on this path (pure pushdown compile +
   * one connector dispatch), so this sits between CHECK_RUN_TIMEOUT_MS's
   * pure-graph-inspection budget and MAPPING_PROPOSE_TIMEOUT_MS's LLM
   * budget. Past this, the route fails clean with a 503 naming the worker
   * unavailable rather than hanging the HTTP request indefinitely.
   */
  PREVIEW_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  /**
   * Upper bound on schemaRefreshQueue.ts's synchronous await of the
   * worker's schema_refresh job (a single connector /introspect call, no
   * LLM) — same budget class as CHECK_RUN_TIMEOUT_MS. Past this, the
   * route fails clean with a 503 naming the worker unavailable rather
   * than hanging the HTTP request indefinitely.
   */
  SCHEMA_REFRESH_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * Upper bound on a single GET /:id/run/stream connection (Phase 6 Block
   * 3). Deliberately its own var, not a reuse of CHAT_SSE_MAX_DURATION_MS:
   * a chat turn is one worker job, but one ETL run is many self-requeued
   * chunk jobs (runEtl.ts) that can span far longer wall-clock time than a
   * single chat turn — 2 minutes would routinely cut a real run's stream
   * off mid-flight. Past this, the SSE lifecycle force-emits a terminal
   * `error` event and closes, same client-side guarantee chat's stream
   * makes; the run itself keeps going server-side regardless (the worker
   * has no idea a client stopped watching), so this only bounds how long
   * one HTTP connection stays open, never the run's own duration.
   */
  RUN_SSE_MAX_DURATION_MS: z.coerce.number().int().positive().default(1_800_000),
  /** Comment-only keep-alive so intermediary proxies don't time out an idle SSE connection — same rationale as CHAT_SSE_HEARTBEAT_MS, its own var since the two features' cadence has no reason to stay coupled. */
  RUN_SSE_HEARTBEAT_MS: z.coerce.number().int().positive().default(15_000),
  /**
   * Upper bound on profileQueue.ts's synchronous await of the worker's
   * profile_run job (Phase 10). No LLM call, but up to ~10 paginated
   * connector dispatches (sampleEntity.ts's head+tail keyset pages), so
   * budgeted above SCHEMA_REFRESH_TIMEOUT_MS's single-introspect-call
   * budget. Past this, the route fails clean with a 503 naming the worker
   * unavailable rather than hanging the HTTP request indefinitely.
   */
  PROFILE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * Upper bound on cleanQueue.ts's synchronous await of the worker's
   * clean_propose job (Phase 13, Step 7). Two LLM calls in parallel
   * (missing-value + coercion specialists, each with one possible retry)
   * plus up to ~10 paginated connector dispatches for the sample (same
   * sampleEntity.ts budget PROFILE_TIMEOUT_MS covers) — budgeted at
   * PLAN_PROPOSE_TIMEOUT_MS's class rather than MAPPING_PROPOSE_TIMEOUT_MS's,
   * since it's strictly more work than a single mappings_propose call. Past
   * this, the route fails clean with a 503 naming the worker unavailable
   * rather than hanging the HTTP request indefinitely.
   */
  CLEAN_PROPOSE_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  /**
   * Copilot agent (docs/plans/copilot-agent.md, Part 1/4) — apps/api's own
   * LLM gateway client (copilot/gatewayClient.ts), a thin duplicate of
   * apps/worker's lib/llm/gatewayClient.ts. A separate client (not a
   * shared package, not a reuse of the worker's) specifically so every
   * Copilot tool call stays on this service's own per-request req.withUser
   * client — apps/worker only ever has a service-role client, which the
   * plan requires Copilot never uses. Same three vars as the worker's,
   * deliberately not defaulted (fail fast on boot if unset).
   */
  NIA_GATEWAY_API_KEY: z.string().min(1),
  NIA_GATEWAY_BASE_URL: z.string().url(),
  NIA_GATEWAY_MODEL: z.string().min(1),
  /**
   * Vault replacement (docs/plans/secret-storage.md): the master key that
   * decrypts every connection/write-grant credential's per-secret data key
   * (packages/secrets). Never stored in the database, never logged — losing
   * this value makes every stored credential permanently unrecoverable.
   * Must be a base64-encoded 32-byte key; generate with
   * `openssl rand -base64 32`. See DEPLOYMENT.md for rotation.
   */
  NIA_SECRET_MASTER_KEY: z.string().min(1),
  /**
   * Stage 5 production-readiness pass — signs the ReadContext apps/api
   * attaches to its own connector-service dispatches (connectorDispatch.ts's
   * /test, /introspect, /invalidate calls; the analogous /execute and
   * /preflight calls are apps/worker-only). Must be byte-identical to every
   * connector service's copy and to apps/worker's, same distribution rule
   * as WRITE_DISPATCH_SIGNING_SECRET's existing worker/connector usage —
   * see readSignature.ts's header comment and DEPLOYMENT.md.
   */
  WRITE_DISPATCH_SIGNING_SECRET: z.string().min(32),
}).refine((e) => !(e.NODE_ENV === "production" && e.CONNECTOR_DEV_HOST), {
  message:
    "CONNECTOR_DEV_HOST must not be set when NODE_ENV=production — it overrides the connector service host to a dev-only address.",
  path: ["CONNECTOR_DEV_HOST"],
});

export const env = EnvSchema.parse(process.env);
