#!/usr/bin/env node
import { parseArgs } from "node:util";
import { addConnection, listConnections, removeConnection, testConnection } from "./cli/connectionCommands.js";
import { getStatus } from "./ops/state.js";

async function main(argv: string[]): Promise<void> {
  const [command, subcommand, ...rest] = argv;

  if (command === "status") {
    const status = getStatus();
    if (!status.startedAt) {
      console.log("agent has not recorded a start yet (not running, or running under a different NIA_AGENT_HOME)");
    } else {
      console.log(`uptime: ${status.uptimeSeconds}s (started ${status.startedAt})`);
    }
    const connectionIds = Object.keys(status.connections);
    if (connectionIds.length === 0) {
      console.log("no sync history yet");
    }
    for (const id of connectionIds) {
      const c = status.connections[id]!;
      const sync = c.lastSyncAt ? `last sync ${c.lastSyncAt} (${c.lastSyncRows} rows)` : "no sync yet";
      const error = c.lastError ? `, last error ${c.lastErrorAt}: ${c.lastError}` : "";
      console.log(`${id}: ${sync}${error}`);
    }
    return;
  }

  if (command === "connection" && subcommand === "add") {
    const { values } = parseArgs({
      args: rest,
      options: {
        id: { type: "string" },
        label: { type: "string" },
        host: { type: "string" },
        port: { type: "string" },
        database: { type: "string" },
        user: { type: "string" },
        password: { type: "string" },
        encrypt: { type: "string" },
        "allow-legacy-tls": { type: "string" },
        "trust-server-certificate": { type: "string" },
        "planometry-url": { type: "string" },
        "agent-key": { type: "string" },
        "heartbeat-path": { type: "string" },
      },
    });
    const planometryUrl = values["planometry-url"] as string | undefined;
    const agentKey = values["agent-key"] as string | undefined;
    if (!values.id || !values.label || !values.host || !values.database || !values.user || !values.password || !planometryUrl || !agentKey) {
      console.error("usage: nia-agent connection add --id <id> --label <label> --host <host> --database <db> --user <user> --password <password> --planometry-url <url> --agent-key <key> [--port <n>] [--encrypt true|false] [--allow-legacy-tls true|false] [--trust-server-certificate true|false] [--heartbeat-path <path>]");
      process.exitCode = 1;
      return;
    }
    const entry = addConnection({
      id: values.id as string,
      label: values.label as string,
      host: values.host as string,
      port: values.port ? Number(values.port) : undefined,
      database: values.database as string,
      user: values.user as string,
      password: values.password as string,
      encrypt: toOptionalBool(values.encrypt as string | undefined),
      allowLegacyTls: toOptionalBool(values["allow-legacy-tls"] as string | undefined),
      trustServerCertificate: toOptionalBool(values["trust-server-certificate"] as string | undefined),
      planometryBaseUrl: planometryUrl,
      agentKey,
      heartbeatPath: values["heartbeat-path"] as string | undefined,
    });
    console.log(`added connection ${entry.id} (${entry.label})`);
    return;
  }

  if (command === "connection" && subcommand === "list") {
    for (const entry of listConnections()) {
      console.log(`${entry.id}\t${entry.label}\t${entry.sqlserver.host}:${entry.sqlserver.port ?? 1433}/${entry.sqlserver.database}`);
    }
    return;
  }

  if (command === "connection" && subcommand === "remove") {
    const id = rest[0];
    if (!id) {
      console.error("usage: nia-agent connection remove <id>");
      process.exitCode = 1;
      return;
    }
    const removed = removeConnection(id);
    console.log(removed ? `removed connection ${id}` : `no connection with id ${id}`);
    return;
  }

  if (command === "connection" && subcommand === "test") {
    const id = rest[0];
    if (!id) {
      console.error("usage: nia-agent connection test <id>");
      process.exitCode = 1;
      return;
    }
    const result = await testConnection(id);
    if (result.ok) {
      console.log(`ok: connected, ${result.tableCount} table(s)/view(s) visible`);
    } else {
      console.error(`failed: ${result.error}`);
      process.exitCode = 1;
    }
    return;
  }

  console.error("usage: nia-agent connection <add|test|list|remove> ... | nia-agent status");
  process.exitCode = 1;
}

function toOptionalBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === "true";
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
