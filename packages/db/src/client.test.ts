import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { withActingUser, withServiceRole } from "./client.js";

/**
 * Unit-level: exercises withActingUser/withServiceRole's own control flow
 * (BEGIN/COMMIT/ROLLBACK sequencing, release-on-error) against a mocked
 * pg.Pool/pg.PoolClient — no real Postgres involved. The properties that
 * actually require a real database (RLS isolation, auth.uid()/role
 * resolution, connection state cleared on release) are proven in
 * client.integration.test.ts instead, against real local Postgres.
 */

function fakePool() {
  const query = vi.fn(async (_text: string, _params?: readonly unknown[]) => ({ rows: [], rowCount: 0 }) as never);
  const release = vi.fn();
  const client = { query, release } as unknown as pg.PoolClient;
  const connect = vi.fn(async () => client);
  const pool = { connect } as unknown as pg.Pool;
  return { pool, client, query, release, connect };
}

describe("withActingUser", () => {
  it("sets role + jwt claim, runs the callback, commits, and releases", async () => {
    const { pool, query, release } = fakePool();

    const result = await withActingUser(pool, "user-1", async (db) => {
      await db.query("select 1");
      return 42;
    });

    expect(result).toBe(42);
    const calls = query.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      "BEGIN",
      "SET LOCAL ROLE authenticated",
      "SELECT set_config('request.jwt.claims', $1, true)",
      "select 1",
      "COMMIT",
    ]);
    expect(query.mock.calls[2]?.[1]).toEqual([JSON.stringify({ sub: "user-1", role: "authenticated" })]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rolls back and releases the connection when the callback throws", async () => {
    const { pool, query, release } = fakePool();
    const boom = new Error("boom");

    await expect(
      withActingUser(pool, "user-1", async () => {
        throw boom;
      }),
    ).rejects.toThrow(boom);

    const calls = query.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["BEGIN", "SET LOCAL ROLE authenticated", "SELECT set_config('request.jwt.claims', $1, true)", "ROLLBACK"]);
    expect(calls).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the connection back to the pool even if COMMIT itself throws", async () => {
    const { pool, query, release } = fakePool();
    query.mockImplementation(async (text: string) => {
      if (text === "COMMIT") throw new Error("commit failed");
      return { rows: [], rowCount: 0 } as never;
    });

    await expect(withActingUser(pool, "user-1", async () => "ok")).rejects.toThrow("commit failed");
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("withServiceRole", () => {
  it("sets service_role and never sets request.jwt.claims", async () => {
    const { pool, query, release } = fakePool();

    const result = await withServiceRole(pool, async (db) => {
      await db.query("select 1");
      return "done";
    });

    expect(result).toBe("done");
    const calls = query.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["BEGIN", "SET LOCAL ROLE service_role", "select 1", "COMMIT"]);
    expect(calls.some((c) => c.includes("request.jwt.claims"))).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rolls back and releases on error, same as withActingUser", async () => {
    const { pool, query, release } = fakePool();
    const boom = new Error("service-role boom");

    await expect(
      withServiceRole(pool, async () => {
        throw boom;
      }),
    ).rejects.toThrow(boom);

    expect(query.mock.calls.map((c) => c[0])).toEqual(["BEGIN", "SET LOCAL ROLE service_role", "ROLLBACK"]);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
