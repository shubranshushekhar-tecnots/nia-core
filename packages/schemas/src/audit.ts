import { z } from "zod";

/**
 * The execution-audit chokepoint contract. Every path that runs a query
 * against a connection's credential — /test today, /execute (worker
 * dispatch) and /introspect later — must emit exactly this shape, via the
 * matching logExecutionAudit() helper (apps/api/src/lib/executionAudit.ts,
 * and its worker-side equivalent once the worker has a real dispatch call
 * site). No ad-hoc `audit_log` inserts for executions; this is the only
 * sanctioned shape, enforced by there being no other callable insert path
 * (see 0009_connector_write_paths.sql's log_execution_audit RPC).
 *
 * This is the record that Mira ran a query through Shub's credential — the
 * customer's DB will only ever show Shub. connectionOwnerUserId and
 * actorUserId are deliberately both required and distinct fields, not one
 * field a caller could conflate.
 */
export const ExecutionAuditInput = z.object({
  connectionId: z.string().uuid(),
  /** Whose credential actually ran the query (connections.owner_user_id). */
  connectionOwnerUserId: z.string().uuid(),
  connectorId: z.string(),
  /** The connection's handle, e.g. "@mysql-sales" — not an operation label. */
  handle: z.string(),
  operation: z.string(),
  /** The executed query, verbatim. */
  query: z.string(),
  /**
   * Who triggered this execution. From apps/api: the authenticated caller
   * (req.actor.userId). From the worker: ChatQueryJob.userId /
   * EtlRunJob.triggeredByUserId / CheckRunJob.triggeredByUserId — never
   * inferred, always carried explicitly through the job payload.
   */
  actorUserId: z.string().uuid(),
});
export type ExecutionAuditInput = z.infer<typeof ExecutionAuditInput>;

/** The single audit_log.action value every execution-audit row is written under. */
export const EXECUTION_AUDIT_ACTION = "connection.execute" as const;
