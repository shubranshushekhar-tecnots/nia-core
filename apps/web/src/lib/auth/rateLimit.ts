import { Redis } from "ioredis";
import { headers } from "next/headers";

/**
 * apps/web has no Express layer to hold a module-level singleton that's
 * safe to construct at import time — `next build`'s page-data-collection
 * step imports every route module without REDIS_URL set, so the
 * connection must not be constructed at module-import time. Same
 * lazy-singleton rationale as lib/mail/mailQueue.ts's getMailQueue() /
 * lib/db/pool.ts's getPool().
 */
let redis: Redis | undefined;

export function getRedis(): Redis {
  if (!redis) {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error("REDIS_URL is not set");
    }
    redis = new Redis(redisUrl);
  }
  return redis;
}

/**
 * deploy/nginx/nginx.conf always sets X-Real-IP from $remote_addr and
 * X-Forwarded-For via $proxy_add_x_forwarded_for in front of this app —
 * both trustworthy since nginx is our own front door, not a client-
 * controlled passthrough. In local dev (no nginx in front) both headers
 * are simply absent, so every request collapses into the same "unknown"
 * IP bucket — rate limiting still applies, just coarsely, which is fine
 * for dev.
 */
export async function getClientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return h.get("x-real-ip") ?? "unknown";
}

const WINDOW_SECONDS = 15 * 60;
// Per-IP ceiling is deliberately looser than the per-email one — it exists
// to catch a single IP spraying many different target emails, not to
// compete with the per-email limit for a single legitimate user.
const IP_LIMIT_MULTIPLIER = 4;

/**
 * Fixed-window counter via INCR+EXPIRE (EXPIRE only set on the very first
 * hit of the window, so a later hit never resets/extends it). Fails OPEN
 * (never reports "limited") on any Redis error — a Redis outage must
 * never itself lock every user out of sign-in.
 */
async function hitLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  try {
    const client = getRedis();
    const count = await client.incr(key);
    if (count === 1) {
      await client.expire(key, windowSeconds);
    }
    return count > limit;
  } catch {
    return false;
  }
}

/**
 * Email Phase 2 review fix: per-email AND per-IP limits on every OTP
 * request/verify Server Action (requestLoginCode, loginWithCode,
 * requestPasswordReset, resetPasswordWithCode). better-auth's own
 * `allowedAttempts: 3` (packages/auth/src/config.ts) only bounds attempts
 * against a single already-issued code — it says nothing about how many
 * codes an attacker can request, or how many separate codes they can try,
 * within a given window. Every caller must return the exact same response
 * shape it would return for a "normal" miss (see each action's own
 * comment) so a rate-limited response is never distinguishable from an
 * invalid code / a nonexistent account — that's what keeps this additive
 * to the no-enumeration contract instead of undermining it.
 */
export async function isAuthActionRateLimited(action: string, email: string, limit: number): Promise<boolean> {
  const ip = await getClientIp();
  const [emailLimited, ipLimited] = await Promise.all([
    hitLimit(`ratelimit:${action}:email:${email.toLowerCase()}`, limit, WINDOW_SECONDS),
    hitLimit(`ratelimit:${action}:ip:${ip}`, limit * IP_LIMIT_MULTIPLIER, WINDOW_SECONDS),
  ]);
  return emailLimited || ipLimited;
}
