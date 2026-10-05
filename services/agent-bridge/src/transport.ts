import type pg from "pg";
import { withServiceRole } from "@nia/db";
import { taskBus } from "./taskBus.js";

/**
 * docs/plans/agent-canvas-integration.md B.3/B.5: check-in is a long poll —
 * it holds the HTTP response open for up to a bounded window, then returns
 * whatever tasks (if any) became available during the hold.
 *
 * Slice C1 replaces the original "hold, then return empty" stub
 * (LongPollTransport below, kept only for tests that don't need a real DB)
 * with a real DB-backed implementation: `pending` agent_tasks rows for this
 * agent are delivered immediately if any already exist; otherwise the call
 * waits on taskBus's per-agent wake event (fired the instant a new task is
 * inserted — see app.ts's internal-listener task-creation path) raced
 * against the remaining hold time, then does one final re-check before
 * giving up and returning an empty list.
 */
export interface AgentTask {
  id: string;
  kind: "test_connection" | "list_tables" | "run_now" | "pause" | "resume" | "test_job";
  // Exactly one of connectionId/agentSetupId is set, matching
  // 0074_agent_setup_actions.sql's agent_tasks_connection_xor_setup check —
  // test_connection/list_tables carry connectionId, the Slice R5a action
  // kinds carry agentSetupId.
  connectionId: string | null;
  agentSetupId: string | null;
  payload: Record<string, unknown>;
}

export interface AgentTransport {
  waitForTasks(agentId: string, timeoutMs: number): Promise<AgentTask[]>;
}

type PendingTaskRow = {
  id: string;
  kind: AgentTask["kind"];
  connection_id: string | null;
  agent_setup_id: string | null;
  payload: Record<string, unknown>;
  local_connection_id: string | null;
};

export class DbAgentTransport implements AgentTransport {
  constructor(private readonly pool: pg.Pool) {}

  private async claimPending(agentId: string): Promise<AgentTask[]> {
    // The task's own connection row already carries which of the agent's
    // locally-reported connections it targets (config.agentConnectionId) —
    // resolved and validated once at task-creation time by the internal
    // listener (plan point 3). No need to re-derive/re-validate liveness
    // against agent_reported_connections here; this is purely "what do I
    // tell the agent to run this against".
    const { rows } = await withServiceRole(this.pool, (db) =>
      db.query<PendingTaskRow>(
        `update public.agent_tasks t
           set status = 'delivered', delivered_at = now()
         where t.id in (
           select id from public.agent_tasks
           where agent_id = $1 and status = 'pending' and expires_at > now()
           order by created_at
         )
         returning t.id, t.kind,
           t.connection_id,
           t.agent_setup_id,
           t.payload,
           (select conn.config->>'agentConnectionId' from public.connections conn
            where conn.id = t.connection_id) as local_connection_id`,
        [agentId],
      ),
    );
    return rows.map((row) => {
      if (row.kind === "test_connection" || row.kind === "list_tables") {
        return {
          id: row.id,
          kind: row.kind,
          connectionId: row.connection_id,
          agentSetupId: null,
          payload: { localConnectionId: row.local_connection_id },
        };
      }
      // Slice R5a — run_now/pause/resume/test_job: payload is whatever
      // create_agent_setup_action_task stored (always {} for pause/resume/
      // test_job; run_now's own params/fullReload/allowMassDelete).
      return {
        id: row.id,
        kind: row.kind,
        connectionId: null,
        agentSetupId: row.agent_setup_id,
        payload: row.payload ?? {},
      };
    });
  }

  async waitForTasks(agentId: string, timeoutMs: number): Promise<AgentTask[]> {
    const immediate = await this.claimPending(agentId);
    if (immediate.length > 0) return immediate;
    if (timeoutMs <= 0) return [];

    await taskBus.waitForWake(agentId, timeoutMs);
    return this.claimPending(agentId);
  }
}

/** Injectable so tests never have to wait out a real multi-second hold. */
export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Kept for any test that still wants a no-DB "hold, then empty" stub. */
export class LongPollTransport implements AgentTransport {
  constructor(private readonly sleep: Sleep = defaultSleep) {}

  async waitForTasks(_agentId: string, timeoutMs: number): Promise<AgentTask[]> {
    await this.sleep(timeoutMs);
    return [];
  }
}
