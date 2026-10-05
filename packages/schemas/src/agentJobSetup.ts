import { z } from "zod";
import { FilterCondition } from "./nodeConfig.js";

/**
 * Agent-Canvas integration, Slice R3a (docs/plans/agent-canvas-integration.md
 * B.2/B.4/B.7) — the platform-side shape of a job published to an agent.
 * Shaped close to the agent's own job (apps/agent/src/config/types.ts's
 * SyncJobEntry) but platform-native: `sourceConnectionId`/
 * `destinationConnectionId` are this platform's own `connections.id`
 * values (a `sqlserver-agent` connection and a `planometry-table`/
 * `https-endpoint` connection respectively), never an agent-local id or a
 * bare URL. Deliberately carries NO secrets — no push key, no auth token,
 * no credential ref of any kind. The destination connection's own
 * `vault_secret_ref` is the only path to that secret, fetched by the
 * agent separately and only after it has applied this setup (see the
 * bridge's `/agent-api/setups/:id/secret`).
 *
 * `filter` reuses nodeConfig.ts's `FilterCondition[]` (the flat AND-chain
 * shape, not a full Expr tree — B.7's "Reused" column) rather than
 * inventing a parallel filter grammar.
 */
export const AgentJobSetupMappingColumn = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
});
export type AgentJobSetupMappingColumn = z.infer<typeof AgentJobSetupMappingColumn>;

export const AgentJobSetupColumn = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  isKey: z.boolean(),
});
export type AgentJobSetupColumn = z.infer<typeof AgentJobSetupColumn>;

/** Mirrors SyncJobEntry's JobStrategy exactly (B.7). */
export const AgentJobSetupMode = z.enum(["replace", "upsertDelta", "realtime"]);
export type AgentJobSetupMode = z.infer<typeof AgentJobSetupMode>;

/** Mirrors SyncJobEntry's DeleteMode exactly (B.7). */
export const AgentJobSetupDeleteMode = z.enum(["none", "reconciliation", "softDelete"]);
export type AgentJobSetupDeleteMode = z.infer<typeof AgentJobSetupDeleteMode>;

export const AgentJobSetup = z.object({
  sourceConnectionId: z.string().uuid(),
  /** Catalog-exact source table/view name (e.g. "dbo.vw_salesdata"). */
  sourceTable: z.string().min(1),
  destinationConnectionId: z.string().uuid(),
  /** The target's column shape as last seen — drift detection, same role as SyncJobEntry.targetSchemaSnapshot. */
  columns: z.array(AgentJobSetupColumn).default([]),
  mapping: z.array(AgentJobSetupMappingColumn).default([]),
  /** AND-joined; may reference `params` by name. Filter columns need not be in `mapping`. */
  filter: z.array(FilterCondition).default([]),
  /** Saved named-parameter values (raw strings, including relative-date tokens stored as literal text). */
  params: z.record(z.string(), z.string()).default({}),
  mode: AgentJobSetupMode,
  /** `mode: "upsertDelta"` or `"realtime"` only: the date-time watermark column. */
  watermarkColumn: z.string().optional(),
  overlapSeconds: z.number().int().positive().optional(),
  /** 5-field cron expression, evaluated by the agent in its connection's own source time zone. */
  schedule: z.string().optional(),
  /** A separate cron expression for a periodic full `replace`, independent of `schedule`'s delta cadence. */
  replaceSchedule: z.string().optional(),
  pollIntervalSeconds: z.number().int().positive().optional(),
  reconciliationIntervalSeconds: z.number().int().positive().optional(),
  deleteMode: AgentJobSetupDeleteMode.optional(),
  /** `deleteMode: "reconciliation"` only: mass-delete guard threshold, percent of the saved key list. */
  maxDeletePercent: z.number().min(0).max(100).optional(),
  /** `deleteMode: "softDelete"` only: a boolean source column, read even when not in `mapping`. */
  softDeleteColumn: z.string().optional(),
  /**
   * Slice R4 (docs/plans/agent-canvas-integration.md B.7, item 4) — mirrors
   * apps/agent/src/config/types.ts's SyncJobEntry.onNullKey/allowEmptyReplace
   * exactly. Both additive/optional like every other field here; absent
   * means the agent's own default (onNullKey: "stop", allowEmptyReplace: false).
   */
  onNullKey: z.enum(["stop", "skip"]).optional(),
  allowEmptyReplace: z.boolean().optional(),
});
export type AgentJobSetup = z.infer<typeof AgentJobSetup>;

/**
 * Preview-publish's diff result (B.7): which top-level fields changed
 * against the currently published setup, and whether that change forces
 * a full reload — source table, filter, saved parameters, mapping,
 * watermark column, destination, or delete method (B.7's exact list).
 */
export type AgentJobSetupDiff = {
  changedFields: string[];
  forcesFullReload: boolean;
};

const FULL_RELOAD_FIELDS = new Set<string>([
  "sourceTable",
  "filter",
  "params",
  "mapping",
  "watermarkColumn",
  "destinationConnectionId",
  "deleteMode",
]);

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Pure diff — no I/O. `previous: null` means "nothing published yet" (every field counts as changed, forcing a full reload). */
export function diffAgentJobSetup(previous: AgentJobSetup | null, next: AgentJobSetup): AgentJobSetupDiff {
  if (previous === null) {
    const changedFields = Object.keys(next);
    return { changedFields, forcesFullReload: true };
  }

  const changedFields: string[] = [];
  const keys = new Set<string>([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    const prevValue = (previous as Record<string, unknown>)[key];
    const nextValue = (next as Record<string, unknown>)[key];
    if (!deepEqual(prevValue, nextValue)) changedFields.push(key);
  }

  const forcesFullReload = changedFields.some((field) => FULL_RELOAD_FIELDS.has(field));
  return { changedFields, forcesFullReload };
}
