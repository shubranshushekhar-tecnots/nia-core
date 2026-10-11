import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { defaultHomeDir } from "../config/paths.js";
import { loadConfig } from "../config/store.js";
import type { ConnectionEntry } from "../config/types.js";
import { addConnection, testConnection as testConnectionById, listConnections, type AddConnectionInput } from "../core/connections.js";
import { parseServerAddress } from "../core/serverAddress.js";
import { testSqlLoginAndListDatabases, testSqlLoginWithAutoRetry, type SqlLoginTestInput, type SqlLoginTestResult } from "../core/sqlLogin.js";
import { detectWindowsSqlInstances, type WindowsSqlInstance } from "../core/sqlDiscovery.js";
import { allowDestinationHost } from "../destinations/allowedHosts.js";
import { InvalidPairingCodeError, InvalidPlatformUrlError, pair, PairingRejectedError, type PairInput, type PairResult } from "../link/pairing.js";
import { readLinkState } from "../ops/linkState.js";
import { parsePairingInput } from "./pairingInput.js";
import { readSecretFromStdin } from "./securePrompt.js";
import { ensureServiceRunning, type ServiceEnsureResult } from "./serviceControl.js";
import { runSqlReadonly, type RunSqlReadonlyInput } from "./sqlReadonlyCommand.js";

/**
 * `nia-agent setup`'s interaction surface — kept separate from Node's
 * `readline`/stdin so every step function below is testable with injected
 * answers and a captured transcript, with no real terminal involved.
 */
