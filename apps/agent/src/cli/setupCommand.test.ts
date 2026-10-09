import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectionEntry } from "../config/types.js";
import type { PairInput } from "../link/pairing.js";
import { PairingRejectedError } from "../link/pairing.js";
import { createFileSetupIO, databaseStep, MissingAnswerError, pairingStep, type SetupDeps, type SetupIO } from "./setupCommand.js";
import type { SqlLoginTestInput } from "./sqlLoginTest.js";

/** A scripted `SetupIO`: `ask`/`askSecret` return the next answer in order (both draw from the same queue — the wizard never needs to tell them apart), `print` is captured for assertions. Throws loudly if a step asks for more answers than the test provided, instead of hanging. */
function createFakeIO(answers: string[]): { io: SetupIO; printed: string[] } {
  const printed: string[] = [];
  let index = 0;
  const next = (question: string): string => {
    if (index >= answers.length) throw new Error(`fake SetupIO ran out of scripted answers at question ${index + 1}: ${question}`);
    return answers[index++]!;
  };
  return {
    printed,
    io: {
      print: (line) => printed.push(line),
      ask: async (question) => next(question),
      askSecret: async (question) => next(question),
    },
  };
}

/** Every `SetupDeps` member defaults to throwing — tests must override whatever the step under test actually calls, so an unexpected call fails loudly instead of silently returning `undefined`. */
function fakeDeps(overrides: Partial<SetupDeps>): SetupDeps {
  const notImplemented = (name: string) => () => {
    throw new Error(`fakeDeps: ${name} was not expected to be called`);
  };
  return {
    dir: "/tmp/fake-nia-agent-home",
    platform: "linux",
    isPaired: notImplemented("isPaired"),
    pair: notImplemented("pair"),
    testSqlLogin: notImplemented("testSqlLogin"),
    addConnection: notImplemented("addConnection"),
    testConnection: notImplemented("testConnection"),
    listConnections: () => [],
    allowDestinationHost: notImplemented("allowDestinationHost"),
    detectWindowsSqlInstances: notImplemented("detectWindowsSqlInstances"),
    ensureServiceRunning: notImplemented("ensureServiceRunning"),
    waitForCheckIn: notImplemented("waitForCheckIn"),
    writeReadonlyScript: notImplemented("writeReadonlyScript"),
    canWriteDataDir: () => true,
    ...overrides,
  };
}

describe("setup wizard: pairing step", () => {
  it("pairs from a pasted full pairing command and continues", async () => {
    const { io, printed } = createFakeIO(["nia-agent pair --code pc1.secret123 --url https://app.example.com"]);
    const pairCalls: PairInput[] = [];
    const deps = fakeDeps({
      isPaired: () => false,
      pair: async (input) => {
        pairCalls.push(input);
        return { agentId: "agent-42" };
      },
    });

    await pairingStep(io, deps);

    expect(pairCalls).toEqual([{ code: "pc1.secret123", url: "https://app.example.com" }]);
    expect(printed).toContain("Paired as agent agent-42.");
  });

  it("never echoes the pairing code back, even on a rejected pair", async () => {
    const { io, printed } = createFakeIO([
      "nia-agent pair --code pc1.alreadyused --url https://app.example.com",
      "nia-agent pair --code pc2.secret456 --url https://app.example.com",
    ]);
    let attempt = 0;
    const deps = fakeDeps({
      isPaired: () => false,
      pair: async () => {
        attempt++;
        if (attempt === 1) throw new PairingRejectedError("pairing code has already been used");
        return { agentId: "agent-42" };
      },
    });

    await pairingStep(io, deps);

    expect(attempt).toBe(2);
    expect(printed.some((line) => line.includes("pc1.alreadyused") || line.includes("pc2.secret456"))).toBe(false);
  });

  it("on an already-used or expired pairing code, tells the user to create a new one", async () => {
    const { io, printed } = createFakeIO(["nia-agent pair --code pc1.secret123 --url https://app.example.com"]);
    const deps = fakeDeps({
      isPaired: () => false,
      pair: async () => {
        throw new PairingRejectedError("pairing code has already been used");
      },
    });

    // The wizard's pairing loop retries forever on failure, so running it against a
    // fully-consumed answer queue throws `fakeDeps`'s own out-of-answers error --
    // that's the signal the retry prompt was reached, which is all this test needs.
    await expect(pairingStep(io, deps)).rejects.toThrow(/ran out of scripted answers/);

    expect(
      printed.some((line) =>
        line.includes("pairing code has already been used") &&
        line.includes("Create a new pairing code from Agents → Add agent on Nia Core"),
      ),
    ).toBe(true);
  });
});

