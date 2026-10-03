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

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${CONTROL_BASE_URL}${path}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} failed with status ${res.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function main(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;

  if (subcommand === "create-table") {
    const { values } = parseArgs({
      args: rest,
      options: { id: { type: "string" }, name: { type: "string" }, columns: { type: "string" }, "max-rows": { type: "string" } },
    });
    const columnsJson = values.columns as string | undefined;
    if (!columnsJson) {
      console.error(`usage: planometryCtl create-table --columns '[{"name":"id","type":"Text","isKey":true}]' [--id ds-1] [--name "My Table"] [--max-rows 50000]`);
      process.exitCode = 1;
      return;
    }
    const result = await post("/create-table", {
      id: values.id,
      name: values.name,
      columns: JSON.parse(columnsJson),
      maxRowsPerRequest: values["max-rows"] ? Number(values["max-rows"]) : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "inject-fault") {
    const { values } = parseArgs({ args: rest, options: { "table-id": { type: "string" }, fault: { type: "string" }, times: { type: "string" } } });
    const tableId = values["table-id"] as string | undefined;
    const faultArg = values.fault as string | undefined;
    if (!tableId || !faultArg) {
      console.error(`usage: planometryCtl inject-fault --table-id <id> --fault <401|404|400|500|dropBefore|dropAfter|'{"type":"delay","ms":1000}'> [--times 1]`);
      process.exitCode = 1;
      return;
    }
    const fault = ["401", "404", "400", "500", "dropBefore", "dropAfter"].includes(faultArg) ? faultArg : JSON.parse(faultArg);
    await post("/inject-fault", { tableId, fault, times: values.times ? Number(values.times) : undefined });
    console.log(`armed fault ${faultArg} for table ${tableId}`);
    return;
  }

  if (subcommand === "rows") {
    const { values } = parseArgs({ args: rest, options: { "table-id": { type: "string" } } });
    const tableId = values["table-id"] as string | undefined;
    if (!tableId) {
      console.error("usage: planometryCtl rows --table-id <id>");
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(await get(`/rows?tableId=${encodeURIComponent(tableId)}`), null, 2));
    return;
  }

  if (subcommand === "open-load") {
    const { values } = parseArgs({ args: rest, options: { "table-id": { type: "string" } } });
    const tableId = values["table-id"] as string | undefined;
    if (!tableId) {
      console.error("usage: planometryCtl open-load --table-id <id>");
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(await get(`/open-load?tableId=${encodeURIComponent(tableId)}`), null, 2));
    return;
  }

  console.error("usage: planometryCtl <create-table|inject-fault|rows|open-load> ...");
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
