import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { dbPool } from "../dbPool.js";
import { finishRun, recordChunkProgress, startRun } from "./workflowRuns.js";

/**
 * Subscription Phase 3, Slice 2 — mandatory test: "a run is counted once
 * despite multiple chunks/retries." finishRun's usage_events insert is
 * guarded by a real unique index on (kind, subject_id)
 * (0066_usage_events.sql) — a mock can't meaningfully stand in for that, so
 * this proves it against real local Postgres (apps/worker/.env's
 * DATABASE_URL). Run explicitly with `pnpm test:integration`
 * (apps/worker/vitest.integration.config.ts).
 */

afterAll(async () => {
  await dbPool.end();
});

async function makeOrgFixture(): Promise<{ orgId: string; workflowId: string }> {
  const { rows: userRows } = await dbPool.query<{ id: string }>('select id from public."user" limit 1');
  const userId = userRows[0]?.id;
  if (!userId) throw new Error("no fixture user found — run `pnpm --filter @nia/api seed:fixtures` first");

  const { rows: orgRows } = await dbPool.query<{ id: string }>(
    `insert into public.organizations (name, slug, created_by) values ($1, $2, $3) returning id`,
    [
      "usage events ledger test org",
      `usage-events-ledger-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      userId,
    ],
  );
  const orgId = orgRows[0]!.id;

  const { rows: projectRows } = await dbPool.query<{ id: string }>(
    `insert into public.projects (org_id, name, created_by) values ($1, $2, $3) returning id`,
    [orgId, "usage events ledger test project", userId],
  );
  const projectId = projectRows[0]!.id;

  const { rows: workflowRows } = await dbPool.query<{ id: string }>(
    `insert into public.workflows (project_id, org_id, name, created_by) values ($1, $2, $3, $4) returning id`,
    [projectId, orgId, "usage events ledger test workflow", userId],
  );
  const workflowId = workflowRows[0]!.id;

  return { orgId, workflowId };
}

async function dropOrg(orgId: string): Promise<void> {
  // workflows/projects/workflow_runs/usage_events all cascade from
  // organizations(id) on delete cascade.
  await dbPool.query("delete from public.organizations where id = $1", [orgId]);
}

describe("finishRun's usage_events insert — real Postgres", () => {
  it("counts a run's rows exactly once even across multiple chunks and a duplicate finishRun call (stalled-job retry)", async () => {
    const { orgId, workflowId } = await makeOrgFixture();
    const runId = randomUUID();

    try {
      await startRun(runId, workflowId, { orgId });
      await recordChunkProgress(runId, 40, JSON.stringify({ cursor: "chunk-1" }));
      await recordChunkProgress(runId, 60, JSON.stringify({ cursor: "chunk-2" }));

      await finishRun(runId, "succeeded");
      // Simulates a BullMQ stalled-job retry redelivering the same terminal
      // call a second time.
      await finishRun(runId, "succeeded");

      const { rows } = await dbPool.query<{ quantity: number }>(
        "select quantity from public.usage_events where kind = 'rows_moved' and subject_id = $1",
        [runId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.quantity).toBe(100);
    } finally {
      await dropOrg(orgId);
    }
  });

  it("never writes a usage_events row for a run that finishes with zero rows processed", async () => {
    const { orgId, workflowId } = await makeOrgFixture();
    const runId = randomUUID();

    try {
      await startRun(runId, workflowId, { orgId });
      await finishRun(runId, "failed", { message: "no rows written before failure" });

      const { rows } = await dbPool.query(
        "select 1 from public.usage_events where kind = 'rows_moved' and subject_id = $1",
        [runId],
      );
      expect(rows).toHaveLength(0);
    } finally {
      await dropOrg(orgId);
    }
  });
});