describe("setup wizard: database step", () => {
  it("on a failed login shows a plain message, retries, and never prints the password", async () => {
    const { io, printed } = createFakeIO([
      "db.internal", // server
      "1433", // port
      "nia_agent", // username (attempt 1)
      "wrong-secret-pw", // password (attempt 1) — must never appear in `printed`
      "nia_agent", // username (attempt 2, re-entered since server/port are asked only once)
      "right-secret-pw", // password (attempt 2) — must never appear in `printed`
      "1", // pick database from the list
      "America/New_York", // time zone
    ]);

    const loginAttempts: SqlLoginTestInput[] = [];
    let addedInput: Parameters<SetupDeps["addConnection"]>[0] | undefined;
    const deps = fakeDeps({
      platform: "linux",
      testSqlLogin: async (input) => {
        loginAttempts.push(input);
        if (input.password === "wrong-secret-pw") return { ok: false, reason: "wrong username or password", kind: "wrongCredentials" };
        return { ok: true, databases: ["Sales"] };
      },
      addConnection: (input) => {
        addedInput = input;
        return { id: input.id, label: input.label, sqlserver: { host: input.host, database: input.database }, sourceTimeZone: input.sourceTimeZone, credentialRef: "ref" } as ConnectionEntry;
      },
      testConnection: async () => ({ ok: true, tableCount: 5 }),
    });

    await databaseStep(io, deps);

    expect(loginAttempts).toHaveLength(2);
    expect(loginAttempts[0]).toMatchObject({ host: "db.internal", port: 1433, user: "nia_agent", password: "wrong-secret-pw" });
    expect(loginAttempts[1]).toMatchObject({ host: "db.internal", port: 1433, user: "nia_agent", password: "right-secret-pw" });
    expect(addedInput).toMatchObject({ database: "Sales", sourceTimeZone: "America/New_York" });

    expect(printed).toContain("Connecting to db.internal...");
    expect(printed).toContain("Couldn't log in: wrong username or password");
    expect(printed).toContain("Connected. 5 table(s)/view(s) visible.");
    expect(printed.some((line) => line.includes("wrong-secret-pw"))).toBe(false);
    expect(printed.some((line) => line.includes("right-secret-pw"))).toBe(false);
  });

  it("on win32, when the picked local instance's registry LoginMode is Windows-only, explains that instead of the driver's generic error", async () => {
    const { io, printed } = createFakeIO([
      "2", // pick the detected instance (1 is reserved for localhost)
      "nia_ro", // username
      "whatever-the-real-password-is", // password — must never appear in `printed`
    ]);

    const deps = fakeDeps({
      platform: "win32",
      detectWindowsSqlInstances: async () => [
        { name: "SQLEXPRESS", instanceId: "MSSQL15.SQLEXPRESS", port: 1433, tcpEnabled: true, loginMode: 1 },
      ],
      // The real driver can't distinguish "server is Windows-only" from a
      // wrong password over the wire (see WindowsSqlInstance.loginMode's doc
      // comment) — so even a right-password attempt surfaces this same
      // generic reason. The registry-based override is the only thing that
      // can tell the user what's actually going on.
      testSqlLogin: async () => ({ ok: false, reason: "wrong username or password", kind: "wrongCredentials" }),
    });

    await expect(databaseStep(io, deps)).rejects.toThrow(/fake SetupIO ran out of scripted answers/);

    expect(printed).toContain("Couldn't log in: password logins are switched off on this server (it only accepts Windows sign-in)");
    expect(printed.some((line) => line.includes("wrong username or password"))).toBe(false);
    expect(printed.some((line) => line.includes("whatever-the-real-password-is"))).toBe(false);
  });

  it("on an untrusted-certificate error, automatically trusts it and retries with the SAME credentials — no yes/no question, no re-ask for a login", async () => {
    const { io, printed } = createFakeIO([
      "db.remote.example.com", // server
      "1433", // port
      "nia_agent", // username (asked exactly once)
      "right-secret-pw", // password (asked exactly once)
      "1", // pick database from the list
      "America/New_York", // time zone
    ]);

    const loginAttempts: SqlLoginTestInput[] = [];
    const deps = fakeDeps({
      platform: "linux",
      testSqlLogin: async (input) => {
        loginAttempts.push(input);
        if (!input.trustServerCertificate) {
          return { ok: false, reason: "couldn't verify this server's TLS certificate (it's likely self-signed)", kind: "tlsCertUntrusted" };
        }
        return { ok: true, databases: ["Sales"] };
      },
      addConnection: (input) => ({ id: input.id, label: input.label, sqlserver: { host: input.host, database: input.database }, sourceTimeZone: input.sourceTimeZone, credentialRef: "ref" }) as ConnectionEntry,
      testConnection: async () => ({ ok: true, tableCount: 5 }),
    });

    await databaseStep(io, deps);

    expect(loginAttempts).toHaveLength(2);
    expect(loginAttempts[0]!.trustServerCertificate).toBeUndefined();
    expect(loginAttempts[0]!.user).toBe("nia_agent");
    expect(loginAttempts[1]!.trustServerCertificate).toBe(true);
    expect(loginAttempts[1]!.user).toBe("nia_agent");
    expect(printed.some((line) => /trust/i.test(line) && /\[y\/n\]/i.test(line))).toBe(false);
    expect(printed.some((line) => line.includes("couldn't verify this server's TLS certificate"))).toBe(false);
    expect(printed).toContain("Connected (using the server's own certificate). 5 table(s)/view(s) visible.");
  });

  it("on a TLS-protocol-too-old error, automatically allows legacy TLS and retries with the SAME credentials — no yes/no question", async () => {
    const { io, printed } = createFakeIO([
      "tallyserver", // server
      "1433", // port
      "nia_agent", // username
      "right-secret-pw", // password
      "1", // pick database
      "America/New_York", // time zone
    ]);

    const loginAttempts: SqlLoginTestInput[] = [];
    const deps = fakeDeps({
      platform: "linux",
      testSqlLogin: async (input) => {
        loginAttempts.push(input);
        if (!input.allowLegacyTls) {
          return { ok: false, reason: "this server only supports an old TLS version", kind: "tlsProtocolTooOld" };
        }
        return { ok: true, databases: ["Sales"] };
      },
      addConnection: (input) => ({ id: input.id, label: input.label, sqlserver: { host: input.host, database: input.database }, sourceTimeZone: input.sourceTimeZone, credentialRef: "ref" }) as ConnectionEntry,
      testConnection: async () => ({ ok: true, tableCount: 1 }),
    });

    await databaseStep(io, deps);

    expect(loginAttempts).toHaveLength(2);
    expect(loginAttempts[0]!.allowLegacyTls).toBeUndefined();
    expect(loginAttempts[1]!.allowLegacyTls).toBe(true);
    expect(printed.some((line) => /legacy tls/i.test(line) && /\[y\/n\]/i.test(line))).toBe(false);
    expect(printed).toContain("Connected (older server – compatibility mode on). 1 table(s)/view(s) visible.");
  });

  it("when both an untrusted certificate AND an old TLS version are hit on the same server, auto-fixes both and reports both in the one success line", async () => {
    const { io, printed } = createFakeIO([
      "tallyserver", // server
      "1433", // port
      "nia_agent", // username
      "right-secret-pw", // password
      "1", // pick database
      "America/New_York", // time zone
    ]);

    const loginAttempts: SqlLoginTestInput[] = [];
    const deps = fakeDeps({
      platform: "linux",
      testSqlLogin: async (input) => {
        loginAttempts.push(input);
        if (!input.allowLegacyTls) {
          return { ok: false, reason: "this server only supports an old TLS version", kind: "tlsProtocolTooOld" };
        }
        if (!input.trustServerCertificate) {
          return { ok: false, reason: "couldn't verify this server's TLS certificate (it's likely self-signed)", kind: "tlsCertUntrusted" };
        }
        return { ok: true, databases: ["Sales"] };
      },
      addConnection: (input) => ({ id: input.id, label: input.label, sqlserver: { host: input.host, database: input.database }, sourceTimeZone: input.sourceTimeZone, credentialRef: "ref" }) as ConnectionEntry,
      testConnection: async () => ({ ok: true, tableCount: 3 }),
    });

    await databaseStep(io, deps);

    expect(loginAttempts).toHaveLength(3);
    expect(printed).toContain("Connected (using the server's own certificate, older server – compatibility mode on). 3 table(s)/view(s) visible.");
  });

  it("skips master/tempdb/model/msdb from the pick-a-database list", async () => {
    const { io, printed } = createFakeIO([
      "db.internal", // server
      "1433", // port
      "nia_agent", // username
      "right-secret-pw", // password
      "1", // pick database (the only non-system one)
      "America/New_York", // time zone
    ]);

    const deps = fakeDeps({
      platform: "linux",
      testSqlLogin: async () => ({ ok: true, databases: ["master", "tempdb", "model", "msdb", "Sales"] }),
      addConnection: (input) => ({ id: input.id, label: input.label, sqlserver: { host: input.host, database: input.database }, sourceTimeZone: input.sourceTimeZone, credentialRef: "ref" }) as ConnectionEntry,
      testConnection: async () => ({ ok: true, tableCount: 5 }),
    });

    await databaseStep(io, deps);

    expect(printed).toContain("Databases this login can see:");
    expect(printed).toContain("  1. Sales");
    expect(printed.some((line) => line.includes("master") || line.includes("tempdb") || line.includes("model") || line.includes("msdb"))).toBe(
      false,
    );
  });

  it("falls back to typing a database name when only system databases are visible", async () => {
    const { io, printed } = createFakeIO([
      "db.internal", // server
      "1433", // port
      "nia_agent", // username
      "right-secret-pw", // password
      "CustomDb", // typed database name (listing had nothing real to pick)
      "America/New_York", // time zone
    ]);

    let addedInput: Parameters<SetupDeps["addConnection"]>[0] | undefined;
    const deps = fakeDeps({
      platform: "linux",
      testSqlLogin: async () => ({ ok: true, databases: ["master", "tempdb"] }),
      addConnection: (input) => {
        addedInput = input;
        return { id: input.id, label: input.label, sqlserver: { host: input.host, database: input.database }, sourceTimeZone: input.sourceTimeZone, credentialRef: "ref" } as ConnectionEntry;
      },
      testConnection: async () => ({ ok: true, tableCount: 0 }),
    });

    await databaseStep(io, deps);

    expect(addedInput).toMatchObject({ database: "CustomDb" });
    expect(printed).toContain("That login works, but the only databases visible are SQL Server's own system databases.");
  });

  it("parses a HOST\\INSTANCE address and skips the port question entirely", async () => {
    const { io, printed } = createFakeIO([
      "TALLYSERVER\\SQL2008ERP", // server — no port question follows
      "nia_agent", // username
      "right-secret-pw", // password
      "1", // pick database
      "America/New_York", // time zone
    ]);

    const loginAttempts: SqlLoginTestInput[] = [];
    const deps = fakeDeps({
      platform: "linux",
      testSqlLogin: async (input) => {
        loginAttempts.push(input);
        return { ok: true, databases: ["SummitERP_1"] };
      },
      addConnection: (input) => ({ id: input.id, label: input.label, sqlserver: { host: input.host, database: input.database }, sourceTimeZone: input.sourceTimeZone, credentialRef: "ref" }) as ConnectionEntry,
      testConnection: async () => ({ ok: true, tableCount: 2 }),
    });

    await databaseStep(io, deps);

    expect(loginAttempts).toHaveLength(1);
    expect(loginAttempts[0]).toMatchObject({ host: "TALLYSERVER", instanceName: "SQL2008ERP", port: undefined });
    expect(printed.some((line) => line.includes('Using named instance "SQL2008ERP"'))).toBe(true);
  });
});

