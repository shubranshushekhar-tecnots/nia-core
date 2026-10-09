import http from "node:http";
import type { Logger } from "../ops/logger.js";
import { writePortFile } from "./portFile.js";
import { createRouter, type RouteDefinition } from "./router.js";

/** Unregistered, and confirmed unused elsewhere in this repo (grepped against 3306/5432/14330/4455/4456/etc.). */
export const DEFAULT_LOCAL_API_PORT = 57415;
/** Default port, then +1..+9 — ten attempts total. */
const MAX_PORT_ATTEMPTS = 10;

export interface LocalApiServerOptions {
  dir: string;
  apiToken: string;
  routes: RouteDefinition[];
  logger: Logger;
}

export interface LocalApiServerHandle {
  port: number;
  close: () => Promise<void>;
}

type BindOutcome = "bound" | "inUse" | "error";

function tryListen(server: http.Server, port: number): Promise<BindOutcome> {
  return new Promise((resolve) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener("error", onError);
      resolve(err.code === "EADDRINUSE" ? "inUse" : "error");
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve("bound");
    });
  });
}

/**
 * Binds **127.0.0.1 only** — tries `DEFAULT_LOCAL_API_PORT` then +1..+9
 * on `EADDRINUSE`. Any other bind error, or a bound address that isn't
 * literally `127.0.0.1` (paranoid double-check), aborts immediately —
 * this never falls back to `0.0.0.0`. Returns `undefined` instead of
 * throwing in every failure case: the rest of `nia-agent start` (jobs,
 * scheduler, check-in loop) must keep running even if the local API
 * never binds (see agentLoop.ts's caller).
 */
export async function createLocalApiServer(options: LocalApiServerOptions): Promise<LocalApiServerHandle | undefined> {
  const handleRequest = createRouter(options.routes, options.apiToken);
  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const port = DEFAULT_LOCAL_API_PORT + attempt;
    const outcome = await tryListen(server, port);

    if (outcome === "inUse") continue;

    if (outcome === "error") {
      options.logger.error("local_api_bind_failed", { port });
      return undefined;
    }

    const address = server.address();
    if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
      options.logger.error("local_api_bind_unsafe_address", { address: JSON.stringify(address) });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return undefined;
    }

    writePortFile(port, options.dir);
    options.logger.info("local_api_listening", { port });
    return {
      port,
      // Plain `server.close()` only stops accepting new connections -- it
      // waits indefinitely for any already-open keep-alive socket to end on
      // its own (there's no server-initiated timeout unless one is set).
      // A client that opened a connection and never sends another request
      // would otherwise hang `nia-agent stop`/restart forever. Force every
      // socket (idle or active) closed immediately instead.
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    };
  }

  options.logger.error("local_api_bind_exhausted", { attempts: MAX_PORT_ATTEMPTS, startPort: DEFAULT_LOCAL_API_PORT });
  return undefined;
}
