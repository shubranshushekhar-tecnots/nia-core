import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Internal, Docker-network address of apps/api — same var lib/api/server.ts
// and lib/api/chatServer.ts read for their own direct (bearer/cookie)
// calls. Deliberately not NEXT_PUBLIC_-prefixed: never inlined into the
// client bundle.
//
// Unlike server.ts/chatServer.ts (plain runtime process.env reads), this
// one IS effectively baked at build time: Next's standalone output calls
// rewrites() once during `next build` and freezes the resolved destination
// as a literal string in the generated server.js — setting this env var at
// container start has no effect here. apps/web/Dockerfile sets it before
// `next build` accordingly. That's fine: the value is a fixed Docker-
// network hostname (niacore-api), identical in every environment, not a
// real per-deployment config value — same contract as the connector
// aliases. The 'http://localhost:4001' fallback below only matters for
// local `next dev`.
const API_ORIGIN = process.env.API_INTERNAL_URL ?? 'http://localhost:4001';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Playwright's own webServer (apps/web/playwright.config.ts) sets this
  // when it has to build its own throwaway dev server — isolates its
  // build cache from the default `.next` folder owned by whichever other
  // `next dev` process is already running, so the two never corrupt each
  // other's build. Unset (the common case: reusing an already-running
  // dev server) falls back to Next's own default.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Next's dev-mode corner badge otherwise overlaps the hero canvas's own
  // fullscreen chrome (status bar / tool rail) during local dev.
  devIndicators: false,
  transpilePackages: ['@nia/ui'],
  outputFileTracingRoot: path.join(__dirname, '../..'),
  experimental: {
    // Next's rewrite proxy caps proxied requests at 30s by default
    // (next/dist/server/lib/router-utils/proxy-request.js). Several routes
    // proxied same-origin via the rewrite below legitimately run longer:
    // the copilot-agent tool-use loop (up to MAX_TOOL_CALLS sequential LLM
    // round-trips through apps/api's /copilot-agent), and — the longest —
    // GET /workflows/:id/run/stream, whose server-side bound is apps/api's
    // own RUN_SSE_MAX_DURATION_MS (default 1_800_000ms/30min, env.ts). Set
    // to match that upper bound so the proxy never cuts a run stream off
    // before apps/api's own SSE lifecycle would; keep in sync if that
    // default ever changes. Below the real bound, this otherwise surfaces
    // as a client-visible ECONNRESET/"socket hang up" partway through —
    // not a real failure, just this proxy giving up early.
    proxyTimeout: 1_800_000,
  },
  async rewrites() {
    return [
      // Same-origin proxy so the browser's httpOnly Supabase session
      // cookies flow to apps/api's cookie-authenticated chat routes
      // without CORS. Chat is the only consumer today (POST /chat,
      // GET /chat/stream) — this is intentionally a generic prefix, not a
      // chat-specific one, so any future same-origin-only API route can
      // reuse it.
      {
        source: '/api/backend/:path*',
        destination: `${API_ORIGIN}/:path*`,
      },
    ];
  },
};

export default nextConfig;
