/**
 * docs/plans/agent-canvas-integration.md B.3/B.5: check-in is a long poll —
 * it holds the HTTP response open for up to a bounded window, then returns
 * whatever tasks (if any) became available during the hold. Slice 1 has no
 * agent_tasks table yet (that lands in a later slice), so the only
 * implementation today is "hold, then return empty" — but the interface
 * exists now so the bridge's route handler never needs to change shape when
 * real task delivery is added.
 */
export interface AgentTransport {
  waitForTasks(agentId: string, timeoutMs: number): Promise<unknown[]>;
}

/** Injectable so tests never have to wait out a real multi-second hold. */
export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class LongPollTransport implements AgentTransport {
  constructor(private readonly sleep: Sleep = defaultSleep) {}

  async waitForTasks(_agentId: string, timeoutMs: number): Promise<unknown[]> {
    await this.sleep(timeoutMs);
    return [];
  }
}
