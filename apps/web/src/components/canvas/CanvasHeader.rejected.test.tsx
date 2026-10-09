import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import CanvasHeader from './CanvasHeader';
import type { WorkflowStatus } from '@/lib/dashboard/types';

afterEach(cleanup);

/**
 * fix/workflow-checks-logs — the "Rejected" badge previously only
 * surfaced the agent's rejection reason in a hover title attribute
 * (invisible until a user thinks to hover the tiny badge). This protects
 * the fix: the reason must also render as visible text next to the badge.
 */

const baseProps = {
  orgName: 'Acme',
  projectName: 'Project',
  projectHref: '/app/projects/p1',
  workflowName: 'test workflow 1',
  workflowStatus: 'draft' as WorkflowStatus,
  saveState: 'saved' as const,
  onReloadAfterConflict: vi.fn(),
  checksRunning: false,
  onRunChecks: vi.fn(),
  agentDelivered: true,
  runEnabled: false,
  runInFlight: false,
  runTooltip: '',
  onRun: vi.fn(),
  copilotOpen: false,
  onToggleCopilot: vi.fn(),
  readOnly: false,
};

describe('CanvasHeader — agent publish "Rejected" state', () => {
  it('shows the rejection reason inline, not just on hover', () => {
    render(
      <CanvasHeader
        {...baseProps}
        agentPublish={{
          state: 'rejected',
          wantedVersion: 2,
          appliedVersion: 1,
          rejectionReason: 'destination host "dev-api.planometry.com" is not on the local allow-list',
          publishEnabled: false,
          publishTooltip: '',
          publishing: false,
          unpublishing: false,
          onPublish: vi.fn(),
          onUnpublish: vi.fn(),
        }}
      />,
    );

    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText('destination host "dev-api.planometry.com" is not on the local allow-list')).toBeInTheDocument();
  });

  it('renders no inline reason text when not rejected', () => {
    render(
      <CanvasHeader
        {...baseProps}
        agentPublish={{
          state: 'applied',
          wantedVersion: 1,
          appliedVersion: 1,
          rejectionReason: null,
          publishEnabled: false,
          publishTooltip: '',
          publishing: false,
          unpublishing: false,
          onPublish: vi.fn(),
          onUnpublish: vi.fn(),
        }}
      />,
    );

    expect(screen.queryByText('Rejected')).not.toBeInTheDocument();
  });
});
