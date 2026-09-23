import type { GraphNodeType } from '@nia/schemas';

export type MenuAction =
  | 'test-connection'
  | 'refresh'
  | 'edit-connection'
  | 'remove-node'
  | 'delete-connection';

export type MenuItem =
  | { kind: 'action'; action: MenuAction; label: string; danger?: boolean }
  | { kind: 'separator' };

/**
 * Pure function, unit-testable without rendering (this repo has no RTL —
 * see mapping.test.ts's convention). `hasConnection` is true when the node
 * resolved to a real connectionId (data.resolved && data.connectionId set).
 * Kept in its own plain .ts module (not NodeContextMenu.tsx) so it can be
 * imported by vitest without pulling in JSX.
 */
export function getContextMenuItems(graphNodeType: GraphNodeType, hasConnection: boolean): MenuItem[] {
  if (graphNodeType === 'transform') {
    return [{ kind: 'action', action: 'remove-node', label: 'Remove from workflow' }];
  }

  const items: MenuItem[] = [];
  if (hasConnection) {
    items.push(
      { kind: 'action', action: 'test-connection', label: 'Test connection' },
      { kind: 'action', action: 'refresh', label: 'Refresh' },
      { kind: 'action', action: 'edit-connection', label: 'Edit connection' },
    );
  }
  items.push({ kind: 'action', action: 'remove-node', label: 'Remove from workflow' });
  if (hasConnection) {
    items.push({ kind: 'separator' }, { kind: 'action', action: 'delete-connection', label: 'Delete connection\u2026', danger: true });
  }
  return items;
}

export type MenuPosition = { x: number; y: number; nodeId: string; graphNodeType: GraphNodeType; hasConnection: boolean };
