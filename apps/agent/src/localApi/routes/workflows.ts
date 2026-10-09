import { loadConfig } from "../../config/store.js";
import type { JobScheduler } from "../../scheduler/jobScheduler.js";
import { LinkRevokedError, LinkTransientError } from "../../link/transport.js";
import {
  MassDeleteGuardError,
  WorkflowNotFoundError,
  type WorkflowActionBody,
  type WorkflowRun,
  type WorkflowStatus,
  type WorkflowSummary,
  type WorkflowsClient,
} from "../../link/workflowsClient.js";
import { ApiError, BadRequestError, NotFoundError, OfflineError } from "../errors.js";
import type { LocalApiDeps } from "../deps.js";
import type { RouteDefinition } from "../router.js";

/** Local-only status the bridge has no concept of — see jobScheduler.isRunning's own doc comment. */
export type LocalWorkflowStatus = WorkflowStatus | "running";

export interface LocalWorkflowSummary extends Omit<WorkflowSummary, "status"> {
  status: LocalWorkflowStatus;
}

/**
 * One in-memory slot per bridge call this module makes — not per
 * workflow, since `GET /workflows` is itself the "all workflows" call.
 * Process-local, cleared on restart; "last known good" is only ever as
 * fresh as this process's own most recent successful call, which is the
 * whole point (no new on-disk state, no cross-restart staleness claims).
 */
const cache = new Map<string, unknown>();

function mapClientError(err: unknown): never {
  if (err instanceof LinkRevokedError) throw new ApiError(401, "revoked", "this agent's pairing has been revoked");
  if (err instanceof WorkflowNotFoundError) throw new NotFoundError("workflow not found");
  if (err instanceof MassDeleteGuardError) throw new ApiError(403, "massDeleteGuard", err.message);
  throw err;
}

/**
 * Shared by every read route below: calls `fetcher` against the live
 * client when one exists, caching the result under `key` on success;
 * falls back to the last cached value under `key` — tagged
 * `offline: true` — whenever there's no live client at all (unpaired) or
 * the call itself fails transiently (`LinkTransientError`). A
 * `WorkflowNotFoundError`/`MassDeleteGuardError`/`LinkRevokedError` is
 * never swallowed into a stale fallback — those are real, current
 * answers from the platform, not something a cache should paper over.
 */
async function fetchWithOfflineFallback<T>(
  key: string,
  client: WorkflowsClient | undefined,
  fetcher: (client: WorkflowsClient) => Promise<T>,
): Promise<{ data: T; offline: boolean }> {
  if (!client) {
    const cached = cache.get(key);
    if (cached !== undefined) return { data: cached as T, offline: true };
    throw new OfflineError();
  }

  try {
    const data = await fetcher(client);
    cache.set(key, data);
    return { data, offline: false };
  } catch (err) {
    if (err instanceof LinkTransientError) {
      const cached = cache.get(key);
      if (cached !== undefined) return { data: cached as T, offline: true };
      throw new OfflineError();
    }
    mapClientError(err);
  }
}

/**
 * The only place "running" is computed — true only while this very
 * process has an in-flight run for the local job id a workflow's
 * `setupId` maps to (jobScheduler.ts's `isRunning`, backed by each
 * `JobRuntime.running` flag). The bridge is never asked about this: a
 * platform-managed job's local job id equals its `agent_setups.id`
 * (same `setupId`), which is how `agent.config.json`'s
 * `job.platformManaged.setupId` ties the two together (see
 * localJobReports.ts's own doc comment on this same mapping).
 */
function applyRunningOverlay(workflows: WorkflowSummary[], dir: string, scheduler: JobScheduler | undefined): LocalWorkflowSummary[] {
  if (!scheduler) return workflows;
  const config = loadConfig(dir);
  const jobIdBySetupId = new Map<string, string>();
  for (const job of config.jobs) {
    if (job.platformManaged?.setupId) jobIdBySetupId.set(job.platformManaged.setupId, job.id);
  }
  return workflows.map((workflow) => {
    const jobId = jobIdBySetupId.get(workflow.setupId);
    if (jobId && scheduler.isRunning(jobId)) {
      return { ...workflow, status: "running" };
    }
    return workflow;
  });
}

