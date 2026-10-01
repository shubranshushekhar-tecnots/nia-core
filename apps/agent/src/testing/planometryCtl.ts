#!/usr/bin/env node
import { parseArgs } from "node:util";

/**
 * Control CLI for the foreground fake Planometry server
 * (`runFakePlanometryServer.ts`) — `fetch`s its control HTTP port.
 * `apps/agent/package.json`'s `manual:planometry:ctl` script is this
 * file's only caller.
 */

const CONTROL_PORT = Number(process.env.NIA_AGENT_FAKE_CONTROL_PORT ?? 4456);
const CONTROL_BASE_URL = `http://127.0.0.1:${CONTROL_PORT}`;

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${CONTROL_BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} failed with status ${res.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

function splitColumns(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

function parseFilter(value: string | undefined): unknown[] | undefined {
  if (value === undefined) return undefined;
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("--filter must be a JSON array");
  return parsed;
}

async function main(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;

  if (subcommand === "issue-key") {
    const result = (await post("/issue-key", {})) as { agentKey: string };
    console.log(result.agentKey);
    return;
  }

  if (subcommand === "queue" || subcommand === "refresh-catalog") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "connection-id": { type: "string" },
        "run-id": { type: "string" },
        table: { type: "string" },
        columns: { type: "string" },
        filter: { type: "string" },
        "catalog-requested": { type: "boolean" },
      },
    });
    const connectionId = values["connection-id"] as string | undefined;
    const runId = values["run-id"] as string | undefined;
    const table = values.table as string | undefined;
    if (!connectionId || !runId || !table) {
      console.error(`usage: planometryCtl ${subcommand} --connection-id <id> --run-id <id> --table <table> [--columns a,b] [--filter '[...]']${subcommand === "queue" ? " [--catalog-requested]" : ""}`);
      process.exitCode = 1;
      return;
    }
    await post(subcommand === "refresh-catalog" ? "/refresh-catalog" : "/queue", {
      connectionId,
      runId,
      table,
      columns: splitColumns(values.columns as string | undefined),
      filter: parseFilter(values.filter as string | undefined),
      catalogRequested: subcommand === "queue" ? Boolean(values["catalog-requested"]) : undefined,
    });
    console.log(`queued run ${runId} for connection ${connectionId}, table ${table}`);
    return;
  }

  if (subcommand === "fault-drop" || subcommand === "fault-409") {
    const { values } = parseArgs({ args: rest, options: { "run-id": { type: "string" }, seq: { type: "string" } } });
    const runId = values["run-id"] as string | undefined;
    const seq = values.seq as string | undefined;
    if (!runId || !seq) {
      console.error(`usage: planometryCtl ${subcommand} --run-id <id> --seq <n>`);
      process.exitCode = 1;
      return;
    }
    await post(subcommand === "fault-drop" ? "/fault/drop" : "/fault/409", { runId, seq: Number(seq) });
    console.log(`armed ${subcommand} for run ${runId} seq ${seq}`);
    return;
  }

  if (subcommand === "slow") {
    const { values } = parseArgs({ args: rest, options: { "poll-after": { type: "string" } } });
    const pollAfter = values["poll-after"] as string | undefined;
    if (!pollAfter) {
      console.error("usage: planometryCtl slow --poll-after <seconds>");
      process.exitCode = 1;
      return;
    }
    await post("/slow", { pollAfterSeconds: Number(pollAfter) });
    console.log(`empty polls now wait ${pollAfter}s`);
    return;
  }

  console.error("usage: planometryCtl <issue-key|queue|refresh-catalog|fault-drop|fault-409|slow> ...");
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
