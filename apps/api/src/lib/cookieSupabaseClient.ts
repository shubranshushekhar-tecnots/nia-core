import type { Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { parse as parseCookieHeader, serialize as serializeCookie } from "cookie";
import { env } from "../env.js";

/**
 * Express port of apps/web/src/lib/supabase/{server,middleware}.ts's cookie
 * adapter. Express has no built-in cookie jar, so getAll()/setAll() are
 * implemented directly against the raw Cookie request header and the
 * response's Set-Cookie header — same shape @supabase/ssr expects from any
 * runtime. Unlike the Next.js Server Component client, this one CAN write
 * cookies back (no framework restriction), so a mid-request token refresh
 * (expired access token, valid refresh token) transparently reissues fresh
 * Set-Cookie headers on the response — same as apps/web's middleware.ts,
 * just inline here since there's no separate "middleware" layer in Express.
 */
export function createCookieScopedSupabaseClient(req: Request, res: Response): SupabaseClient {
  // @supabase/ssr's createServerClient() resolves to a structurally-identical
  // but generically-looser SupabaseClient<...> than the bare SupabaseClient
  // type express.d.ts declares Request.supabase as (same package, same
  // runtime shape — just a generic-parameter mismatch between the two
  // packages' type declarations). Safe to assert back to the plain type.
  return createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        const header = req.headers.cookie;
        if (!header) return [];
        const parsed = parseCookieHeader(header);
        return Object.entries(parsed)
          .filter((entry): entry is [string, string] => entry[1] !== undefined)
          .map(([name, value]) => ({ name, value }));
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        const existing = res.getHeader("Set-Cookie");
        const prior = existing === undefined ? [] : Array.isArray(existing) ? existing.map(String) : [String(existing)];
        const next = cookiesToSet.map(({ name, value, options }) =>
          serializeCookie(name, value, options as Parameters<typeof serializeCookie>[2]),
        );
        res.setHeader("Set-Cookie", [...prior, ...next]);
      },
    },
  }) as unknown as SupabaseClient;
}
