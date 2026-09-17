import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import type { CheckRunJob } from "@nia/schemas";
import { AppError } from "./appError.js";
import { runCheckRunJob } from "./checksQueue.js";

function makeJob(): Omit<CheckRunJob, "kind"> {
  return {
    scope: { ownerId: randomUUID() },
    workflowId: randomUUID(),
    checks: ["dag"],
    triggeredByUserId: randomUUID(),
  };
}

/**
 * Exercises the real BullMQ waitUntilFinished timeout path against real
 * local Redis (same "don't mock the thing under test" convention as
 * sse.replay.test.ts) — no apps/worker process is started for this job, so
 * it never completes, and a tiny opts.timeoutMs override (instead of
 * env.CHECK_RUN_TIMEOUT_MS's real ~30s default) keeps the test fast.
 */
describe("runCheckRunJob timeout", () => {
  it("rejects with a 503 naming the worker unavailable when no worker completes the job in time", async () => {
    await expect(runCheckRunJob(makeJob(), { timeoutMs: 5 })).rejects.toMatchObject({
      statusCode: 503,
      code: "CHECK_RUN_WORKER_UNAVAILABLE",
    });
  });

  it("rejection is an AppError instance", async () => {
    await expect(runCheckRunJob(makeJob(), { timeoutMs: 5 })).rejects.toBeInstanceOf(AppError);
  });
});
