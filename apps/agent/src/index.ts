#!/usr/bin/env node
import { parseArgs } from "node:util";
import { addConnection, listConnections, removeConnection, testConnection } from "./cli/connectionCommands.js";
import { runSqlReadonly } from "./cli/sqlReadonlyCommand.js";
import { runDoctor } from "./cli/doctorCommand.js";
import { getStatus } from "./ops/state.js";
import { getSpoolUsage } from "./ops/spoolUsage.js";
import { versionString } from "./cli/versionCommand.js";
import { loadConfig } from "./config/store.js";
import { defaultSpoolDir } from "./config/paths.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

async function main(argv: string[]): Promise<void> {
  const [command, subcommand, ...rest] = argv;

  if (command === "version" || command === "--version" || command === "-v") {
    console.log(versionString());
    return;
  }

  if (command === "status") {
    const status = getStatus();
    if (!status.startedAt) {
      console.log("agent has not recorded a start yet (not running, or running under a different NIA_AGENT_HOME)");
    } else {
      console.log(`uptime: ${status.uptimeSeconds}s (started ${status.startedAt})`);
    }

    const config = loadConfig();
    const spoolDir = config.spoolDir ?? defaultSpoolDir();
    const spoolUsage = getSpoolUsage(spoolDir);
    console.log(`spool usage: ${formatBytes(spoolUsage.bytes)} across ${spoolUsage.fileCount} file(s) in ${spoolDir}`);

    const connectionIds = Object.keys(status.connections);
    if (connectionIds.length === 0) {
      console.log("no sync history yet");
    }
    for (const id of connectionIds) {
      const c = status.connections[id]!;
      const poll = c.lastPollAt ? `last poll ${c.lastPollAt}` : "no poll yet";
      const sync = c.lastSyncAt ? `last sync ${c.lastSyncAt} (${c.lastSyncRows} rows)` : "no sync yet";
      const error = c.lastError ? `, last error ${c.lastErrorAt}: ${c.lastError}${c.consecutiveFailures && c.consecutiveFailures > 1 ? ` (${c.consecutiveFailures} in a row)` : ""}` : "";
      console.log(`${id}: ${poll}, ${sync}${error}`);
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
        "ping-path": { type: "string" },
      },
    });
    const planometryUrl = values["planometry-url"] as string | undefined;
    const agentKey = values["agent-key"] as string | undefined;
    if (!values.id || !values.label || !values.host || !values.database || !values.user || !values.password || !planometryUrl || !agentKey) {
      console.error("usage: nia-agent connection add --id <id> --label <label> --host <host> --database <db> --user <user> --password <password> --planometry-url <url> --agent-key <key> [--port <n>] [--encrypt true|false] [--allow-legacy-tls true|false] [--trust-server-certificate true|false] [--heartbeat-path <path>] [--ping-path <path>]");
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
      pingPath: values["ping-path"] as string | undefined,
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

  if (command === "sql" && subcommand === "readonly") {
    const { values } = parseArgs({
      args: rest,
      options: {
        login: { type: "string" },
        databases: { type: "string" },
        schema: { type: "string" },
        "with-cancel-visibility": { type: "string" },
        out: { type: "string" },
      },
    });
    try {
      const script = runSqlReadonly({
        login: values.login as string | undefined,
        databases: values.databases as string | undefined,
        schema: values.schema as string | undefined,
        withCancelVisibility: toOptionalBool(values["with-cancel-visibility"] as string | undefined),
        out: values.out as string | undefined,
      });
      if (!values.out) console.log(script);
      else console.log(`wrote readonly setup script to ${values.out}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
    return;
  }

  if (command === "doctor") {
    const connectionId = subcommand;
    const reports = await runDoctor(connectionId);
    if (reports.length === 0) {
      console.log("no connections configured");
      return;
    }
    let anyFailed = false;
    for (const report of reports) {
      console.log(`${report.connectionId} (${report.label}):`);
      for (const check of report.checks) {
        const isWarning = !check.pass && check.severity === "warning";
        if (!check.pass && !isWarning) anyFailed = true;
        const status = check.pass ? "[PASS]" : isWarning ? "[WARN]" : "[FAIL]";
        const fix = check.fix ? ` (fix: ${check.fix})` : "";
        console.log(`  ${status} ${check.name} — ${check.detail}${fix}`);
      }
    }
    if (anyFailed) process.exitCode = 1;
    return;
  }

  console.error("usage: nia-agent connection <add|test|list|remove> ... | nia-agent sql readonly ... | nia-agent doctor [connectionId] | nia-agent status | nia-agent version");
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
