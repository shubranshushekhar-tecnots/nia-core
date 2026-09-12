import { describe, expect, it, vi } from "vitest";
import { executeWithStatementTimeout } from "./query.js";

/**
 * No live Postgres in this suite (same convention as pool-manager.test.ts —
 * mock the driver, never a real socket), so this fakes the one behavior
 * that matters: Postgres itself aborts a query once it runs past whatever
 * `SET LOCAL statement_timeout` was set for the transaction, raising it as
 * a query error with SQLSTATE 57014 ("query_canceled" / statement timeout).
 * FakeClient below applies that same rule based on the SET LOCAL value it
 * was actually sent — so this proves executeWithStatementTimeout (a) wires
 * body.timeoutMs through as the real threshold (not a fixed constant —
 * two different timeoutMs values against the same simulated query duration
 * produce different outcomes) and (b) propagates the cancellation instead
 * of swallowing it, rather than merely asserting a mocked call happened.
 */
class FakeClient {
  timeoutMs: number | null = null;
  calls: string[] = [];
  constructor(private simulatedDurationMs: number) {}

  async query(q: string | { text: string; values?: unknown[] }): Promise<{ rows: unknown[]; fields: unknown[] }> {
    const text = typeof q === "string" ? q : q.text;
    this.calls.push(text);
    const setLocalMatch = /^SET LOCAL statement_timeout = (\d+)$/.exec(text);
    if (setLocalMatch) {
      this.timeoutMs = Number(setLocalMatch[1]);
      return { rows: [], fields: [] };
    }
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
      return { rows: [], fields: [] };
    }
    // The "real" query. Postgres would cancel it server-side once
    // simulatedDurationMs exceeds whatever statement_timeout is active for
    // this transaction — this is that same rule, applied here.
    if (this.timeoutMs !== null && this.simulatedDurationMs > this.timeoutMs) {
      const err = new Error("canceling statement due to statement timeout") as Error & { code: string };
      err.code = "57014";
      throw err;
    }
    return { rows: [{ id: 1 }], fields: [] };
  }

  release = vi.fn();
}

describe("executeWithStatementTimeout", () => {
  it("sets SET LOCAL statement_timeout from the given timeoutMs, not a fixed constant", async () => {
    const client = new FakeClient(0);
    const pool = { connect: async () => client } as unknown as import("pg").Pool;
    await executeWithStatementTimeout(pool, "SELECT 1", [], 5000);
    expect(client.calls).toContain("SET LOCAL statement_timeout = 5000");

    const client2 = new FakeClient(0);
    const pool2 = { connect: async () => client2 } as unknown as import("pg").Pool;
    await executeWithStatementTimeout(pool2, "SELECT 1", [], 250);
    expect(client2.calls).toContain("SET LOCAL statement_timeout = 250");
  });

  it("terminates a query that runs past the configured timeout, and propagates the cancellation", async () => {
    // Query "takes" 200ms; timeout is set to 50ms — must be canceled.
    const client = new FakeClient(200);
    const pool = { connect: async () => client } as unknown as import("pg").Pool;

    await expect(executeWithStatementTimeout(pool, "SELECT pg_sleep(1)", [], 50)).rejects.toMatchObject({
      code: "57014",
    });
    expect(client.calls).toEqual([
      "BEGIN",
      "SET LOCAL statement_timeout = 50",
      "SELECT pg_sleep(1)",
      "ROLLBACK",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("commits and returns rows when the query finishes within the timeout", async () => {
    // Same simulated duration as the query above, but now given a longer
    // timeout — proves the outcome tracks body.timeoutMs, not the query
    // itself or a hardcoded threshold.
    const client = new FakeClient(200);
    const pool = { connect: async () => client } as unknown as import("pg").Pool;

    const result = await executeWithStatementTimeout(pool, "SELECT 1", [], 5000);
    expect(result.rows).toEqual([{ id: 1 }]);
    expect(client.calls).toEqual([
      "BEGIN",
      "SET LOCAL statement_timeout = 5000",
      "SELECT 1",
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
