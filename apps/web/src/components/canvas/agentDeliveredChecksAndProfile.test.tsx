import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { CheckResult } from '@nia/schemas';
import ChecksDock from './ChecksDock';
import type { CanvasNode } from '@/lib/canvas/mapping';

/**
 * Slice R4 (B.7) — item 1 (Run checks disabled, stale results hidden on an
 * agent-delivered workflow) and item 2 (local-database Profile tab shows a
 * plain message instead of calling the profiler, which would otherwise
 * worker-timeout with "no supported query dialect"). See ChecksDock.tsx's
 * and NodeDrawer.tsx's own doc comments at the `agentDelivered` prop /
 * `isAgentSourceManifest` branch for the full rationale.
 */

const profileTabSpy = vi.fn();
vi.mock('./ProfileTab', () => ({
  default: (props: unknown) => {
    profileTabSpy(props);
    return null;
  },
}));

vi.mock('@/lib/api/connectionsClient', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/connectionsClient')>('@/lib/api/connectionsClient');
  return {
    ...actual,
    getConnectionSchema: vi.fn().mockResolvedValue({
      entities: [{ namespace: 'public', name: 'orders', canRead: true, canWrite: false, fields: [{ name: 'id', type: 'integer' }] }],
    }),
    getWriteGrants: vi.fn().mockResolvedValue([]),
  };
});

// Imported after the mocks above so NodeDrawer picks up the mocked modules.
const { default: NodeDrawer } = await import('./NodeDrawer');

function renderWithQueryClient(children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>);
}

describe('agent-delivered workflow — Run checks dock', () => {
  it('disables manual checks with an explanation and never shows a stale/false result', () => {
    const staleFailingResults: CheckResult[] = [{ id: 'grants', status: 'fail', message: 'Missing write grant' }];

    render(
      <ChecksDock
        running={false}
        error={null}
        results={staleFailingResults}
        ranAt="2026-01-01T00:00:00.000Z"
        stale={false}
        nodeCount={2}
        edgeCount={1}
        expanded
        onToggleExpanded={() => {}}
        onSelectNode={() => {}}
        activeTab="checks"
        onTabChange={() => {}}
        logs={[]}
        agentDelivered
      />,
    );

    expect(screen.getByText(/manual checks are disabled here/i)).toBeInTheDocument();
    expect(screen.getByText(/Checked at publish, and by the agent/i)).toBeInTheDocument();
    expect(screen.queryByText(/Missing write grant/i)).not.toBeInTheDocument();
  });
});

describe('agent-delivered workflow — Profile tab on a local-database source', () => {
  it('shows a plain message instead of calling the profiler', async () => {
    const node = {
      id: 'src-1',
      type: 'source',
      position: { x: 0, y: 0 },
      data: {
        graphNodeType: 'source',
        connectionId: 'conn-1',
        manifestId: 'sqlserver-agent',
        config: { operation: 'read', entity: { namespace: 'public', name: 'orders' } },
        resolved: true,
        manifestName: 'Local database (via agent)',
      },
    } as unknown as CanvasNode;

    renderWithQueryClient(
      <NodeDrawer node={node} role="owner" workflowId="wf-1" onConfigChange={() => {}} onDelete={() => {}} onClose={() => {}} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Profile' }));

    expect(await screen.findByText(/Column profiling is not available yet for local databases\./i)).toBeInTheDocument();
    expect(profileTabSpy).not.toHaveBeenCalled();
  });
});
