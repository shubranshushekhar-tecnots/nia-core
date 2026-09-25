import "dotenv/config";
import { z } from "zod";

/**
 * Fail fast on boot rather than surfacing a confusing runtime error the
 * first time a job touches the database or a connector service.
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
    /**
     * Direct Postgres for @nia/db (docs/plans/data-access.md). Same
     * connection apps/api uses; the worker always calls withServiceRole
     * (never withActingUser — it has no live user JWT).
     */
    DATABASE_URL: z.string().min(1),
    /**
     * Envelope-encryption master key for nia_secrets (lib/secretStore.ts) —
     * only used by lib/eval/sandbox.ts's golden-eval seeding, the worker's
     * one and only secret-writing call site. Must be byte-for-byte
     * identical to apps/api's and every connector-*'s copy (DEPLOYMENT.md),
     * since a connector service has to be able to decrypt whatever this
     * writes.
     */
    NIA_SECRET_MASTER_KEY: z.string().min(1),
    /**
     * `.min(1)` matters beyond documentation: docker-compose.prod.yml passes
     * this through as `${REDIS_URL}` with no compose-side fallback, so an
     * unset value becomes an empty string, not an absent key — `.default()`
     * alone only fires on `undefined`, not `""`. Without `.min(1)` that
     * would silently pass validation and only fail later, opaquely, on the
     * first real Redis call.
     */
    REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
    /**
     * Normalizes "" -> undefined: a compose override setting this to an
     * empty string (the usual way to un-leak it from a shared `env_file`
     * without deleting the key) must behave identically to it being fully
     * unset, both for the production `.refine()` guard below and for
     * every `env.CONNECTOR_DEV_HOST ?? manifest.service.host` fallback
     * read (connectorClient.ts, routeAwareness.ts) — an empty string
     * previously survived as a real value and silently produced
     * host-less connector URLs.
     */
    CONNECTOR_DEV_HOST: z
      .string()
      .optional()
      .transform((v) => (v === "" ? undefined : v)),
    /**
     * Phase 6 Block 2 — shared secret for the write-dispatch signed context
     * (see lib/writeSignature.ts). connector-supabase holds an identical
     * copy of the same helper + secret (its own env, not Zod-validated —
     * see that service's index.ts) and independently recomputes the HMAC
     * rather than trusting the worker's say-so — "worker-side check before
     * dispatch + connector-side re-check" from the kickoff spec. min(32)
     * is a floor, not a real strength guarantee; generate with e.g.
     * `openssl rand -hex 32`.
     */
    WRITE_DISPATCH_SIGNING_SECRET: z.string().min(32),
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
     * Cron pattern for the staging-registry sweep (Phase 11 item 12) — see
     * lib/etl/stagingSweepSchedule.ts. Hourly by default: this is how often
     * the sweep JOB runs, independent of the 24h staleness cutoff each
     * individual `staging_objects` row is judged against inside it (see
     * stagingSweeper.ts) — an hourly cadence just means an orphaned staging
     * table is never more than ~1h late to be swept once it crosses 24h,
     * not that anything under 24h old is ever touched.
     */
    STAGING_SWEEP_CRON: z.string().default("0 * * * *"),
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
