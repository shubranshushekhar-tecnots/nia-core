import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectionEntry } from "../config/types.js";
import type { PairInput } from "../link/pairing.js";
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
        if (input.password === "wrong-secret-pw") return { ok: false, reason: "wrong username or password" };
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

    expect(printed).toContain("Couldn't log in: wrong username or password");
    expect(printed).toContain("Connected. 5 table(s)/view(s) visible.");
    expect(printed.some((line) => line.includes("wrong-secret-pw"))).toBe(false);
    expect(printed.some((line) => line.includes("right-secret-pw"))).toBe(false);
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
