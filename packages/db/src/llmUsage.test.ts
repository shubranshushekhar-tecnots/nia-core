import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { recordLlmUsage } from "./llmUsage.js";

/**
 * Unit-level: exercises recordLlmUsage's own insert shape and error-
 * swallowing against a mocked pg.Pool, same pattern as client.test.ts.
 */

function fakePool() {
  const query = vi.fn(async (_text: string, _params?: readonly unknown[]) => ({ rows: [], rowCount: 0 }) as never);
  const release = vi.fn();
  const client = { query, release } as unknown as pg.PoolClient;
  const connect = vi.fn(async () => client);
  const pool = { connect } as unknown as pg.Pool;
  return { pool, query, release };
}

describe("recordLlmUsage", () => {
  it("inserts one row with org scope and full usage, usage_known true", async () => {
    const { pool, query } = fakePool();

    await recordLlmUsage(pool, {
      scope: { orgId: "org-1" },
      userId: "user-1",
      workflowId: "wf-1",
      runId: "job-1",
      feature: "chat_build_answer",
      model: "gpt-test",
      latencyMs: 123,
      status: "ok",
      usage: { inputTokens: 10, outputTokens: 20, cachedTokens: 0, totalTokens: 30 },
    });

    const insertCall = query.mock.calls.find((c) => (c[0] as string).includes("insert into public.llm_usage"));
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    expect(params).toEqual(["org-1", null, "user-1", "wf-1", "job-1", "chat_build_answer", "gpt-test", 10, 20, 0, 30, 123, "ok", true, null]);
  });

  it("inserts one row with owner scope and no usage, usage_known false, all token columns null", async () => {
    const { pool, query } = fakePool();

    await recordLlmUsage(pool, {
      scope: { ownerId: "owner-1" },
      feature: "chat_faithfulness",
      model: "gpt-test",
      latencyMs: 45,
      status: "aborted",
      errorCode: "stream dropped",
    });

    const insertCall = query.mock.calls.find((c) => (c[0] as string).includes("insert into public.llm_usage"));
    const params = insertCall![1] as unknown[];
    expect(params).toEqual([null, "owner-1", null, null, null, "chat_faithfulness", "gpt-test", null, null, null, null, 45, "aborted", false, "stream dropped"]);
  });

  it("swallows an insert failure instead of throwing", async () => {
    const { pool, query } = fakePool();
    query.mockImplementation(async (text: string) => {
      if (text === "BEGIN" || text === "SET LOCAL ROLE service_role") return { rows: [], rowCount: 0 } as never;
      throw new Error("db unreachable");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      recordLlmUsage(pool, {
        scope: { orgId: "org-1" },
        feature: "plan_generation",
        model: "gpt-test",
        latencyMs: 1,
        status: "error",
        errorCode: "boom",
      }),
    ).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});
