import { parsePairingInput } from "../../cli/pairingInput.js";
import { pair, InvalidPairingCodeError, InvalidPlatformUrlError, PairingRejectedError } from "../../link/pairing.js";
import { ApiError, BadRequestError } from "../errors.js";
import { RateLimiter } from "../rateLimit.js";
import type { LocalApiDeps } from "../deps.js";
import type { RouteDefinition } from "../router.js";

const PAIR_RATE_LIMIT = new RateLimiter(5, 60_000);

/**
 * `POST /pair { code, url? }`: same flexibility as the CLI wizard —
 * `code` may be a bare composite `<pairingCodeId>.<code>`, or a full
 * pasted `nia-agent pair --code ... --url ...` command string (in which
 * case `parsePairingInput` extracts both fields, and an explicit `url`
 * in the body still takes precedence over anything embedded in `code`).
 */
export function buildPairRoutes(deps: LocalApiDeps): RouteDefinition[] {
  return [
    {
      method: "POST",
      path: "/pair",
      rateLimiter: PAIR_RATE_LIMIT,
      handler: async (ctx) => {
        const body = (ctx.body ?? {}) as { code?: unknown; url?: unknown };
        if (typeof body.code !== "string" || body.code.trim().length === 0) {
          throw new BadRequestError("code is required");
        }

        const parsed = parsePairingInput(body.code);
        if (!parsed) throw new BadRequestError("code is not a recognized pairing code or pairing command");
        const url = typeof body.url === "string" && body.url.trim().length > 0 ? body.url : parsed.url;
        if (!url) throw new BadRequestError("url is required (either in the body or embedded in a pasted pairing command)");

        try {
          return await pair({ code: parsed.code, url }, deps.dir);
        } catch (err) {
          if (err instanceof InvalidPlatformUrlError || err instanceof InvalidPairingCodeError) {
            throw new BadRequestError(err.message);
          }
          if (err instanceof PairingRejectedError) {
            throw new ApiError(400, "pairingRejected", err.message);
          }
          throw err;
        }
      },
    },
  ];
}
