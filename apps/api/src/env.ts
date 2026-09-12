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
});

export const env = EnvSchema.parse(process.env);
