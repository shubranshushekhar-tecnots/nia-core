import { buildApp } from "./app.js";
import { checkDbReachable } from "./db.js";

const app = buildApp();

// Same self-exec guard as services/connector-mysql/src/index.ts — importing
// this module for tests (app.inject()) must never bind a real socket.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4040);
  checkDbReachable()
    .then(() => app.listen({ port, host: "0.0.0.0" }))
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });

  const shutdown = () => {
    app.log.info("shutting down…");
    app
      .close()
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

export { app };
