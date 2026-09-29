import { createAuthMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";

const VERIFY_PATHS = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-otp",
  "/two-factor/verify-backup-code",
]);

/**
 * Console v1 Slice 4 (docs/plans/console-plan.md §4b, decision 17): stamps
 * `session.twoFactorVerifiedAt` the moment a session passes ANY 2FA verify
 * endpoint.
 *
 * This covers both flows with a single matcher, no special-casing needed:
 *  - sign-in-time challenge (better-auth's own twoFactor() plugin redirects
 *    a pre-2FA session into a fresh one on success)
 *  - enrollment-time verify, performed while already signed in (confirmed
 *    by reading better-auth's own source,
 *    plugins/two-factor/index.mjs: `setSessionCookie` → `setNewSession` runs
 *    in both cases, so `ctx.context.newSession` is populated either way —
 *    there is no better-auth-side distinction between "verifying to
 *    complete sign-in" and "verifying to complete enrollment")
 *
 * Only stamps on success: this hook is registered under `hooks.after`,
 * which only runs once the endpoint itself has already produced a success
 * response — a rejected/incorrect code never reaches this handler, so a
 * failed verify attempt never stamps anything.
 */
export function twoFactorSession(): BetterAuthPlugin {
  return {
    id: "two-factor-session",
    schema: {
      session: {
        fields: {
          twoFactorVerifiedAt: {
            type: "date",
            required: false,
            input: false,
          },
        },
      },
    },
    hooks: {
      after: [
        {
          matcher(context) {
            return !!context.path && VERIFY_PATHS.has(context.path);
          },
          handler: createAuthMiddleware(async (ctx) => {
            const token = ctx.context.newSession?.session.token;
            if (!token) return;
            await ctx.context.internalAdapter.updateSession(token, {
              twoFactorVerifiedAt: new Date(),
            });
          }),
        },
      ],
    },
  };
}
