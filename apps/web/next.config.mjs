import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Server-side only (never exposed to the browser bundle) — used purely as
// the rewrite target below. Deliberately NOT the NEXT_PUBLIC_ var of the
// same value: that one is inlined client-side for the (Bearer-token)
// Server Component -> apps/api calls in lib/api/server.ts, a separate,
// unrelated call path from this same-origin proxy.
const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4001';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Next's dev-mode corner badge otherwise overlaps the hero canvas's own
  // fullscreen chrome (status bar / tool rail) during local dev.
  devIndicators: false,
  transpilePackages: ['@nia/ui'],
  outputFileTracingRoot: path.join(__dirname, '../..'),
  experimental: {
    // Next's dev-server rewrite proxy caps proxied requests at 30s by
    // default (next/dist/server/lib/router-utils/proxy-request.js). The
    // copilot-agent tool-use loop (up to MAX_TOOL_CALLS sequential LLM
    // round-trips through apps/api's /copilot-agent, proxied same-origin
    // via the rewrite below) can legitimately take longer than that on a
    // multi-tool turn, which otherwise surfaces as a client-visible
    // ECONNRESET/"socket hang up" partway through — not a real failure,
    // just this proxy giving up early.
    proxyTimeout: 120_000,
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