describe("createFileSetupIO", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nia-agent-answers-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeAnswers(contents: string): string {
    const file = join(dir, "answers.txt");
    writeFileSync(file, contents);
    return file;
  }

  it("answers keyed questions from key=value lines, ignoring blanks and comments", async () => {
    const file = writeAnswers(["# a comment", "", "host=db.internal", "port=1433", "username=nia_agent"].join("\n"));
    const io = createFileSetupIO(file);

    expect(await io.ask("Database server", "localhost", "host")).toBe("db.internal");
    expect(await io.ask("Port", "1433", "port")).toBe("1433");
    expect(await io.ask("Database username", "", "username")).toBe("nia_agent");
  });

  it("falls back to the default when a key is absent", async () => {
    const io = createFileSetupIO(writeAnswers("username=nia_agent"));
    expect(await io.ask("Database server", "localhost", "host")).toBe("localhost");
  });

  it("throws MissingAnswerError when a required key is absent and there is no default", async () => {
    const io = createFileSetupIO(writeAnswers("host=db.internal"));
    await expect(io.ask("Pick a number", undefined, "dbChoice")).rejects.toThrow(MissingAnswerError);
  });

  it("consumes a single-use key only once — a second ask (e.g. retry after a failed login) throws instead of looping", async () => {
    const io = createFileSetupIO(writeAnswers("username=nia_agent\npassword=secret123"));
    expect(await io.askSecret("Database password", "password")).toBe("secret123");
    await expect(io.askSecret("Database password", "password")).rejects.toThrow(MissingAnswerError);
  });

  it("serves a repeatable key as a comma-separated list, one item per call, then empty", async () => {
    const io = createFileSetupIO(writeAnswers("destinationHosts=a.example.com, b.example.com"));
    expect(await io.ask("Destination hostname to allow (leave blank to finish)", "", "destinationHosts")).toBe("a.example.com");
    expect(await io.ask("Destination hostname to allow (leave blank to finish)", "", "destinationHosts")).toBe("b.example.com");
    expect(await io.ask("Destination hostname to allow (leave blank to finish)", "", "destinationHosts")).toBe("");
  });

  it("never needs a key for an unkeyed ask — returns the default", async () => {
    const io = createFileSetupIO(writeAnswers(""));
    expect(await io.ask("Some unkeyed question", "fallback")).toBe("fallback");
  });
});
