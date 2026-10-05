import type { Client } from "pg";
import { buildApp } from "./app.js";
import { buildInternalApp } from "./internalApp.js";
import { checkDbReachable, dbPool } from "./db.js";
import { startAgentSetupNotifyListener } from "./notifyListener.js";
import { withServiceRole } from "@nia/db";

const app = buildApp();
const internalApp = buildInternalApp();

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Plan point 6 — mirrors apps/api/src/lib/sse.ts's existing use of a plain
 * setInterval for a periodic in-process task (no BullMQ precedent exists
 * outside apps/worker, which is off-limits for this slice).
 */
function cleanupFinishedTasks(): void {
  withServiceRole(dbPool, (db) =>
    db.query(
      `delete from public.agent_tasks
       where status in ('done', 'failed') and completed_at < now() - interval '7 days'`,
    ),
  ).catch((err) => app.log.error(err, "agent_tasks cleanup failed"));
}

// Same self-exec guard as services/connector-mysql/src/index.ts — importing
// this module for tests (app.inject()) must never bind a real socket.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4040);
  // Never published through nginx or docker-compose's `ports:` — this is
  // apps/api's only path to the sqlserver_agent connector's /test,
  // /introspect, /execute (see internalApp.ts's header comment).
  const internalPort = Number(process.env.INTERNAL_PORT ?? 4041);

  let notifyClient: Client | undefined;

  checkDbReachable()
    .then(() =>
      Promise.all([
        app.listen({ port, host: "0.0.0.0" }),
        internalApp.listen({ port: internalPort, host: "0.0.0.0" }),
        startAgentSetupNotifyListener(process.env.DATABASE_URL ?? "").then((client) => {
          notifyClient = client;
        }),
      ]),
    )
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });

  const cleanupTimer = setInterval(cleanupFinishedTasks, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  const shutdown = () => {
    app.log.info("shutting down…");
    clearInterval(cleanupTimer);
    Promise.all([app.close(), internalApp.close(), notifyClient?.end()])
      .then(() => process.exit(0))
      .catch((err) => {
        app.log.error(err);
        process.exit(1);
      });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export { app, internalApp };
