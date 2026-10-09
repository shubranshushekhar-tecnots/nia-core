import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { defaultLogDir } from "../../config/paths.js";
import { BadRequestError } from "../errors.js";
import type { LocalApiDeps } from "../deps.js";
import type { RouteDefinition } from "../router.js";

const LOG_FILE_NAME = "agent.log";
/** How often `GET /logs/stream` re-stats the log file for new bytes -- `fs.watch` is flaky cross-platform (this repo's own prior experience), a short poll is simple and reliable. */
const POLL_INTERVAL_MS = 500;

function readLogLines(dir: string): string[] {
  const file = path.join(defaultLogDir(dir), LOG_FILE_NAME);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

interface ParsedLogLine {
  ts: string;
  level: string;
  event: string;
  [key: string]: unknown;
}

function parseLine(line: string): ParsedLogLine | undefined {
  try {
    return JSON.parse(line) as ParsedLogLine;
  } catch {
    return undefined;
  }
}

function matchesFilters(entry: ParsedLogLine, level: string | null, search: string | null, since: string | null): boolean {
  if (level && entry.level !== level) return false;
  if (since && entry.ts < since) return false;
  if (search && !JSON.stringify(entry).toLowerCase().includes(search.toLowerCase())) return false;
  return true;
}

/** `GET /logs?level=&search=&since=` (filters applied in memory, newest-last) and `GET /logs/stream` (SSE, poll-based tail; the one route allowed to authenticate via `?token=` since `EventSource` can't set headers). */
export function buildLogsRoutes(deps: LocalApiDeps): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/logs",
      handler: (ctx) => {
        const level = ctx.query.get("level");
        if (level && level !== "info" && level !== "warn" && level !== "error") {
          throw new BadRequestError('level must be "info", "warn", or "error"');
        }
        const search = ctx.query.get("search");
        const since = ctx.query.get("since");

        const entries = readLogLines(deps.dir)
          .map(parseLine)
          .filter((e): e is ParsedLogLine => e !== undefined)
          .filter((e) => matchesFilters(e, level, search, since));
        return { entries };
      },
    },
    {
      method: "GET",
      path: "/logs/stream",
      allowQueryToken: true,
      sse: (_ctx, res: ServerResponse) => {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });

        const file = path.join(defaultLogDir(deps.dir), LOG_FILE_NAME);
        let knownSize = fs.existsSync(file) ? fs.statSync(file).size : 0;

        const poll = setInterval(() => {
          if (!fs.existsSync(file)) return;
          const size = fs.statSync(file).size;
          if (size < knownSize) {
            // Rotated out from under us -- resume from the start of the new file rather than erroring.
            knownSize = 0;
          }
          if (size > knownSize) {
            const stream = fs.createReadStream(file, { start: knownSize, end: size - 1, encoding: "utf8" });
            let buffered = "";
            stream.on("data", (chunk) => {
              buffered += chunk;
            });
            stream.on("end", () => {
              for (const line of buffered.split("\n")) {
                if (line.length > 0) res.write(`data: ${line}\n\n`);
              }
            });
            knownSize = size;
          }
        }, POLL_INTERVAL_MS);

        res.on("close", () => clearInterval(poll));
      },
    },
  ];
}
