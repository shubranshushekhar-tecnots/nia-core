import "dotenv/config";
import { z } from "zod";

/**
 * Fail fast on boot rather than surfacing a confusing runtime error the
 * first time a route touches Supabase. Deliberately has NO
 * SUPABASE_SERVICE_ROLE_KEY entry — see CLAUDE.md: this service only ever
 * builds per-request clients from the caller's own access token.
 */
const EnvSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  WEB_ORIGIN: z.string().url(),
  PORT: z.coerce.number().int().positive().default(4001),
  /**
   * Dev-only override for connectorDispatch.ts: manifest.service.host is the
   * Docker-internal address (e.g. "connector-mysql"), unreachable when
   * apps/api runs on the host via `pnpm dev`. Unset in prod, where apps/api
   * runs inside the compose network and the manifest host resolves directly.
   */
  CONNECTOR_DEV_HOST: z.string().optional(),
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
});

export const env = EnvSchema.parse(process.env);
