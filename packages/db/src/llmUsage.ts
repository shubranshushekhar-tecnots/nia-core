import type pg from "pg";
import { withServiceRole } from "./client.js";
import type { WorkspaceScope } from "./workspaceScope.js";

/**
 * Console v2 token usage ledger (supabase/migrations/0068_llm_usage.sql).
 * Shared by apps/worker's gatewayClient.ts and apps/api's copilot
 * gatewayClient.ts — both already depend on @nia/db, so this adds no new
 * dependency to either app. Lives here (not in either app) specifically so
 * neither app's gatewayClient.ts has to import the other's code.
 */

export type LlmUsageStatus = "ok" | "error" | "aborted";

export interface LlmUsageTokens {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
}

export interface LlmUsageRecord {
  scope: WorkspaceScope;
  /** The specific acting user, where one exists (e.g. who triggered a copilot turn or a mapping/cleaning proposal) — distinct from scope's ownerId, and omitted where no single user triggered the call. */
  userId?: string;
  workflowId?: string;
  /** Either a workflow_runs.id or a chat pipeline's jobId — see llm_usage.run_id's column comment in the migration for why this is never a foreign key. */
  runId?: string;
  feature: string;
  model: string;
  latencyMs: number;
  status: LlmUsageStatus;
  /** Omitted (undefined) whenever the gateway never reported a token count — e.g. an aborted/cut-off stream — which stores usage_known=false with null token columns, per the migration's check constraint. */
  usage?: LlmUsageTokens;
  errorCode?: string;
}

/**
 * Appends one row to llm_usage. Never throws: a recording failure must
 * never break the underlying LLM call, per docs/plans/console-plan.md — any
 * error here is logged and swallowed, exactly like a dropped analytics
 * event.
 */
export async function recordLlmUsage(pool: pg.Pool, record: LlmUsageRecord): Promise<void> {
  try {
    await withServiceRole(pool, async (db) => {
      await db.query(
        `insert into public.llm_usage
           (org_id, owner_user_id, user_id, workflow_id, run_id, feature, model,
            input_tokens, output_tokens, cached_tokens, total_tokens,
            latency_ms, status, usage_known, error_code)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          "orgId" in record.scope ? record.scope.orgId : null,
          "ownerId" in record.scope ? record.scope.ownerId : null,
          record.userId ?? null,
          record.workflowId ?? null,
          record.runId ?? null,
          record.feature,
          record.model,
          record.usage?.inputTokens ?? null,
          record.usage?.outputTokens ?? null,
          record.usage?.cachedTokens ?? null,
          record.usage?.totalTokens ?? null,
          record.latencyMs,
          record.status,
          record.usage !== undefined,
          record.errorCode ?? null,
        ],
      );
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("recordLlmUsage: failed to write llm_usage row (swallowed, never breaks the LLM call)", err);
  }
}
