'use client';

import { useEffect, useRef, useState } from 'react';
import type { CanvasNode } from '@/lib/canvas/mapping';
import type { CheckResult } from '@nia/schemas';
import NodeDrawer from './NodeDrawer';
import { configPanelEmptyStyle, configPanelFadeStyle, configPanelShellStyle } from './styles';

/**
 * Docked top band, replacing the old node-anchored NodePopover.tsx. Always
 * mounted with a fixed height (styles.ts's CONFIG_PANEL_HEIGHT) — selecting
 * a node never resizes this panel or the canvas surface beside it, it only
 * swaps this panel's internal content. NodeDrawer.tsx (ribbon + detail rows)
 * is rendered unchanged from here; all state/hooks live there untouched —
 * this component owns layout/empty/multi-select states only.
 *
 * `data-node-config-panel` marks the root so FlowCanvas.tsx's Escape
 * listener can tell whether focus is inside this panel (e.g. a <select>)
 * before deciding whether to also deselect the canvas node.
 */
export default function NodeConfigPanel({
  node,
  selectedCount,
  workflowId,
  upstreamSource,
  checkResults,
  onConfigChange,
  onDelete,
  onClose,
}: {
  node: CanvasNode | undefined;
  selectedCount: number;
  workflowId: string;
  upstreamSource?: { connectionId?: string; manifestId?: string };
  checkResults?: CheckResult[] | null;
  onConfigChange: (config: Record<string, unknown>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  if (!node) {
    return (
      <div data-node-config-panel data-testid="node-config-panel" style={configPanelShellStyle}>
        <div style={configPanelEmptyStyle}>
          {selectedCount > 1 ? `${selectedCount} nodes selected` : 'Select a node to configure it'}
        </div>
      </div>
    );
  }

  return (
    <div data-node-config-panel data-testid="node-config-panel" style={configPanelShellStyle}>
      <FadeSwap nodeId={node.id}>
        <NodeDrawer
          node={node}
          workflowId={workflowId}
          upstreamSource={upstreamSource}
          checkResults={checkResults}
          onConfigChange={onConfigChange}
          onDelete={onDelete}
          onClose={onClose}
        />
      </FadeSwap>
    </div>
  );
}

/**
 * Crossfades content on `nodeId` change only (opacity, 160ms ease-out —
 * see styles.ts's configPanelFadeStyle) — never re-animates on config
 * edits/keystrokes within the same node, since those don't change `nodeId`
 * and therefore don't re-trigger the mount effect below.
 * `prefers-reduced-motion` already disables all transitions globally
 * (theme.css), so no extra handling is needed here for that case.
 */
function FadeSwap({ nodeId, children }: { nodeId: string; children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  const prevNodeId = useRef<string | null>(null);

  useEffect(() => {
    if (prevNodeId.current === nodeId) return;
    prevNodeId.current = nodeId;
    setVisible(false);
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, [nodeId]);

  return <div style={configPanelFadeStyle(visible)}>{children}</div>;
}