function parseActionBody(body: unknown): WorkflowActionBody {
  const raw = (body ?? {}) as Record<string, unknown>;
  if (raw.kind !== "run_now" && raw.kind !== "pause" && raw.kind !== "resume") {
    throw new BadRequestError('kind must be one of "run_now", "pause", "resume"');
  }
  if (raw.params !== undefined) {
    if (typeof raw.params !== "object" || raw.params === null || Array.isArray(raw.params)) {
      throw new BadRequestError("params must be an object of string values");
    }
    for (const value of Object.values(raw.params as Record<string, unknown>)) {
      if (typeof value !== "string") throw new BadRequestError("params must be an object of string values");
    }
  }
  if (raw.fullReload !== undefined && typeof raw.fullReload !== "boolean") {
    throw new BadRequestError("fullReload must be a boolean");
  }
  // Deliberately no `allowMassDelete` field read here at all — this
  // route accepts whatever JSON a caller sends, but nothing downstream
  // of `parseActionBody` can ever forward such a key to the bridge,
  // which would reject it anyway (WorkflowActionBody's `.strict()`).
  return {
    kind: raw.kind,
    params: raw.params as Record<string, string> | undefined,
    fullReload: raw.fullReload as boolean | undefined,
  };
}

export function buildWorkflowsRoutes(deps: LocalApiDeps): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/workflows",
      handler: async () => {
        const client = deps.getWorkflowsClient?.();
        const { data, offline } = await fetchWithOfflineFallback("workflows", client, (c) => c.listWorkflows());
        return { workflows: applyRunningOverlay(data, deps.dir, deps.scheduler), offline };
      },
    },
    {
      method: "GET",
      path: "/workflows/:workflowId",
      handler: async (ctx) => {
        const client = deps.getWorkflowsClient?.();
        const { data, offline } = await fetchWithOfflineFallback("workflows", client, (c) => c.listWorkflows());
        const workflow = applyRunningOverlay(data, deps.dir, deps.scheduler).find((w) => w.workflowId === ctx.params.workflowId);
        if (!workflow) throw new NotFoundError("workflow not found");
        return { workflow, platformUrl: deps.getPlatformUrl?.(), offline };
      },
    },
    {
      method: "GET",
      path: "/workflows/:workflowId/runs",
      handler: async (ctx) => {
        const client = deps.getWorkflowsClient?.();
        const limitParam = ctx.query.get("limit");
        const limit = limitParam ? Number(limitParam) : undefined;
        const { data, offline } = await fetchWithOfflineFallback<WorkflowRun[]>(
          `runs:${ctx.params.workflowId}`,
          client,
          (c) => c.listRuns(ctx.params.workflowId!, limit),
        );
        return { runs: data, offline };
      },
    },
    {
      method: "GET",
      path: "/workflows/:workflowId/graph",
      handler: async (ctx) => {
        const client = deps.getWorkflowsClient?.();
        const { data, offline } = await fetchWithOfflineFallback(`graph:${ctx.params.workflowId}`, client, (c) =>
          c.getGraph(ctx.params.workflowId!),
        );
        return { graph: data, offline };
      },
    },
    {
      // Mutating — never served from cache/offline fallback. No live
      // link at all is reported the same way as every other "can't
      // reach the platform right now" case (503), rather than silently
      // pretending the action went through.
      method: "POST",
      path: "/workflows/:workflowId/actions",
      handler: async (ctx) => {
        const client = deps.getWorkflowsClient?.();
        if (!client) throw new OfflineError();
        const body = parseActionBody(ctx.body);
        try {
          await client.postAction(ctx.params.workflowId!, body);
        } catch (err) {
          if (err instanceof LinkTransientError) throw new OfflineError();
          mapClientError(err);
        }
        return { ok: true as const };
      },
    },
  ];
}
