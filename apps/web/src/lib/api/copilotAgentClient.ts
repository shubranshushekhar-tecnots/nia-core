/**
 * Browser-side calls for the Copilot agent loop (docs/plans/copilot-agent.md,
 * Part 4) — apps/api's POST /copilot-agent and its confirm endpoint. Same
 * auth mode as chatClient.ts: copilotAgentRouter is cookie-authed
 * (requireCookieAuth), so these hit the same-origin `/api/backend/:path*`
 * rewrite with no manual Authorization header, unlike copilotClient.ts's
 * Bearer-only propose/apply routes.
 *
 * Deliberately stateless on this side too, mirroring the route: the caller
 * (CommandBar.tsx) keeps the full { role, content } history itself and
 * resends it every turn.
 */

export class CopilotAgentApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'CopilotAgentApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type AgentChatMessage = { role: 'user' | 'assistant'; content: string };

/** Structural hint the API carries per tool call — see copilot/types.ts's ToolRender. */
export type AgentToolRender = { kind: string; payload: unknown };

export type AgentToolCallLog = { name: string; summary: string; render: AgentToolRender };

export type AgentTurnResult = { reply: string; toolCalls: AgentToolCallLog[] };

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    throw new CopilotAgentApiError(
      res.status,
      errBody?.error?.code ?? 'UNKNOWN',
      errBody?.error?.message ?? res.statusText,
      errBody?.error?.details,
    );
  }
  return res.json() as Promise<T>;
}

/** POST /copilot-agent — one agent turn, given the whole message history so far. */
export async function runAgentTurn(messages: AgentChatMessage[]): Promise<AgentTurnResult> {
  return postJson('/api/backend/copilot-agent', { messages });
}

/**
 * Part 3's one confirmation entry point — POST
 * /copilot-agent/pending-actions/:id/confirm. Only ever called from a real
 * click in this session; the result is the same { summary, render } shape a
 * tool call gets in AgentTurnResult.toolCalls, so the caller can render it
 * identically (e.g. start_run's confirmed card flips from
 * "run_confirmation" to "runs_started").
 */
export async function confirmPendingAction(id: string): Promise<{ summary: string; render: AgentToolRender }> {
  return postJson(`/api/backend/copilot-agent/pending-actions/${id}/confirm`, {});
}