export interface SetupIO {
  print(line: string): void;
  /**
   * `key` identifies which question this is (e.g. "host", "password") for
   * `createFileSetupIO` below to look up — the interactive console IO
   * ignores it. Optional and additive so every existing caller/test
   * (`createConsoleSetupIO`, `setupCommand.test.ts`'s fake IO) keeps
   * working unchanged.
   */
  ask(question: string, defaultValue?: string, key?: string): Promise<string>;
  askSecret(question: string, key?: string): Promise<string>;
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
 * Thrown by `createFileSetupIO` when a step asks for a key the answers
 * file doesn't have (and no default applies), or asks for the same
 * single-use key a second time — e.g. a wrong password: the interactive
 * wizard just asks again, but a file has only one answer, so retrying
 * would either loop forever or silently resend the same bad value. This
 * surfaces as a plain top-level error instead (`nia-agent setup`'s own
 * try/catch in src/index.ts prints it and exits non-zero).
 */
export class MissingAnswerError extends Error {
  constructor(key: string) {
    super(`non-interactive setup: no answer for "${key}" in the answers file (or it was already used once and the step needs it again — e.g. after a failed login)`);
    this.name = "MissingAnswerError";
  }
}

/** Keys the wizard can ask more than once in a loop until a blank answer ends it (destinationsStep) — consumed as a comma-separated list, one item per call, "" once exhausted. */
const REPEATABLE_KEYS = new Set(["destinationHosts"]);

/**
 * A non-interactive `SetupIO` that answers from a `key=value` text file
 * instead of a terminal — same `pairingStep`/`databaseStep`/
 * `destinationsStep`/`finishStep` functions run either way (rule: "it
 * must run the same code as the interactive questions"). One `key=value`
 * pair per line; blank lines and lines starting with `#` are ignored.
 * Every single-use key is consumed at most once, by design — see
 * `MissingAnswerError`.
 */
export function createFileSetupIO(filePath: string): SetupIO {
  const raw = fs.readFileSync(filePath, "utf8");
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    values.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1));
  }
  const listCursors = new Map<string, string[]>();

  function takeFromList(key: string): string {
    if (!listCursors.has(key)) {
      const items = (values.get(key) ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      listCursors.set(key, items);
    }
    return listCursors.get(key)!.shift() ?? "";
  }

  function takeSingle(key: string): string | undefined {
    if (!values.has(key)) return undefined;
    const v = values.get(key)!;
    values.delete(key);
    return v;
  }

  return {
    print: (line) => console.log(line),
    ask: async (question, defaultValue, key) => {
      if (!key) return defaultValue ?? "";
      if (REPEATABLE_KEYS.has(key)) return takeFromList(key);
      const v = takeSingle(key);
      if (v !== undefined) return v;
      if (defaultValue !== undefined) return defaultValue;
      throw new MissingAnswerError(key);
    },
    askSecret: async (question, key) => {
      if (!key) throw new Error(`non-interactive setup: internal error — askSecret called without a key for "${question}"`);
      const v = takeSingle(key);
      if (v === undefined) throw new MissingAnswerError(key);
      return v;
    },
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
    // Masked (not echoed) like a password — a pairing code is itself a
    // secret: whoever has it can pair an agent as this organization. It's
    // never printed back anywhere after this, including in error messages.
    const raw = await io.askSecret("Pairing command or code", "pairing");
    const parsed = parsePairingInput(raw);
    if (!parsed) {
      io.print("That doesn't look like a pairing command or code — try again.");
      continue;
    }
    const url = parsed.url ?? (await io.ask("Platform address (e.g. https://app.example.com)", undefined, "platformUrl"));
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

/**
 * A pairing code that's already been consumed or has expired can never
 * succeed on retry, unlike a mistyped one — re-prompting "try again" for
 * the SAME code would just repeat the same rejection forever. Both of
 * the backend's exact messages (services/agent-bridge/src/app.ts) are
 * matched here to add that guidance; neither ever contains the code
 * itself, so there's nothing to redact.
 */
function describePairingError(err: unknown): string {
  const message =
    err instanceof InvalidPlatformUrlError || err instanceof InvalidPairingCodeError || err instanceof PairingRejectedError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  if (/already been used|has expired/i.test(message)) {
    return `${message} Create a new pairing code from Agents → Add agent on Nia Core, then run this again.`;
  }
  return message;
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

/** `nia-agent setup`'s normal free-text server question — asked directly on macOS/Linux, and as the win32 fallback when no local SQL Server instance was auto-detected (or the user types their own address instead of picking one). */
const HOST_QUESTION = 'Database server (hostname, "HOST\\INSTANCE" for a named instance, or "HOST,PORT")';

/**
 * Win32-only: presents every locally-installed SQL Server instance (read
 * from the registry) as a numbered list, with a generic "localhost
 * (default instance, port 1433)" guess added LAST — so a user can just
 * press Enter/type a number instead of typing a hostname at all.
 * Detected instances are listed FIRST (so pressing Enter, which defaults
 * to "1", picks a real detected instance whenever one was found) and the
 * "localhost" guess is listed last, since it's only correct for the
 * rarer case of an unnamed/default SQL Server instance -- putting it
 * first (as this used to) was a real customer footgun: someone whose
 * actual instance is named (the common case for SQL Server Express)
 * would see it listed as option 2, but pressing Enter for the default
 * "1" silently tried the generic localhost:1433 guess instead, which
 * nothing answers, producing an opaque "server not reachable" failure
 * right after the wizard had just found their real instance a line
 * above. See the "unreachable" hint in databaseStep below for the other
 * half of this fix. Picking a detected instance also resolves its port
 * directly, skipping the separate port question entirely. Typing
 * anything that isn't one of the listed numbers is treated as a literal
 * server address, same as the plain host question this replaces.
 */
async function pickWindowsHost(
  io: SetupIO,
  deps: SetupDeps,
): Promise<{
  hostInput: string;
  detectedPort?: number;
  pickedInstanceLoginMode?: number;
  detectedInstances: WindowsSqlInstance[];
}> {
  const instances = await deps.detectWindowsSqlInstances();
  if (instances.length === 0) {
    return { hostInput: await io.ask(HOST_QUESTION, "localhost", "host"), detectedInstances: [] };
  }

  io.print("SQL Server instance(s) found on this machine:");
  instances.forEach((inst, i) => {
    const portLabel = inst.tcpEnabled ? `port ${inst.port}` : "TCP/IP disabled";
    io.print(`  ${i + 1}. ${inst.name} (${inst.instanceId}) — ${portLabel}`);
  });
  const localhostChoiceNum = instances.length + 1;
  io.print(`  ${localhostChoiceNum}. localhost (default instance, port 1433)`);
  const choice = await io.ask(`Pick a number, or type a server address (same formats as before)`, "1", "host");
  const trimmed = choice.trim();
  const num = Number(trimmed);
  const isListChoice = trimmed !== "" && Number.isInteger(num) && num >= 1 && num <= localhostChoiceNum;

  if (!isListChoice) return { hostInput: trimmed || "localhost", detectedInstances: instances };
  if (num === localhostChoiceNum) return { hostInput: "localhost", detectedInstances: instances };

  const picked = instances[num - 1]!;
  if (!picked.tcpEnabled) {
    io.print(
      `TCP/IP is disabled for ${picked.name}. To enable it: open SQL Server Configuration Manager -> SQL Server Network Configuration -> Protocols for ${picked.instanceId} -> enable TCP/IP -> restart the SQL Server service.`,
    );
    return { hostInput: "localhost", pickedInstanceLoginMode: picked.loginMode, detectedInstances: instances };
  }
  return {
    hostInput: "localhost",
    detectedPort: picked.port,
    pickedInstanceLoginMode: picked.loginMode,
    detectedInstances: instances,
  };
}

/** The databases every SQL Server install ships with — never what a customer actually wants synced, so Change 2b hides them from the pick-a-database list entirely. */
const SYSTEM_DATABASES = new Set(["master", "tempdb", "model", "msdb"]);

/** Exported for the database-step test. */
export async function databaseStep(io: SetupIO, deps: SetupDeps): Promise<void> {
  io.print("");
  io.print("Now let's connect to your database.");

  // On win32, try to save the user from typing a hostname at all; every
  // other platform keeps the plain free-text question unchanged.
  const picked =
    deps.platform === "win32"
      ? await pickWindowsHost(io, deps)
      : { hostInput: await io.ask(HOST_QUESTION, "localhost", "host"), detectedInstances: [] as WindowsSqlInstance[] };

  const address = parseServerAddress(picked.hostInput);
  const host = address.host;
  let instanceName = address.instanceName;
  let port: number | undefined = picked.detectedPort ?? address.port;
  const detectedInstances = picked.detectedInstances;

  // Set only when a local Windows SQL Server instance was auto-detected and
  // picked above -- used after a failed login attempt to tell "this server
  // only accepts Windows sign-in" apart from "wrong password", which the
  // driver's own error can't do (see WindowsSqlInstance.loginMode's doc
  // comment for why).
  const pickedInstanceLoginMode = picked.pickedInstanceLoginMode;

  // A named instance (bug 2) skips the port question entirely — SQL Browser
  // resolves it — and an explicit "HOST,PORT" address, or a win32 instance
  // pick whose port is already known, already answered it.
  if (instanceName) {
    io.print(`Using named instance "${instanceName}" on ${host} — its port will be resolved via SQL Server Browser (UDP 1434).`);
  } else if (port === undefined) {
    port = Number((await io.ask("Port", "1433", "port")).trim()) || 1433;
  }

  if (!instanceName) io.print(`Using port ${port}.`);

  for (;;) {
    const user = await io.ask("Database username (leave blank if you don't have one yet)", "", "username");
    if (!user) {
      io.print("This agent doesn't support Windows sign-in — your DBA needs a SQL login.");
      const login = await io.ask("Login name for your DBA to create", "nia_agent", "dbaLogin");
      const databases = await io.ask("Database name(s) to grant it access to (comma-separated)", undefined, "dbaDatabases");
      const outPath = await io.ask("Where should I write the setup script?", "nia-readonly-setup.sql", "dbaOutPath");
      deps.writeReadonlyScript({ login, databases, out: outPath });
      io.print(`Wrote ${outPath}. Hand it to your DBA, then re-run \`nia-agent setup\` once you have a username and password.`);
      return;
    }
    const password = await io.askSecret("Database password", "password");

    // SQL Server auto-generates a self-signed certificate for encrypted
    // connections whenever none is explicitly configured -- the default for
    // the vast majority of self-hosted instances, including every one this
    // step just auto-detected on the local machine above. `connect()`'s own
    // default (`trustServerCertificate: false`) is deliberately strict for
    // connections that might cross the public internet, but a server this
    // step found running on localhost (or the user explicitly typed as
    // localhost/127.0.0.1/::1) is, by definition, not that: keep the
    // connection encrypted, just don't require a CA-trusted chain for it --
    // same trade-off SSMS/Azure Data Studio make by default for local
    // instances. Never do this for a host the user typed as a remote
    // address; that's exactly the MITM exposure the strict default exists
    // to prevent. May still be flipped on below after an explicit prompt,
    // for a remote server whose self-signed cert the user chooses to trust.
    // SQL Server auto-generates a self-signed certificate for encrypted
    // connections whenever none is explicitly configured; see
    // `testSqlLoginWithAutoRetry`'s doc comment for the full trade-off.
    let trustServerCertificate: boolean | undefined = isLocalHost(host) ? true : undefined;
    let allowLegacyTls: boolean | undefined;

    // The login attempt below can legitimately take several seconds (up to
    // `connectionTimeout`, 15s) with nothing printed in between -- on a slow
    // or unreachable server this reads exactly like "setup went silent after
    // the password prompt". Print something before every attempt so there's
    // always a visible sign the wizard is still working, not stuck.
    io.print(`Connecting to ${host}...`);

    const { result, autoTrustedCertificate, autoAllowedLegacyTls } = await testSqlLoginWithAutoRetry(
      deps.testSqlLogin,
      { host, instanceName, port, user, password, trustServerCertificate, allowLegacyTls },
      pickedInstanceLoginMode,
    );
    trustServerCertificate = autoTrustedCertificate ? true : trustServerCertificate;
    allowLegacyTls = autoAllowedLegacyTls ? true : allowLegacyTls;

    if (!result.ok) {
      io.print(`Couldn't log in: ${result.reason}`);
      // Picked the "localhost" fallback entry but nothing answered there,
      // even though a real (named) instance was detected above -- almost
      // always means the user should have picked that instance instead.
      if (result.kind === "unreachable" && isLocalHost(host) && !instanceName && detectedInstances.length > 0) {
        const first = detectedInstances[0]!;
        io.print(`Nothing answered on localhost:${port}. We found ${first.name} on this PC — choose option 1 instead.`);
      }
      io.print("Let's try again.");
      continue;
    }

    const connectedQualifier =
      autoTrustedCertificate && autoAllowedLegacyTls
        ? " (using the server's own certificate, older server – compatibility mode on)"
        : autoTrustedCertificate
          ? " (using the server's own certificate)"
          : autoAllowedLegacyTls
            ? " (older server – compatibility mode on)"
            : "";

    if (result.databases.length === 0) {
      io.print("That login works, but can't see any databases. Ask your DBA to grant it access, then try again.");
      continue;
    }

    // Every SQL Server install ships master/tempdb/model/msdb — never what
    // a customer actually wants synced, so they're hidden from the pick
    // list entirely (requirement 2b). Falling back to typing a name is
    // reserved for when listing leaves nothing real to pick from.
    const pickableDatabases = result.databases.filter((name) => !SYSTEM_DATABASES.has(name.toLowerCase()));
    let database: string;
    if (pickableDatabases.length > 0) {
      io.print("Databases this login can see:");
      pickableDatabases.forEach((name, i) => io.print(`  ${i + 1}. ${name}`));
      const dbChoice = await io.ask("Pick a number", undefined, "dbChoice");
      const picked = pickableDatabases[Number(dbChoice) - 1];
      if (!picked) {
        io.print("That's not one of the numbers above — let's try again.");
        continue;
      }
      database = picked;
    } else {
      io.print("That login works, but the only databases visible are SQL Server's own system databases.");
      const typed = await io.ask("Database name", undefined, "dbName");
      if (!typed) {
        io.print("Let's try again.");
        continue;
      }
      database = typed;
    }

    const defaultTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const sourceTimeZone = await io.ask("Time zone this database server runs in", defaultTimeZone, "timezone");

    const id = toConnectionId(database, deps.listConnections());
    deps.addConnection({ id, label: database, host, port, instanceName, database, user, password, sourceTimeZone, trustServerCertificate, allowLegacyTls });
    const testResult = await deps.testConnection(id);
    if (testResult.ok) {
      io.print(`Connected${connectedQualifier}. ${testResult.tableCount} table(s)/view(s) visible.`);
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
    const host = await io.ask("Destination hostname to allow (leave blank to finish)", "", "destinationHosts");
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
