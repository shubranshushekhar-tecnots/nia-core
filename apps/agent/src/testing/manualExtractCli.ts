#!/usr/bin/env node
import { parseArgs } from "node:util";
import { NdjsonWriter, type ExtractRequest } from "@nia/extract";
import { connect, introspectCatalog, streamExtract, type MssqlConnectionConfig } from "@nia/extract/mssql";
import { consumePlanometryStream } from "@nia/extract/testing";
import { defaultHomeDir } from "../config/paths.js";
import { findConnection, loadConfig } from "../config/store.js";
import type { ConnectionEntry } from "../config/types.js";
import { installGracefulShutdown } from "../ops/shutdown.js";
import { loadOrCreateMasterKey } from "../secrets/keyfile.js";
import { LocalSecretStore } from "../secrets/store.js";

/**
 * Direct extraction CLI for manual end-to-end testing
 * (docs/manual-testing/agent.md) — bypasses Planometry entirely, going
 * straight from a configured connection through the real `streamExtract`
 * pipeline into the real "fake pull client" (`consumePlanometryStream`,
 * `@nia/extract/testing`), so a human can see exactly what Planometry would
 * receive without a fake server or any sync/spool machinery involved.
 * `apps/agent/package.json`'s `manual:extract` script is this file's only
 * caller.
 */

function loadConnectionAndConfig(connectionId: string, dir = defaultHomeDir()): { entry: ConnectionEntry; sqlConfig: MssqlConnectionConfig } {
  const config = loadConfig(dir);
  const entry = findConnection(config, connectionId);
  if (!entry) throw new Error(`no connection with id ${JSON.stringify(connectionId)}`);

  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  const credentials = secrets.get<{ user: string; password: string }>(entry.credentialRef);
  if (!credentials) throw new Error(`credentials for ${connectionId} are missing from the secret store`);

  const sqlConfig: MssqlConnectionConfig = {
    server: entry.sqlserver.host,
    port: entry.sqlserver.port,
    database: entry.sqlserver.database,
    user: credentials.user,
    password: credentials.password,
    encrypt: entry.sqlserver.encrypt,
    allowLegacyTls: entry.sqlserver.allowLegacyTls,
    trustServerCertificate: entry.sqlserver.trustServerCertificate,
  };
  return { entry, sqlConfig };
}

function splitColumns(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

async function runCatalog(connectionId: string): Promise<void> {
  const { sqlConfig } = loadConnectionAndConfig(connectionId);
  const pool = await connect(sqlConfig);
  try {
    const catalog = await introspectCatalog(pool, "UTC");
    for (const table of catalog.tables) {
      console.log(`${table.name} (${table.kind})`);
      for (const col of table.columns) console.log(`  ${col.name}\t${col.type}${col.nullable ? "" : "\tNOT NULL"}`);
      for (const excluded of table.excluded) console.log(`  [excluded] ${excluded.name}\t${excluded.nativeType}\t${excluded.reason}`);
    }
  } finally {
    await pool.close();
  }
}

async function runExtract(connectionId: string, table: string, columns: string[], filter: unknown[], limit: number | undefined): Promise<void> {
  const { sqlConfig } = loadConnectionAndConfig(connectionId);
  const controller = new AbortController();
  const uninstall = installGracefulShutdown(controller, () => console.log("\ncancelling query..."));

  const pool = await connect(sqlConfig);
  const lines: string[] = [];
  try {
    const catalog = await introspectCatalog(pool, "UTC");
    const request: ExtractRequest = { table, columns, filter: filter as ExtractRequest["filter"] };
    const writer = new NdjsonWriter((chunk) => {
      lines.push(chunk);
    });
    await streamExtract(pool, catalog, request, writer, { signal: controller.signal, limit });
  } finally {
    await pool.close();
    uninstall();
  }

  async function* asLines(): AsyncIterable<string> {
    for (const line of lines) yield line;
  }
  const result = await consumePlanometryStream(asLines());

  console.log(`columns: ${result.columns.map((c) => `${c.name}:${c.type}`).join(", ")}`);
  console.log(`rows received: ${result.rows.length}`);
  console.log(`keep-alives: ${result.keepAlives}`);
  if (result.error) {
    console.log(`error: ${result.error}`);
    process.exitCode = 1;
  } else {
    console.log(`trailer row count: ${result.trailerRowCount}`);
  }
}

async function runCheckRunning(connectionId: string, match: string): Promise<void> {
  const { sqlConfig } = loadConnectionAndConfig(connectionId);
  const pool = await connect(sqlConfig);
  try {
    const result = await pool
      .request()
      .input("frag", `%${match}%`)
      .query<{ c: number }>(
        `SELECT COUNT(*) AS c
         FROM sys.dm_exec_requests r
         CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
         WHERE t.text LIKE @frag AND r.session_id <> @@SPID`,
      );
    const running = (result.recordset[0]?.c ?? 0) > 0;
    console.log(`running: ${running}`);
  } finally {
    await pool.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;

  if (subcommand === "catalog") {
    const { values } = parseArgs({ args: rest, options: { "connection-id": { type: "string" } } });
    const connectionId = values["connection-id"] as string | undefined;
    if (!connectionId) {
      console.error("usage: manualExtractCli catalog --connection-id <id>");
      process.exitCode = 1;
      return;
    }
    await runCatalog(connectionId);
    return;
  }

  if (subcommand === "extract") {
    const { values } = parseArgs({
      args: rest,
      options: {
        "connection-id": { type: "string" },
        table: { type: "string" },
        columns: { type: "string" },
        filter: { type: "string" },
        limit: { type: "string" },
      },
    });
    const connectionId = values["connection-id"] as string | undefined;
    const table = values.table as string | undefined;
    if (!connectionId || !table) {
      console.error("usage: manualExtractCli extract --connection-id <id> --table <table> [--columns a,b] [--filter '[...]'] [--limit n]");
      process.exitCode = 1;
      return;
    }
    const filter = values.filter ? JSON.parse(values.filter as string) : [];
    const limit = values.limit ? Number(values.limit) : undefined;
    await runExtract(connectionId, table, splitColumns(values.columns as string | undefined), filter, limit);
    return;
  }

  if (subcommand === "check-running") {
    const { values } = parseArgs({ args: rest, options: { "connection-id": { type: "string" }, match: { type: "string" } } });
    const connectionId = values["connection-id"] as string | undefined;
    const match = values.match as string | undefined;
    if (!connectionId || !match) {
      console.error("usage: manualExtractCli check-running --connection-id <id> --match <text>");
      process.exitCode = 1;
      return;
    }
    await runCheckRunning(connectionId, match);
    return;
  }

  console.error("usage: manualExtractCli <catalog|extract|check-running> ...");
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
