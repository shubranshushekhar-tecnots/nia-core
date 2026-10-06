import { describe, expect, it } from "vitest";
import type { ConnectionEntry } from "../config/types.js";
import type { PairInput } from "../link/pairing.js";
import { databaseStep, pairingStep, type SetupDeps, type SetupIO } from "./setupCommand.js";
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
