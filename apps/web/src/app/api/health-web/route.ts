import { NextResponse } from "next/server";

/**
 * Container healthcheck target for apps/web itself (Dockerfile's
 * HEALTHCHECK, docs/plans/web-container.md) — proves the Next.js server is
 * up and serving, nothing more. Deliberately does not touch Postgres or
 * apps/api: a healthcheck should reflect this container's own liveness,
 * not its dependencies'. Named "health-web" (not "health") to avoid any
 * ambiguity with apps/api's own GET /health if a future proxy config ever
 * routes /api/* to apps/api directly.
 */
export async function GET() {
  return NextResponse.json({ status: "ok", service: "@nia/web" });
}
