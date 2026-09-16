import "dotenv/config";
import { z } from "zod";

/**
 * Fail fast on boot rather than surfacing a confusing runtime error the
 * first time a job touches Supabase or a connector service.
 *
 * Unlike apps/api/src/env.ts (which deliberately has NO service-role key —
 * see that file's comment), the worker DOES get one: it has no live user
 * JWT to build a per-request client from, and follows the same
 * service_role precedent workflow_runs already established (see
 * apps/worker/src/index.ts's header comment).
 *
 * CONNECTOR_DEV_HOST is a dev-only override for connectorClient.ts:
 * manifest.service.host is the Docker-internal address (e.g.
 * "connector-mysql"), unreachable when the worker runs on the host via
 * `pnpm dev` (same reasoning as apps/api's CONNECTOR_DEV_HOST). It must
 * never be set in production — a prod worker silently pointing at
 * localhost instead of the real Docker-network service host is a bad,
 * quiet failure mode, so this is refused outright at boot rather than
 * just "unused in prod."
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.string().default("development"),
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    CONNECTOR_DEV_HOST: z.string().optional(),
    /**
     * Nia Gateway (OpenAI-compatible AI gateway) — the chat pipeline's only
     * LLM client. Server-side only: apps/web never sees this key, it only
     * enqueues jobs and relays already-generated tokens over Redis pub/sub.
     */
    NIA_GATEWAY_API_KEY: z.string().min(1),
    NIA_GATEWAY_BASE_URL: z.string().url().default("https://api.nia.naslabs.ai/v1"),
    NIA_GATEWAY_MODEL: z.string().default("anthropic/claude-sonnet-4-6"),
    /**
     * Per-call-site model overrides (see lib/llm/gatewayClient.ts's
     * LlmCallContext.model) — each falls back to NIA_GATEWAY_MODEL when
     * unset, so leaving both unset reproduces the pre-Phase-4-latency-work
     * single-model behavior exactly. QUERYGEN_MODEL is currently unused —
     * every fast flash tier tried for generateQuery.ts on this gateway
     * account failed either the quality gate (gemini-2.5-flash, with or
     * without reasoning disabled: regressed multi-source COUNT/conflict
     * reductions) or the speed goal (gemini-3.5-flash: quality-clean, but
     * the gateway routes it through a Vertex fallback — its Google BYOK
     * credential is invalid at the platform level — which forces a
     * mandatory, uncontrollable ~100-150 reasoning-token overhead per call,
     * making it slower than the default model). generateQuery.ts stays on
     * the default model, same as planReduction.ts. See PHASE4_EXIT.md §4
     * Fix 1. Var kept (unset) for future re-attempt if the gateway's BYOK
     * routing gets fixed. ANSWER_MODEL covers buildAnswer.ts/
     * buildAnswerMultiNode.ts; left unset in every real env file for now
     * (answer-gen quality wasn't the latency finding, only exists here for
     * future tuning).
     */
    QUERYGEN_MODEL: z.string().optional(),
    ANSWER_MODEL: z.string().optional(),
    /** TTL for the in-memory introspection cache — see lib/introspection.ts. */
    SCHEMA_CACHE_TTL_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
    /**
     * Self-hosted Langfuse (see docker-compose.yml + lib/observability/
     * langfuse.ts). All optional and unset by default: the worker must run
     * fine with zero Langfuse env (tracing degrades to a no-op client), so
     * this is deliberately NOT a `.refine()`-enforced all-or-nothing group.
     */
    LANGFUSE_PUBLIC_KEY: z.string().optional(),
    LANGFUSE_SECRET_KEY: z.string().optional(),
    LANGFUSE_BASE_URL: z.string().url().default("http://localhost:3005"),
    /** Cron pattern for the nightly golden-set eval run — see lib/eval/schedule.ts. */
    EVAL_NIGHTLY_CRON: z.string().default("0 3 * * *"),
    /**
     * Per-job chat-event replay log (lib/chat/publish.ts) — lets a client
     * that subscribes late, or reconnects mid-stream, recover events
     * published before it attached (pure pub/sub has no memory for that).
     * TTL bounds how long a finished job's log lingers in Redis; max length
     * is a safety valve against an unbounded list for a pathological job.
     */
    CHAT_EVENTS_LOG_TTL_MS: z.coerce.number().int().positive().default(600_000),
    CHAT_EVENTS_LOG_MAX_LEN: z.coerce.number().int().positive().default(5000),
  })
  .refine((e) => !(e.NODE_ENV === "production" && e.CONNECTOR_DEV_HOST), {
    message:
      "CONNECTOR_DEV_HOST must not be set when NODE_ENV=production — it overrides every connector service host to a dev-only address.",
    path: ["CONNECTOR_DEV_HOST"],
  });

export const env = EnvSchema.parse(process.env);
