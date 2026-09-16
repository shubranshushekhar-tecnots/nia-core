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
  transpilePackages: ['@nia/ui'],
  outputFileTracingRoot: path.join(__dirname, '../..'),
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
