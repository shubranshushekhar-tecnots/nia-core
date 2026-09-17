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
});

export const env = EnvSchema.parse(process.env);
