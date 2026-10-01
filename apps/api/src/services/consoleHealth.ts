import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_INTERACTIVE, QUEUE_HEAVY } from "@nia/schemas";
import type { Queryable } from "@nia/db";
import { env } from "../env.js";

/**
 * Console v2 Slice 4 (docs/plans/console-plan.md's "Slice 4 — System
 * Health page") — service layer for the Console System Health screen.
 *
 * Worker detection uses BullMQ's `Queue.getWorkers()` (CLIENT LIST against
 * the shared Redis connection every `Worker` instance opens — see
 * apps/worker/src/index.ts's two `Worker`s on QUEUE_INTERACTIVE/QUEUE_HEAVY),
 * not a Redis heartbeat key. This was confirmed live against this project's
 * own dev Redis (`docker-compose.yml`'s `redis` service): a `Queue` and a
 * `Worker` sharing one connection, `getWorkers()` reliably lists the worker
 * once it's ready and reports empty once it's closed — no apps/worker code
 * change was needed, so the heartbeat fallback described in the plan's
 * Context section was not built.
 *
 * Module-level singleton Redis connection + two read-only `Queue` instances
 * (one per queue name), same "one connection per route-file module" shape
 * as every lib/*Queue.ts producer (profileQueue.ts, runQueue.ts, etc.) —
 * these two never `.add()` a job, they only ever call `getWorkers()`/
 * `getJobCounts()`.
 */
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const interactiveQueue = new Queue(QUEUE_INTERACTIVE, { connection });
const heavyQueue = new Queue(QUEUE_HEAVY, { connection });

export type WorkerStatus = "healthy" | "no_workers";

export type QueueBacklog = {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
};

export type ConnectorHealthSummary = {
  ok: number;
  error: number;
  untested: number;
};

export type LatestMigration = {
  version: string;
  name: string;
  finishedAt: string;
} | null;

export type SystemHealth = {
  api: "ok";
  worker: {
    status: WorkerStatus;
    count: number;
  };
  queues: QueueBacklog[];
  failedRuns24h: number;
  connectors: ConnectorHealthSummary;
  latestMigration: LatestMigration;
};

/**
 * `getWorkers()` returns one entry per connected `Worker` process per queue
 * it's listening on — a single worker process listening on both queues (as
 * apps/worker/src/index.ts does) shows up once per queue, not once overall.
 * Deduped here by Redis client `addr` (ip:port) so "how many worker
 * *processes* are up" doesn't double-count a single process as two.
 */
async function getWorkerStatus(): Promise<{ status: WorkerStatus; count: number }> {
  const [interactiveWorkers, heavyWorkers] = await Promise.all([
    interactiveQueue.getWorkers(),
    heavyQueue.getWorkers(),
  ]);
  const addrs = new Set<string>();
  for (const w of [...interactiveWorkers, ...heavyWorkers]) {
    if (w.addr) addrs.add(w.addr);
  }
  return { status: addrs.size > 0 ? "healthy" : "no_workers", count: addrs.size };
}

async function getQueueBacklog(): Promise<QueueBacklog[]> {
  const [interactiveCounts, heavyCounts] = await Promise.all([
    interactiveQueue.getJobCounts("waiting", "active", "delayed", "failed"),
    heavyQueue.getJobCounts("waiting", "active", "delayed", "failed"),
  ]);
  return [
    {
      name: QUEUE_INTERACTIVE,
      waiting: interactiveCounts.waiting ?? 0,
      active: interactiveCounts.active ?? 0,
      delayed: interactiveCounts.delayed ?? 0,
      failed: interactiveCounts.failed ?? 0,
    },
    {
      name: QUEUE_HEAVY,
      waiting: heavyCounts.waiting ?? 0,
      active: heavyCounts.active ?? 0,
      delayed: heavyCounts.delayed ?? 0,
      failed: heavyCounts.failed ?? 0,
    },
  ];
}

async function getFailedRuns24h(db: Queryable): Promise<number> {
  const result = await db.query<{ count: string }>(
    `select count(*) as count
     from public.workflow_runs
     where status = 'failed' and started_at > now() - interval '24 hours'`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** Cross-org aggregate of every connection's last test result — same three-state shape as the Connectors tab (console.ts's GET /orgs/:orgId/connectors), just summed across all orgs instead of one. */
async function getConnectorHealth(db: Queryable): Promise<ConnectorHealthSummary> {
  const result = await db.query<{ last_test_status: "ok" | "error" | null; count: string }>(
    `select last_test_status, count(*) as count
     from public.connections
     group by last_test_status`,
  );
  const summary: ConnectorHealthSummary = { ok: 0, error: 0, untested: 0 };
  for (const row of result.rows) {
    const count = Number(row.count);
    if (row.last_test_status === "ok") summary.ok = count;
    else if (row.last_test_status === "error") summary.error = count;
    else summary.untested = count;
  }
  return summary;
}

async function getLatestMigration(db: Queryable): Promise<LatestMigration> {
  const result = await db.query<{ version: string; name: string; finished_at: string }>(
    `select version, name, finished_at
     from public._migrations
     where finished_at is not null and rolled_back_at is null
     order by version desc
     limit 1`,
  );
  const row = result.rows[0];
  if (!row) return null;
  return { version: row.version, name: row.name, finishedAt: row.finished_at };
}

export async function getSystemHealth(db: Queryable): Promise<SystemHealth> {
  const [worker, queues, failedRuns24h, connectors, latestMigration] = await Promise.all([
    getWorkerStatus(),
    getQueueBacklog(),
    getFailedRuns24h(db),
    getConnectorHealth(db),
    getLatestMigration(db),
  ]);

  return { api: "ok", worker, queues, failedRuns24h, connectors, latestMigration };
}
