import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Payments kill switch (PAYMENTS_ENABLED, docs/plans/subscription-model.md
 * Phase 4): a deploy with the flag unset/false must boot with none of the
 * five RAZORPAY_* vars set — stubbed here as "" rather than literally
 * deleted, since that's the realistic shape docker-compose.prod.yml's
 * `${VAR:-}` default produces for an unset var, not `undefined`. Flipping
 * the flag on without all five set must fail fast at boot with a message
 * naming the missing var.
 *
 * env.ts parses process.env once at module load (`export const env =
 * EnvSchema.parse(process.env)`), so each case needs its own vi.stubEnv +
 * vi.resetModules() + dynamic re-import — same convention as index.test.ts's
 * CONSOLE_ENABLED suite. Every other required var (DATABASE_URL, API_URL,
 * BETTER_AUTH_SECRET, ...) already comes from apps/api/.env (loaded via
 * env.ts's own `import "dotenv/config"`) plus vitest.config.ts's `test.env`
 * block, so this file only needs to touch the payments-specific vars.
 */
const RAZORPAY_KEYS = [
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "RAZORPAY_PRO_MONTHLY_PLAN_ID",
  "RAZORPAY_PRO_YEARLY_PLAN_ID",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("env.ts PAYMENTS_ENABLED kill switch", () => {
  it("boots with PAYMENTS_ENABLED unset and every RAZORPAY_* empty", async () => {
    for (const key of RAZORPAY_KEYS) vi.stubEnv(key, "");
    vi.resetModules();

    const { env } = await import("./env.js");
    expect(env.PAYMENTS_ENABLED).toBe(false);
  });

  it("boots with PAYMENTS_ENABLED=true and every RAZORPAY_* set", async () => {
    vi.stubEnv("PAYMENTS_ENABLED", "true");
    for (const key of RAZORPAY_KEYS) vi.stubEnv(key, `test-${key}`);
    vi.resetModules();

    const { env } = await import("./env.js");
    expect(env.PAYMENTS_ENABLED).toBe(true);
    expect(env.RAZORPAY_KEY_ID).toBe("test-RAZORPAY_KEY_ID");
  });

  it("fails fast naming the missing var when PAYMENTS_ENABLED=true but one RAZORPAY_* is empty", async () => {
    vi.stubEnv("PAYMENTS_ENABLED", "true");
    for (const key of RAZORPAY_KEYS) vi.stubEnv(key, `test-${key}`);
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "");
    vi.resetModules();

    await expect(import("./env.js")).rejects.toThrow(
      /RAZORPAY_WEBHOOK_SECRET is required when PAYMENTS_ENABLED=true/,
    );
  });
});
