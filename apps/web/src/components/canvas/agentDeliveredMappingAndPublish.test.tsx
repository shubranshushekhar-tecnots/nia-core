import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import type { IntrospectResponse, SourceDestConfig } from '@nia/schemas';
import { computePublishGate } from '@/lib/canvas/agentDelivery';
import type { CanvasNode } from '@/lib/canvas/mapping';
import MappingEditor from './MappingEditor';

/**
 * Slice R4 (B.7) — item 9 (a Planometry destination pre-ticks the key
 * column it reports, see MappingEditor.tsx's `planometryKeyColumn` effect)
 * and item 8 (Publish is refused until the mapping is approved, see
 * agentDelivery.ts's computePublishGate — the exact function FlowCanvas.tsx
 * wires into its Publish button, pulled out so this doesn't need to mount
 * the whole React Flow canvas to test).
 */

vi.mock('@/lib/api/connectionsClient', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/connectionsClient')>('@/lib/api/connectionsClient');
  return {
    ...actual,
    getConnectionSchema: vi.fn().mockResolvedValue({
      entities: [
        {
          namespace: 'public',
          name: 'orders',
          canRead: true,
          canWrite: true,
          primaryKey: 'id',
          fields: [
            { name: 'id', type: 'string' },
            { name: 'total', type: 'number' },
          ],
        },
      ],
    } satisfies IntrospectResponse),
  };
});

function Harness() {
  const [config, setConfig] = useState<SourceDestConfig>({
    operation: 'insert',
    entity: { namespace: 'public', name: 'orders' },
    mapping: { version: 1, entries: [{ from: 'id', to: 'id' }], approvedAt: null },
  });
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return (
    <QueryClientProvider client={queryClient}>
      <MappingEditor
        config={config}
        workflowId="wf-1"
        destNodeId="dest-1"
        destConnectionId="dest-conn-1"
        destManifestId="planometry-table"
        sourceConnectionId="src-conn-1"
        sourceManifestId="sqlserver-agent"
        onChange={(next) => setConfig(next)}
      />
    </QueryClientProvider>
  );
}

describe('agent-delivered workflow — Planometry upsert-key pre-tick', () => {
  it("pre-ticks the destination's reported key column and explains where it came from", async () => {
    render(<Harness />);

    const keyCheckbox = await screen.findByRole('checkbox', { name: 'id' });
    expect(await screen.findByText(/Planometry reports it as this table's key/i)).toBeInTheDocument();
    expect(keyCheckbox).toBeChecked();
  });
});

describe('agent-delivered workflow — Publish gate (FlowCanvas.tsx wiring)', () => {
  const agentDestNode = {
    id: 'dest-1',
    data: { graphNodeType: 'destination', manifestId: 'planometry-table', config: { mapping: { approvedAt: null } } },
  } as unknown as CanvasNode;

  it('refuses Publish while the mapping is not approved, even when everything else is valid', () => {
    const { publishEnabled, publishTooltip } = computePublishGate({
      readOnly: false,
      isAgentDelivered: true,
      derivedAgentSetup: { ok: true, setup: {} as never },
      agentDestNode,
    });

    expect(publishEnabled).toBe(false);
    expect(publishTooltip).toBe('Approve the field mapping before publishing.');
  });

  it('allows Publish once the mapping is approved', () => {
    const approvedDestNode = {
      ...agentDestNode,
      data: { ...agentDestNode.data, config: { mapping: { approvedAt: '2026-01-01T00:00:00.000Z' } } },
    } as unknown as CanvasNode;

    const { publishEnabled, publishTooltip } = computePublishGate({
      readOnly: false,
      isAgentDelivered: true,
      derivedAgentSetup: { ok: true, setup: {} as never },
      agentDestNode: approvedDestNode,
    });

    expect(publishEnabled).toBe(true);
    expect(publishTooltip).toBe('Ready to publish.');
  });
});
