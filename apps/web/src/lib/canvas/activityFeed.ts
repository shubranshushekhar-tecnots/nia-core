import type { LocalMessage } from '@/lib/chat/useChatSession';
import type { WorkflowCheckRun } from '@/lib/api/checksClient';

/**
 * Merges the canvas's check-run history and its chat thread's user questions
 * into a single newest-first feed for ChecksDock's "Logs" tab (Phase 5
 * Session 4). Chat messages are passed in rather than re-fetched — the
 * command bar's getWorkflowConversation() read already has them.
 *
 * Phase 6 will add a third `kind: 'run'` source here once workflow
 * execution's SSE-replay channel exists — same `ActivityItem` shape, just
 * another array merged in below before the final sort.
 */

export type ActivityItem = {
  time: string;
  text: string;
  kind: 'check' | 'chat';
};

export function buildActivityFeed(checkRuns: WorkflowCheckRun[], messages: LocalMessage[]): ActivityItem[] {
  const checkItems: ActivityItem[] = checkRuns.map((run) => {
    const failing = run.results.filter((r) => r.status === 'fail').length;
    const text = failing > 0 ? `Checks run — ${failing} failing` : 'Checks run — all passed';
    return { time: run.ranAt, text, kind: 'check' };
  });

  const chatItems: ActivityItem[] = messages
    .filter((m) => m.role === 'user')
    .map((m) => ({ time: m.createdAt, text: `Asked: ${m.content}`, kind: 'chat' }));

  return [...checkItems, ...chatItems].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
}
