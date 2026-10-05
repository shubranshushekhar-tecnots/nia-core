import { AgentJobSetup, diffAgentJobSetup, type AgentJobSetupDiff } from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";
import type { WithUser } from "../lib/withUser.js";
import { assertWorkflowInScope } from "./checks.js";

/**
 * Agent-Canvas integration, Slice R3a (docs/plans/agent-canvas-integration.md
 * B.2/B.4/B.7) — the platform side of publishing a job to an agent.
 * supabase/migrations/0073_agent_setup_publish.sql's publish_agent_setup/
 * unpublish_agent_setup RPCs are the real trust boundary (same
 * "RLS/DB is the real trust boundary, can.ts is convenience only"
 * discipline as every other RPC in this codebase); validatePublishTargets
 * below is a read-only, RLS-scoped pre-check used by both preview and
 * publish so a bad request gets a fast, specific error before ever
 * reaching the privileged RPC — not a replacement for it.
 */

type PublishedRow = {
  id: string;
  workflow_id: string;
  agent_id: string;
  wanted_version: number;
  applied_version: number;
  published_setup: unknown;
  published_at: string | null;
  unpublished_at: string | null;
  rejection_reason: string | null;
};

const PUBLISHED_SELECT =
  "id, workflow_id, agent_id, wanted_version, applied_version, published_setup, published_at, unpublished_at, rejection_reason";

async function getPublishedRow(withUser: WithUser, workflowId: string): Promise<PublishedRow | null> {
  const { rows } = await withUser((db) =>
    db.query<PublishedRow>(
      `select ${PUBLISHED_SELECT} from agent_setups where workflow_id = $1 and source = 'platform' limit 1`,
      [workflowId],
    ),
  );
  return rows[0] ?? null;
}

type ScopedRow = { org_id: string | null; owner_id: string | null };

function inScope(scope: WorkspaceScope, row: ScopedRow): boolean {
  return ("orgId" in scope && row.org_id === scope.orgId) || ("ownerId" in scope && row.owner_id === scope.ownerId);
}

type ConnectionRow = ScopedRow & { id: string; connector_id: string; config: Record<string, unknown> | null };

const ALLOWED_DESTINATION_CONNECTORS = new Set(["planometry-table", "https-endpoint"]);

/**
 * Read-only mirror of publish_agent_setup's business rules (source is a
 * local-database-via-agent connection, destination is a Planometry table
 * or HTTPS endpoint, both in the same organisation/workspace as the
 * workflow, on an active agent in that same scope) — every SELECT here is
 * already RLS-visible to any member with access to the workflow, so this
 * never needs service-role.
 */
async function validatePublishTargets(
  withUser: WithUser,
  scope: WorkspaceScope,
  sourceConnectionId: string,
  destinationConnectionId: string,
): Promise<{ agentId: string }> {
  const { rows } = await withUser((db) =>
    db.query<ConnectionRow>(
      "select id, org_id, owner_id, connector_id, config from connections where id = any($1::uuid[])",
      [[sourceConnectionId, destinationConnectionId]],
    ),
  );

  const source = rows.find((row) => row.id === sourceConnectionId);
  const destination = rows.find((row) => row.id === destinationConnectionId);

  if (!source) throw new AppError(404, "NOT_FOUND", "Source connection not found.");
  if (source.connector_id !== "sqlserver-agent") {
    throw new AppError(400, "INVALID_SOURCE", "Source connection must be a local database connection.");
  }
  if (!inScope(scope, source)) {
    throw new AppError(400, "SCOPE_MISMATCH", "Source connection is not in the same organisation or workspace as the workflow.");
  }

  if (!destination) throw new AppError(404, "NOT_FOUND", "Destination connection not found.");
  if (!ALLOWED_DESTINATION_CONNECTORS.has(destination.connector_id)) {
    throw new AppError(400, "INVALID_DESTINATION", "Destination connection must be a Planometry table or HTTPS endpoint.");
  }
  if (!inScope(scope, destination)) {
    throw new AppError(400, "SCOPE_MISMATCH", "Destination connection is not in the same organisation or workspace as the workflow.");
  }

  const agentId = typeof source.config?.["agentId"] === "string" ? (source.config["agentId"] as string) : null;
  if (!agentId) throw new AppError(400, "NO_AGENT", "Source connection has no agent configured.");

  const { rows: agentRows } = await withUser((db) =>
    db.query<ScopedRow & { id: string; status: string }>(
      "select id, status, org_id, owner_id from platform_agents where id = $1",
      [agentId],
    ),
  );
  const agent = agentRows[0];
  if (!agent) throw new AppError(404, "NOT_FOUND", "Agent not found.");
  if (agent.status !== "active") throw new AppError(400, "AGENT_NOT_ACTIVE", "Agent is not active.");
  if (!inScope(scope, agent)) {
    throw new AppError(400, "SCOPE_MISMATCH", "Agent is not in the same organisation or workspace as the workflow.");
  }

  return { agentId };
}

export type PreviewPublishResult = {
  diff: AgentJobSetupDiff;
  currentlyPublished: boolean;
};

