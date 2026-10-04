#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { addConnection, ConnectionInUseError, listConnections, removeConnection, testConnection } from "./cli/connectionCommands.js";
import { addJob, listJobs, pauseJob, removeJob, resumeJob, testJob, updateJob } from "./cli/jobCommands.js";
import type { WatermarkColumnReport } from "./sync/watermark.js";
import { runJob } from "./cli/runJobCommand.js";
import { parseMapOverrides } from "./cli/jobMapping.js";
import { parseParamOverrides, type JobFilterCondition } from "./planometry/parameters.js";
import { readSecretFromStdin } from "./cli/securePrompt.js";
import { runSqlReadonly } from "./cli/sqlReadonlyCommand.js";
import { listPausedJobs, runDoctor, runJobDoctor } from "./cli/doctorCommand.js";
import { runHealthcheck } from "./cli/healthcheckCommand.js";
import { jobHealthState, getStatus } from "./ops/state.js";
import { getSpoolUsage } from "./ops/spoolUsage.js";
import { installGracefulShutdown } from "./ops/shutdown.js";
import { versionString } from "./cli/versionCommand.js";
import { loadConfig } from "./config/store.js";
import { defaultSpoolDir } from "./config/paths.js";
import { runAgentLoop } from "./agentLoop.js";
import { AGENT_VERSION } from "./generated/version.js";

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

    const jobIds = Object.keys(status.jobs);
    if (jobIds.length === 0) {
      console.log("no job history yet");
    }
    let anyUnhealthy = false;
    for (const id of jobIds) {
      const job = status.jobs[id]!;
      const health = jobHealthState(job);
      if (health === "paused" || job.consecutiveFailures >= 3) anyUnhealthy = true;
      const run = job.lastRunAt ? `last run ${job.lastRunAt} (${job.lastResult})` : "no run yet";
      const success = job.lastSuccessAt ? `last success ${job.lastSuccessAt} (${job.rowsSent ?? 0} rows, ${job.durationMs ?? 0}ms)` : "no success yet";
      const paused = job.paused ? `, paused since ${job.paused.at}: ${job.paused.reason}` : "";
      const error = job.lastError ? `, last error ${job.lastError.at} [${job.lastError.class}]: ${job.lastError.message}${job.consecutiveFailures > 1 ? ` (${job.consecutiveFailures} in a row)` : ""}` : "";
      const next = job.nextRunAt ? `, next run ${job.nextRunAt}` : "";
      console.log(`${id} [${health}]: ${run}, ${success}${error}${paused}${next}`);
    }
    if (anyUnhealthy) process.exitCode = 1;
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
        "source-timezone": { type: "string" },
        "agent-key": { type: "string" },
      },
    });
    const sourceTimeZone = values["source-timezone"] as string | undefined;
    const agentKey = values["agent-key"] as string | undefined;
    if (!values.id || !values.label || !values.host || !values.database || !values.user || !values.password || !sourceTimeZone || !agentKey) {
      console.error("usage: nia-agent connection add --id <id> --label <label> --host <host> --database <db> --user <user> --password <password> --source-timezone <iana-name> --agent-key <key> [--port <n>] [--encrypt true|false] [--allow-legacy-tls true|false] [--trust-server-certificate true|false]");
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
      sourceTimeZone,
      agentKey,
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
    try {
      const removed = removeConnection(id);
      console.log(removed ? `removed connection ${id}` : `no connection with id ${id}`);
    } catch (err) {
      if (err instanceof ConnectionInUseError) {
        console.error(`cannot remove connection ${id}: still used by job(s) ${err.jobIds.join(", ")} — remove those jobs first`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
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
    if (reports.length === 0 && connectionId === undefined) {
      console.log("no connections configured");
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

    if (connectionId === undefined) {
      const jobReports = await runJobDoctor();
      for (const report of jobReports) {
        console.log(`${report.jobId} (${report.name}):`);
        for (const check of report.checks) {
          if (!check.pass) anyFailed = true;
          const status = check.pass ? "[PASS]" : "[FAIL]";
          console.log(`  ${status} ${check.name} — ${check.detail}`);
        }
      }

      const paused = listPausedJobs();
      if (paused.length > 0) {
        console.log("paused jobs:");
        for (const p of paused) console.log(`  ${p.jobId} (${p.name}) — paused since ${p.since}: ${p.reason}`);
      }
    }

    if (anyFailed) process.exitCode = 1;
    return;
  }

  if (command === "job" && subcommand === "add") {
    const { values } = parseArgs({
      args: rest,
      options: {
        connection: { type: "string" },
        table: { type: "string" },
        "target-url": { type: "string" },
        name: { type: "string" },
        map: { type: "string", multiple: true },
        yes: { type: "boolean" },
        "on-null-key": { type: "string" },
        "allow-empty-replace": { type: "boolean" },
        filter: { type: "string" },
        "filter-file": { type: "string" },
        param: { type: "string", multiple: true },
        schedule: { type: "string" },
        strategy: { type: "string" },
        "watermark-column": { type: "string" },
        "overlap-seconds": { type: "string" },
        "replace-schedule": { type: "string" },
        "delete-mode": { type: "string" },
        "max-delete-percent": { type: "string" },
        "reconcile-schedule": { type: "string" },
      },
    });
    const connectionId = values.connection as string | undefined;
    const table = values.table as string | undefined;
    const targetUrl = values["target-url"] as string | undefined;
    if (!connectionId || !table || !targetUrl) {
      console.error("usage: nia-agent job add --connection <id> --table <name> --target-url <url> [--name <text>] [--map source=target ...] [--on-null-key stop|skip] [--allow-empty-replace] [--filter <json>|--filter-file <path>] [--param name=value ...] [--schedule <cron>] [--strategy replace|upsertDelta] [--watermark-column <name>] [--overlap-seconds <n>] [--replace-schedule <cron>] [--delete-mode none|reconciliation] [--max-delete-percent <n>] [--reconcile-schedule <cron>] [--yes]");
      process.exitCode = 1;
      return;
    }
    const onNullKey = parseOnNullKey(values["on-null-key"] as string | undefined);
    if (onNullKey === undefined && values["on-null-key"] !== undefined) {
      console.error(`--on-null-key must be "stop" or "skip", got ${JSON.stringify(values["on-null-key"])}`);
      process.exitCode = 1;
      return;
    }
    const strategy = parseStrategy(values.strategy as string | undefined);
    if (strategy === undefined && values.strategy !== undefined) {
      console.error(`--strategy must be "replace" or "upsertDelta", got ${JSON.stringify(values.strategy)}`);
      process.exitCode = 1;
      return;
    }
    const overlapSecondsRaw = values["overlap-seconds"] as string | undefined;
    const overlapSeconds = overlapSecondsRaw !== undefined ? Number(overlapSecondsRaw) : undefined;
    if (overlapSecondsRaw !== undefined && (overlapSeconds === undefined || Number.isNaN(overlapSeconds))) {
      console.error(`--overlap-seconds must be a number, got ${JSON.stringify(overlapSecondsRaw)}`);
      process.exitCode = 1;
      return;
    }
    const deleteMode = parseDeleteMode(values["delete-mode"] as string | undefined);
    if (deleteMode === undefined && values["delete-mode"] !== undefined) {
      console.error(`--delete-mode must be "none" or "reconciliation", got ${JSON.stringify(values["delete-mode"])}`);
      process.exitCode = 1;
      return;
    }
    const maxDeletePercentRaw = values["max-delete-percent"] as string | undefined;
    const maxDeletePercent = maxDeletePercentRaw !== undefined ? Number(maxDeletePercentRaw) : undefined;
    if (maxDeletePercentRaw !== undefined && (maxDeletePercent === undefined || Number.isNaN(maxDeletePercent))) {
      console.error(`--max-delete-percent must be a number, got ${JSON.stringify(maxDeletePercentRaw)}`);
      process.exitCode = 1;
      return;
    }
    let filter: JobFilterCondition[] | undefined;
    try {
      filter = parseFilterArg(values.filter as string | undefined, values["filter-file"] as string | undefined);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    let params: Record<string, string> | undefined;
    try {
      params = parseParamOverrides((values.param as string[] | undefined) ?? []);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    const pushKey = await readSecretFromStdin("Planometry push key: ");
    const result = await addJob({
      name: (values.name as string | undefined) ?? table,
      connectionId,
      sourceTable: table,
      targetUrl,
      pushKey,
      mapOverrides: parseMapOverrides((values.map as string[] | undefined) ?? []),
      onNullKey,
      allowEmptyReplace: values["allow-empty-replace"] as boolean | undefined,
      filter,
      params,
      schedule: values.schedule as string | undefined,
      strategy,
      watermarkColumn: values["watermark-column"] as string | undefined,
      overlapSeconds,
      replaceSchedule: values["replace-schedule"] as string | undefined,
      deleteMode,
      maxDeletePercent,
      reconcileSchedule: values["reconcile-schedule"] as string | undefined,
    }, {
      onPlan: (plan) => {
        console.log("mapping:");
        for (const pair of plan.pairs) console.log(`  ${pair.source} -> ${pair.target}`);
        if (plan.sentAsNull.length > 0) console.log(`target columns sent as null: ${plan.sentAsNull.join(", ")}`);
      },
      confirm: async (plan) => {
        if (values.yes) return true;
        const answer = await readSecretFromStdin(`save this job with ${plan.pairs.length} mapped column(s)? [y/N] `);
        return answer.trim().toLowerCase() === "y";
      },
    });
    if (result.ok) {
      console.log(`added job ${result.job!.id} (${result.job!.name})`);
      if (result.watermarkReport) printWatermarkReport(result.watermarkReport);
    } else {
      for (const error of result.errors ?? []) console.error(`error: ${error}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "job" && subcommand === "test") {
    const id = rest[0];
    if (!id) {
      console.error("usage: nia-agent job test <id>");
      process.exitCode = 1;
      return;
    }
    const result = await testJob(id);
    if (result.ok) {
      console.log("ok");
      if (result.job) printFilterAndParams(result.job.filter, result.job.params);
      if (result.watermarkReport) printWatermarkReport(result.watermarkReport);
    } else {
      for (const error of result.errors) console.error(`error: ${error}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "job" && subcommand === "list") {
    for (const job of listJobs()) {
      console.log(`${job.id}\t${job.name}\t${job.connectionId}\t${job.sourceTable}\t${job.targetUrl}`);
      printFilterAndParams(job.filter, job.params);
    }
    return;
  }

  if (command === "job" && subcommand === "remove") {
    const id = rest[0];
    if (!id) {
      console.error("usage: nia-agent job remove <id>");
      process.exitCode = 1;
      return;
    }
    const removed = await removeJob(id);
    console.log(removed ? `removed job ${id}` : `no job with id ${id}`);
    return;
  }

  if (command === "job" && subcommand === "pause") {
    const id = rest[0];
    if (!id) {
      console.error("usage: nia-agent job pause <id> [reason]");
      process.exitCode = 1;
      return;
    }
    const reason = rest.slice(1).join(" ") || "paused manually";
    const paused = pauseJob(id, reason);
    console.log(paused ? `paused job ${id}` : `no job with id ${id}`);
    return;
  }

  if (command === "job" && subcommand === "resume") {
    const id = rest[0];
    if (!id) {
      console.error("usage: nia-agent job resume <id>");
      process.exitCode = 1;
      return;
    }
    const resumed = resumeJob(id);
    console.log(resumed ? `resumed job ${id}` : `no job with id ${id}`);
    return;
  }

  if (command === "job" && subcommand === "update") {
    const id = rest[0];
    const { values } = parseArgs({
      args: rest.slice(1),
      options: {
        name: { type: "string" },
        "target-url": { type: "string" },
        rekey: { type: "boolean" },
        map: { type: "string", multiple: true },
        unmap: { type: "string", multiple: true },
        "on-null-key": { type: "string" },
        "allow-empty-replace": { type: "boolean" },
        filter: { type: "string" },
        "filter-file": { type: "string" },
        param: { type: "string", multiple: true },
        schedule: { type: "string" },
        strategy: { type: "string" },
        "watermark-column": { type: "string" },
        "overlap-seconds": { type: "string" },
        "replace-schedule": { type: "string" },
        "delete-mode": { type: "string" },
        "max-delete-percent": { type: "string" },
        "reconcile-schedule": { type: "string" },
      },
    });
    if (!id) {
      console.error("usage: nia-agent job update <id> [--name <text>] [--target-url <url>] [--rekey] [--map source=target ...] [--unmap target ...] [--on-null-key stop|skip] [--allow-empty-replace] [--filter <json>|--filter-file <path>] [--param name=value ...] [--schedule <cron>] [--strategy replace|upsertDelta] [--watermark-column <name>] [--overlap-seconds <n>] [--replace-schedule <cron>] [--delete-mode none|reconciliation] [--max-delete-percent <n>] [--reconcile-schedule <cron>]");
      process.exitCode = 1;
      return;
    }
    const onNullKey = parseOnNullKey(values["on-null-key"] as string | undefined);
    if (onNullKey === undefined && values["on-null-key"] !== undefined) {
      console.error(`--on-null-key must be "stop" or "skip", got ${JSON.stringify(values["on-null-key"])}`);
      process.exitCode = 1;
      return;
    }
    const strategy = parseStrategy(values.strategy as string | undefined);
    if (strategy === undefined && values.strategy !== undefined) {
      console.error(`--strategy must be "replace" or "upsertDelta", got ${JSON.stringify(values.strategy)}`);
      process.exitCode = 1;
      return;
    }
    const overlapSecondsRaw = values["overlap-seconds"] as string | undefined;
    const overlapSeconds = overlapSecondsRaw !== undefined ? Number(overlapSecondsRaw) : undefined;
    if (overlapSecondsRaw !== undefined && (overlapSeconds === undefined || Number.isNaN(overlapSeconds))) {
      console.error(`--overlap-seconds must be a number, got ${JSON.stringify(overlapSecondsRaw)}`);
      process.exitCode = 1;
      return;
    }
    const deleteMode = parseDeleteMode(values["delete-mode"] as string | undefined);
    if (deleteMode === undefined && values["delete-mode"] !== undefined) {
      console.error(`--delete-mode must be "none" or "reconciliation", got ${JSON.stringify(values["delete-mode"])}`);
      process.exitCode = 1;
      return;
    }
    const maxDeletePercentRaw = values["max-delete-percent"] as string | undefined;
    const maxDeletePercent = maxDeletePercentRaw !== undefined ? Number(maxDeletePercentRaw) : undefined;
    if (maxDeletePercentRaw !== undefined && (maxDeletePercent === undefined || Number.isNaN(maxDeletePercent))) {
      console.error(`--max-delete-percent must be a number, got ${JSON.stringify(maxDeletePercentRaw)}`);
      process.exitCode = 1;
      return;
    }
    let filter: JobFilterCondition[] | undefined;
    try {
      filter = parseFilterArg(values.filter as string | undefined, values["filter-file"] as string | undefined);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    const paramEntries = (values.param as string[] | undefined) ?? [];
    let params: Record<string, string> | undefined;
    try {
      params = paramEntries.length > 0 ? parseParamOverrides(paramEntries) : undefined;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    const rekey = values.rekey ? await readSecretFromStdin("New Planometry push key: ") : undefined;
    const result = await updateJob(id, {
      name: values.name as string | undefined,
      targetUrl: values["target-url"] as string | undefined,
      rekey,
      mapOverrides: parseMapOverrides((values.map as string[] | undefined) ?? []),
      unmapTargets: (values.unmap as string[] | undefined) ?? [],
      onNullKey,
      allowEmptyReplace: values["allow-empty-replace"] as boolean | undefined,
      filter,
      params,
      schedule: values.schedule as string | undefined,
      strategy,
      watermarkColumn: values["watermark-column"] as string | undefined,
      overlapSeconds,
      replaceSchedule: values["replace-schedule"] as string | undefined,
      deleteMode,
      maxDeletePercent,
      reconcileSchedule: values["reconcile-schedule"] as string | undefined,
    }, {
      onPlan: (plan) => {
        console.log("mapping:");
        for (const pair of plan.pairs) console.log(`  ${pair.source} -> ${pair.target}`);
        if (plan.sentAsNull.length > 0) console.log(`target columns sent as null: ${plan.sentAsNull.join(", ")}`);
      },
    });
    if (result.ok) {
      console.log(`updated job ${result.job!.id}`);
      if (result.watermarkReport) printWatermarkReport(result.watermarkReport);
    } else {
      for (const error of result.errors ?? []) console.error(`error: ${error}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "job" && subcommand === "run") {
    const id = rest[0];
    const { values } = parseArgs({
      args: rest.slice(1),
      options: {
        replace: { type: "boolean" },
        param: { type: "string", multiple: true },
        "allow-mass-delete": { type: "boolean" },
      },
    });
    if (!id) {
      console.error("usage: nia-agent job run <id> [--replace] [--param name=value ...] [--allow-mass-delete]");
      process.exitCode = 1;
      return;
    }
    let paramOverrides: Record<string, string> | undefined;
    try {
      const paramEntries = (values.param as string[] | undefined) ?? [];
      paramOverrides = paramEntries.length > 0 ? parseParamOverrides(paramEntries) : undefined;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    const controller = new AbortController();
    const uninstall = installGracefulShutdown(controller);
    try {
      const result = await runJob(id, {
        replace: values.replace as boolean | undefined,
        signal: controller.signal,
        paramOverrides,
        allowMassDelete: values["allow-mass-delete"] as boolean | undefined,
      });
      if (result.ok) {
        console.log(result.summary);
      } else {
        console.error(`error: ${result.error}`);
        if (result.consoleMessage) console.error(`Planometry says: ${result.consoleMessage}`);
        process.exitCode = 1;
      }
    } finally {
      uninstall();
    }
    return;
  }

  if (command === "healthcheck") {
    const result = runHealthcheck();
    if (result.healthy) {
      console.log("healthy");
    } else {
      console.error(`unhealthy: ${result.reason}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "start") {
    const controller = new AbortController();
    const uninstall = installGracefulShutdown(controller);
    try {
      await runAgentLoop({ agentVersion: AGENT_VERSION, signal: controller.signal });
    } finally {
      uninstall();
    }
    return;
  }

  console.error(
    "usage: nia-agent connection <add|test|list|remove> ... | nia-agent job <add|test|list|remove|update|run|pause|resume> ... | nia-agent sql readonly ... | nia-agent doctor [connectionId] | nia-agent status | nia-agent healthcheck | nia-agent start | nia-agent version",
  );
  process.exitCode = 1;
}

function toOptionalBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === "true";
}

function parseOnNullKey(value: string | undefined): "stop" | "skip" | undefined {
  if (value === "stop" || value === "skip") return value;
  return undefined;
}

function parseStrategy(value: string | undefined): "replace" | "upsertDelta" | undefined {
  if (value === "replace" || value === "upsertDelta") return value;
  return undefined;
}

function parseDeleteMode(value: string | undefined): "none" | "reconciliation" | undefined {
  if (value === "none" || value === "reconciliation") return value;
  return undefined;
}

/** `job add`/`job update`/`job test`'s `watermarkReport` — the null-count/clock-skew check (plan §1.1/§8). */
function printWatermarkReport(report: WatermarkColumnReport): void {
  console.log(`watermark column: ${report.nullCount} null row(s), max value ${report.maxValue ?? "(none)"}, server clock ${report.serverClock}`);
  if (report.aheadOfServerClock) {
    console.log("warning: the watermark column's max value is ahead of the source server's own clock — it may be populated by application-server time, not database time");
  }
}

/** `--filter <json>` / `--filter-file <path>` (the file form is for Windows shells) — same JSON either way. */
function parseFilterArg(filterJson: string | undefined, filterFile: string | undefined): JobFilterCondition[] | undefined {
  if (filterJson && filterFile) throw new Error("--filter and --filter-file are mutually exclusive");
  const text = filterFile ? readFileSync(filterFile, "utf8") : filterJson;
  if (text === undefined) return undefined;
  return JSON.parse(text) as JobFilterCondition[];
}

function printFilterAndParams(filter: JobFilterCondition[], params: Record<string, string>): void {
  if (filter.length > 0) console.log(`  filter: ${JSON.stringify(filter)}`);
  if (Object.keys(params).length > 0) console.log(`  params: ${JSON.stringify(params)}`);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
