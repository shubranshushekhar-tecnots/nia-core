import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AgentJobPanel from './AgentJobPanel';
import { listAgentSetupRuns } from '@/lib/api/agentSetupClient';

/**
 * fix/workflow-checks-logs — by the time the platform learns about an
 * errorClass of "transient", the agent has already exhausted its own
 * in-process retry backoff (jobScheduler.ts only reports the outcome once
 * the 1/5/15 min backoff is spent). "the agent will retry" was shown
 * unconditionally, which is false for a job with no next scheduled run
 * (e.g. an unscheduled, run-on-demand job — exactly this bug report's
 * case). This protects the fix: the message must depend on nextRunAt.
 */

vi.mock('@/lib/api/agentSetupClient', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/agentSetupClient')>('@/lib/api/agentSetupClient');
  return {
    ...actual,
    listAgentSetupRuns: vi.fn().mockResolvedValue([]),
  };
});

function renderPanel(jobState: Parameters<typeof AgentJobPanel>[0]['jobState']) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentJobPanel workflowId="wf-1" jobState={jobState} readOnly onActionDone={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('AgentJobPanel — transient error messaging', () => {
  beforeEach(() => {
    vi.mocked(listAgentSetupRuns).mockClear();
  });

  afterEach(cleanup);

  it('does not claim an automatic retry when no next run is scheduled', () => {
    renderPanel({
      state: 'failing',
      errorClass: 'transient',
      lastRunAt: '2026-10-09T08:01:25.557Z',
      nextRunAt: null,
    });

    expect(screen.getByText(/run it again when ready, no automatic retry is scheduled/i)).toBeInTheDocument();
    expect(screen.queryByText(/the agent will retry/i)).not.toBeInTheDocument();
  });

  it('says the agent will retry when a next run is actually scheduled', () => {
    renderPanel({
      state: 'failing',
      errorClass: 'transient',
      lastRunAt: '2026-10-09T08:01:25.557Z',
      nextRunAt: '2026-10-09T09:00:00.000Z',
    });

    expect(screen.getByText(/the agent will retry/i)).toBeInTheDocument();
  });
});