/** Validates a workflow's setup and reports what would change against the currently published one — never writes. */
export async function previewPublishAgentSetup(
  withUser: WithUser,
  scope: WorkspaceScope,
  workflowId: string,
  sourceConnectionId: string,
  destinationConnectionId: string,
  setup: AgentJobSetup,
): Promise<PreviewPublishResult> {
  await assertWorkflowInScope(withUser, scope, workflowId);
  await validatePublishTargets(withUser, scope, sourceConnectionId, destinationConnectionId);

  const existing = await getPublishedRow(withUser, workflowId);
  const previous =
    existing && !existing.unpublished_at ? AgentJobSetup.parse(existing.published_setup) : null;

  return { diff: diffAgentJobSetup(previous, setup), currentlyPublished: previous !== null };
}

export type AgentSetupPublication = {
  id: string;
  workflowId: string;
  agentId: string;
  wantedVersion: number;
  appliedVersion: number;
  publishedAt: string | null;
};

function toPublication(row: {
  id: string;
  workflow_id: string;
  agent_id: string;
  wanted_version: number;
  applied_version: number;
  published_at: string | null;
}): AgentSetupPublication {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    agentId: row.agent_id,
    wantedVersion: row.wanted_version,
    appliedVersion: row.applied_version,
    publishedAt: row.published_at,
  };
}

/**
 * Stores the setup and raises its wanted version via publish_agent_setup
 * (0073). Allowed for any member with access to the workflow, not viewers
 * — enforced twice: the route's requireCapability("workflows.updateDefinition")
 * (already excludes viewer, packages/schemas/src/can.ts) and the RPC's own
 * private.can_write_workflow check (defense-in-depth, same posture as
 * every other RPC in this codebase).
 */
export async function publishAgentSetup(
  withUser: WithUser,
  scope: WorkspaceScope,
  workflowId: string,
  sourceConnectionId: string,
  destinationConnectionId: string,
  setup: AgentJobSetup,
): Promise<AgentSetupPublication> {
  await assertWorkflowInScope(withUser, scope, workflowId);
  await validatePublishTargets(withUser, scope, sourceConnectionId, destinationConnectionId);

  try {
    const { rows } = await withUser((db) =>
      db.query<{
        id: string;
        workflow_id: string;
        agent_id: string;
        wanted_version: number;
        applied_version: number;
        published_at: string | null;
      }>(
        `select id, workflow_id, agent_id, wanted_version, applied_version, published_at
         from public.publish_agent_setup($1, $2, $3, $4)`,
        [workflowId, sourceConnectionId, destinationConnectionId, JSON.stringify(setup)],
      ),
    );
    const row = rows[0];
    if (!row) throw new AppError(409, "PUBLISH_FAILED", "Could not publish this setup.");
    return toPublication(row);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(403, "PUBLISH_REFUSED", err instanceof Error ? err.message : String(err));
  }
}

/** Marks the setup removed via unpublish_agent_setup (0073) — soft, run history survives. */
export async function unpublishAgentSetup(
  withUser: WithUser,
  scope: WorkspaceScope,
  workflowId: string,
): Promise<AgentSetupPublication> {
  await assertWorkflowInScope(withUser, scope, workflowId);

  try {
    const { rows } = await withUser((db) =>
      db.query<{
        id: string;
        workflow_id: string;
        agent_id: string;
        wanted_version: number;
        applied_version: number;
        published_at: string | null;
      }>(
        `select id, workflow_id, agent_id, wanted_version, applied_version, published_at
         from public.unpublish_agent_setup($1)`,
        [workflowId],
      ),
    );
    const row = rows[0];
    if (!row) throw new AppError(409, "UNPUBLISH_FAILED", "Could not unpublish this setup.");
    return toPublication(row);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(403, "UNPUBLISH_REFUSED", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Slice R4 (docs/plans/agent-canvas-integration.md B.7, item 6) — "the
 * workflow then shows its state: waiting for the agent, applied with its
 * version, or rejected with the agent's reason." R3a's publish/unpublish
 * routes never had a plain read route, so this is that one: read-only,
 * never writes, available to a viewer (unlike publish/unpublish — gated
 * only by workflow scope, not requireCapability).
 */
export type AgentSetupState = "unpublished" | "waiting" | "applied" | "rejected";

export type AgentSetupStateResult = {
  state: AgentSetupState;
  wantedVersion: number;
  appliedVersion: number;
  publishedAt: string | null;
  rejectionReason: string | null;
};

function toState(row: PublishedRow | null): AgentSetupStateResult {
  if (!row || row.unpublished_at) {
    return { state: "unpublished", wantedVersion: 0, appliedVersion: 0, publishedAt: null, rejectionReason: null };
  }
  const base = { wantedVersion: row.wanted_version, appliedVersion: row.applied_version, publishedAt: row.published_at };
  if (row.wanted_version <= row.applied_version) {
    return { ...base, state: "applied", rejectionReason: null };
  }
  if (row.rejection_reason) {
    return { ...base, state: "rejected", rejectionReason: row.rejection_reason };
  }
  return { ...base, state: "waiting", rejectionReason: null };
}

export async function getAgentSetupState(
  withUser: WithUser,
  scope: WorkspaceScope,
  workflowId: string,
): Promise<AgentSetupStateResult> {
  await assertWorkflowInScope(withUser, scope, workflowId);
  const row = await getPublishedRow(withUser, workflowId);
  return toState(row);
}
