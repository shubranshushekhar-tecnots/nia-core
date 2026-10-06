import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { defaultHomeDir } from "../config/paths.js";
import { loadConfig } from "../config/store.js";
import type { ConnectionEntry } from "../config/types.js";
import { allowDestinationHost } from "../destinations/allowedHosts.js";
import { InvalidPairingCodeError, InvalidPlatformUrlError, pair, PairingRejectedError, type PairInput, type PairResult } from "../link/pairing.js";
import { readLinkState } from "../ops/linkState.js";
import { addConnection, testConnection as testConnectionById, listConnections, type AddConnectionInput } from "./connectionCommands.js";
import { parsePairingInput } from "./pairingInput.js";
import { readSecretFromStdin } from "./securePrompt.js";
import { ensureServiceRunning, type ServiceEnsureResult } from "./serviceControl.js";
import { runSqlReadonly, type RunSqlReadonlyInput } from "./sqlReadonlyCommand.js";
import { testSqlLoginAndListDatabases, type SqlLoginTestInput, type SqlLoginTestResult } from "./sqlLoginTest.js";
import { detectWindowsSqlInstances, type WindowsSqlInstance } from "./windowsSqlInstances.js";

/**
 * `nia-agent setup`'s interaction surface — kept separate from Node's
 * `readline`/stdin so every step function below is testable with injected
 * answers and a captured transcript, with no real terminal involved.
 */
export interface SetupIO {
  print(line: string): void;
  ask(question: string, defaultValue?: string): Promise<string>;
  askSecret(question: string): Promise<string>;
}

