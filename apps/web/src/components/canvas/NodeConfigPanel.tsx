'use client';

import { useEffect, useState } from 'react';
import type { CanvasNode } from '@/lib/canvas/mapping';
import type { CheckResult, EntityRef } from '@nia/schemas';
import NodeDrawer from './NodeDrawer';
import { configPanelFadeStyle, configPanelMultiSelectStyle, configPanelShellStyle } from './styles';

/**
 * Floating panel over the canvas surface (canvasSurfaceStyle, `position:
 * relative`), replacing the old docked top band. Renders nothing at all
 * when no node is selected (selectedCount === 0) so the canvas is fully
 * unobstructed; shows a small floating multi-select pill instead when more
 * than one node is selected. NodeDrawer.tsx (header ribbon + tabs) is
 * rendered unchanged from here; all state/hooks live there untouched —
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
  upstreamSource?: { connectionId?: string; manifestId?: string; entity?: EntityRef };
  checkResults?: CheckResult[] | null;
  onConfigChange: (config: Record<string, unknown>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  if (!node) {
    if (selectedCount > 1) {
      return (
        <div data-node-config-panel data-testid="node-config-panel" style={configPanelMultiSelectStyle}>
          {selectedCount} nodes selected
        </div>
      );
    }
    return null;
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

  useEffect(() => {
    setVisible(false);
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, [nodeId]);

  return <div style={configPanelFadeStyle(visible)}>{children}</div>;
}
