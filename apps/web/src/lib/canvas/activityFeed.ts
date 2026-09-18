import type { LocalMessage } from '@/lib/chat/useChatSession';
import type { WorkflowCheckRun } from '@/lib/api/checksClient';

/**
 * Merges the canvas's check-run history, its chat thread's user questions,
 * and (Block 3.5 item 4) the live run stream's own events into a single
 * newest-first feed for ChecksDock's "Logs" tab. Chat messages are passed
 * in rather than re-fetched — the command bar's getWorkflowConversation()
 * read already has them.
 *
 * `runItems` are built by the caller (FlowCanvas.tsx) directly from the
 * same SSE events it already consumes to drive the run-status panel — this
 * intentionally reuses the existing replay channel rather than adding a
 * separate "list past runs" read; there's no such endpoint yet, and this
 * block's scope is the current run session's own start/progress/terminal
 * events, not full historical run listing.
 */

export type ActivityItem = {
  time: string;
  text: string;
  kind: 'check' | 'chat' | 'run';
};

export function buildActivityFeed(
  checkRuns: WorkflowCheckRun[],
  messages: LocalMessage[],
  runItems: ActivityItem[] = [],
): ActivityItem[] {
  const checkItems: ActivityItem[] = checkRuns.map((run) => {
    const failing = run.results.filter((r) => r.status === 'fail').length;
    const text = failing > 0 ? `Checks run — ${failing} failing` : 'Checks run — all passed';
    return { time: run.ranAt, text, kind: 'check' };
  });

  const chatItems: ActivityItem[] = messages
    .filter((m) => m.role === 'user')
    .map((m) => ({ time: m.createdAt, text: `Asked: ${m.content}`, kind: 'chat' }));

  return [...checkItems, ...chatItems, ...runItems].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
}