function askPlain(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

/** The real, terminal-backed `SetupIO` used by `nia-agent setup` itself. */
export function createConsoleSetupIO(): SetupIO {
  return {
    print: (line) => console.log(line),
    ask: (question, defaultValue) => askPlain(question, defaultValue),
    askSecret: (question) => readSecretFromStdin(`${question}: `),
  };
}

/**
 * Every side-effecting operation the wizard needs, as an injectable
 * interface — so pairing/database/destination logic is testable with fake
 * network/SQL/registry/service clients, same convention as link/pairing
 * .test.ts's fake HTTP server, just one layer higher.
 */
export interface SetupDeps {
  dir: string;
  platform: NodeJS.Platform;
  isPaired(): boolean;
  pair(input: PairInput): Promise<PairResult>;
  testSqlLogin(input: SqlLoginTestInput): Promise<SqlLoginTestResult>;
  addConnection(input: AddConnectionInput): ConnectionEntry;
  testConnection(id: string): Promise<{ ok: boolean; tableCount?: number; error?: string }>;
  listConnections(): ConnectionEntry[];
  allowDestinationHost(host: string): void;
  detectWindowsSqlInstances(): Promise<WindowsSqlInstance[]>;
  ensureServiceRunning(): Promise<ServiceEnsureResult>;
  waitForCheckIn(timeoutMs: number): Promise<boolean>;
  writeReadonlyScript(input: RunSqlReadonlyInput): string;
  canWriteDataDir(): boolean;
}

export function defaultSetupDeps(dir = defaultHomeDir()): SetupDeps {
  return {
    dir,
    platform: process.platform,
    isPaired: () => loadConfig(dir).link !== undefined,
    pair: (input) => pair(input, dir),
    testSqlLogin: testSqlLoginAndListDatabases,
    addConnection: (input) => addConnection(input, dir),
    testConnection: (id) => testConnectionById(id, dir),
    listConnections: () => listConnections(dir),
    allowDestinationHost: (host) => allowDestinationHost(host, dir),
    detectWindowsSqlInstances,
    ensureServiceRunning,
    waitForCheckIn: (timeoutMs) => waitForCheckInPoll(dir, timeoutMs),
    writeReadonlyScript: (input) => runSqlReadonly(input),
    canWriteDataDir: () => canWriteDir(dir),
  };
}

async function waitForCheckInPoll(dir: string, timeoutMs: number): Promise<boolean> {
  const before = readLinkState(dir).lastCheckInAt;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readLinkState(dir);
    if (state.lastCheckInAt && state.lastCheckInAt !== before) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function canWriteDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".setup-write-check");
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function permissionFixHint(platform: NodeJS.Platform): string {
  if (platform === "win32") return "Run this from an elevated PowerShell (right-click PowerShell, \"Run as Administrator\").";
  return "Run this as the account that owns the agent's install, e.g.: sudo -u nia-agent nia-agent setup";
}

/**
 * The entry point for `nia-agent setup`. A first run walks through
 * pairing -> database -> destinations -> finish; re-running it once
 * already paired or with a database configured instead shows the small
 * menu (`runSetupMenu`) — see docs/pilot/install-guide.md.
 */
export async function runGuidedSetup(io: SetupIO, deps: SetupDeps = defaultSetupDeps()): Promise<void> {
  if (!deps.canWriteDataDir()) {
    io.print(`Can't write to the agent's data folder (${deps.dir}).`);
    io.print(permissionFixHint(deps.platform));
    return;
  }

  const alreadySetUp = deps.isPaired() || deps.listConnections().length > 0;
  if (alreadySetUp) {
    await runSetupMenu(io, deps);
    return;
  }

  await pairingStep(io, deps);
  await databaseStep(io, deps);
  await destinationsStep(io, deps);
  await finishStep(io, deps);
}

/** Exported for the pairing test. */
export async function pairingStep(io: SetupIO, deps: SetupDeps): Promise<void> {
  if (deps.isPaired()) {
    io.print("Already paired with Nia Core — skipping pairing.");
    return;
  }

  io.print("First, let's pair this agent with your Nia Core account.");
  io.print("Paste the pairing command shown on your Agents page, or just the code.");

  for (;;) {
    const raw = await io.ask("Pairing command or code");
    const parsed = parsePairingInput(raw);
    if (!parsed) {
      io.print("That doesn't look like a pairing command or code — try again.");
      continue;
    }
    const url = parsed.url ?? (await io.ask("Platform address (e.g. https://app.example.com)"));
    try {
      const result = await deps.pair({ code: parsed.code, url });
      io.print(`Paired as agent ${result.agentId}.`);
      return;
    } catch (err) {
      io.print(`Pairing failed: ${describePairingError(err)}`);
      io.print("Let's try again.");
    }
  }
}

function describePairingError(err: unknown): string {
  if (err instanceof InvalidPlatformUrlError || err instanceof InvalidPairingCodeError || err instanceof PairingRejectedError) {
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === ".";
}

function toConnectionId(database: string, existing: ConnectionEntry[]): string {
  const base = database.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "db";
  if (!existing.some((c) => c.id === base)) return base;
  let n = 2;
  while (existing.some((c) => c.id === `${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** Exported for the database-step test. */
export async function databaseStep(io: SetupIO, deps: SetupDeps): Promise<void> {
  io.print("");
  io.print("Now let's connect to your database.");

  const host = await io.ask("Database server", "localhost");
  let port = Number((await io.ask("Port", "1433")).trim()) || 1433;

  if (deps.platform === "win32" && isLocalHost(host)) {
    const instances = await deps.detectWindowsSqlInstances();
    if (instances.length > 0) {
      io.print("Found SQL Server instance(s) on this machine:");
      instances.forEach((inst, i) => {
        const portLabel = inst.tcpEnabled ? `port ${inst.port}` : "TCP/IP disabled";
        io.print(`  ${i + 1}. ${inst.name} (${inst.instanceId}) — ${portLabel}`);
      });
      const choice = await io.ask("Pick a number, or leave blank to use the port above");
      const picked = instances[Number(choice) - 1];
      if (picked) {
        if (!picked.tcpEnabled) {
          io.print(
            `TCP/IP is disabled for ${picked.name}. To enable it: open SQL Server Configuration Manager -> SQL Server Network Configuration -> Protocols for ${picked.instanceId} -> enable TCP/IP -> restart the SQL Server service.`,
          );
        } else {
          port = picked.port!;
        }
      }
    }
  }

  for (;;) {
    const user = await io.ask("Database username (leave blank if you don't have one yet)");
    if (!user) {
      io.print("This agent doesn't support Windows sign-in — your DBA needs a SQL login.");
      const login = await io.ask("Login name for your DBA to create", "nia_agent");
      const databases = await io.ask("Database name(s) to grant it access to (comma-separated)");
      const outPath = await io.ask("Where should I write the setup script?", "nia-readonly-setup.sql");
      deps.writeReadonlyScript({ login, databases, out: outPath });
      io.print(`Wrote ${outPath}. Hand it to your DBA, then re-run \`nia-agent setup\` once you have a username and password.`);
      return;
    }
    const password = await io.askSecret("Database password");

    const result = await deps.testSqlLogin({ host, port, user, password });
    if (!result.ok) {
      io.print(`Couldn't log in: ${result.reason}`);
      io.print("Let's try the username and password again.");
      continue;
    }
    if (result.databases.length === 0) {
      io.print("That login works, but can't see any databases. Ask your DBA to grant it access, then try again.");
      continue;
    }

    io.print("Databases this login can see:");
    result.databases.forEach((name, i) => io.print(`  ${i + 1}. ${name}`));
    const dbChoice = await io.ask("Pick a number");
    const database = result.databases[Number(dbChoice) - 1];
    if (!database) {
      io.print("That's not one of the numbers above — let's try again.");
      continue;
    }

    const defaultTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const sourceTimeZone = await io.ask("Time zone this database server runs in", defaultTimeZone);

    const id = toConnectionId(database, deps.listConnections());
    deps.addConnection({ id, label: database, host, port, database, user, password, sourceTimeZone });
    const testResult = await deps.testConnection(id);
    if (testResult.ok) {
      io.print(`Connected. ${testResult.tableCount} table(s)/view(s) visible.`);
    } else {
      io.print(`Added the connection, but a follow-up check failed: ${testResult.error}`);
    }
    return;
  }
}

async function destinationsStep(io: SetupIO, deps: SetupDeps): Promise<void> {
  io.print("");
  io.print("If this agent will deliver to destinations set up from Nia Core's workflow canvas, allow them now (optional).");
  for (;;) {
    const host = await io.ask("Destination hostname to allow (leave blank to finish)");
    if (!host) return;
    deps.allowDestinationHost(host);
    io.print(`Allowed ${host}.`);
  }
}

async function finishStep(io: SetupIO, deps: SetupDeps): Promise<void> {
  io.print("");
  io.print("Finishing up...");
  const service = await deps.ensureServiceRunning();
  io.print(service.detail);

  io.print("Waiting for a successful check-in with Nia Core...");
  const checkedIn = await deps.waitForCheckIn(30_000);
  io.print(checkedIn ? "Checked in successfully." : "No check-in yet — it may just need a bit more time; check again with `nia-agent status`.");

  const connections = deps.listConnections();
  io.print("");
  io.print("Setup summary:");
  io.print(`  Paired: ${deps.isPaired() ? "yes" : "no"}`);
  io.print(`  Databases added: ${connections.length > 0 ? connections.map((c) => c.label).join(", ") : "none"}`);
  io.print(`  Service: ${service.running ? "running" : "not running"}`);
  io.print("Open your Agents page — this agent should show as online.");
}

async function runSetupMenu(io: SetupIO, deps: SetupDeps): Promise<void> {
  io.print("This agent is already set up. What would you like to do?");
  for (;;) {
    io.print("  1. Add another database");
    io.print("  2. Test a database");
    io.print("  3. Allow a destination");
    io.print("  4. Show status");
    io.print("  5. Exit");
    const choice = await io.ask("Pick a number", "5");
    if (choice === "1") {
      await databaseStep(io, deps);
    } else if (choice === "2") {
      const connections = deps.listConnections();
      if (connections.length === 0) {
        io.print("No databases configured yet.");
        continue;
      }
      connections.forEach((c, i) => io.print(`  ${i + 1}. ${c.label} (${c.id})`));
      const pick = await io.ask("Pick a number");
      const picked = connections[Number(pick) - 1];
      if (!picked) {
        io.print("That's not one of the numbers above.");
        continue;
      }
      const result = await deps.testConnection(picked.id);
      io.print(result.ok ? `Connected. ${result.tableCount} table(s)/view(s) visible.` : `Failed: ${result.error}`);
    } else if (choice === "3") {
      await destinationsStep(io, deps);
    } else if (choice === "4") {
      const service = await deps.ensureServiceRunning();
      io.print(`Paired: ${deps.isPaired() ? "yes" : "no"}`);
      io.print(`Service: ${service.detail}`);
    } else {
      return;
    }
  }
}
