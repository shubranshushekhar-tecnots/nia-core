'use client';

import { useEffect } from 'react';
import { railContextMenuItemStyle } from './styles';
import { getContextMenuItems, type MenuAction, type MenuPosition } from './contextMenuItems';

/**
 * Right-click / ⋯-button / keyboard context menu for canvas nodes. Source
 * and destination nodes get connection-scoped actions (Test/Refresh/Edit/
 * Delete); transform nodes only ever get "Remove from workflow" — they
 * have no connectionId to act on. Items that need a connection are omitted
 * entirely (not just disabled) when the node isn't resolved to one, since
 * there's nothing for them to do.
 */

export type { MenuAction, MenuItem, MenuPosition } from './contextMenuItems';
export { getContextMenuItems } from './contextMenuItems';

export default function NodeContextMenu({
  menu,
  onAction,
  onClose,
}: {
  menu: MenuPosition;
  onAction: (action: MenuAction, nodeId: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    // Escape closes the menu before FlowCanvas's own Escape (deselect)
    // handling — capture phase so this fires first, then stops it from
    // reaching the window-level listener FlowCanvas registers.
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  const items = getContextMenuItems(menu.graphNodeType, menu.hasConnection);

  return (
    <div
      role="menu"
      style={{
        position: 'fixed',
        top: menu.y,
        left: menu.x,
        zIndex: 50,
        minWidth: 190,
        background: 'var(--surface)',
        border: '1px solid var(--panel-line)',
        borderRadius: 8,
        boxShadow: 'var(--floating-panel-shadow)',
        padding: 4,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, i) =>
        item.kind === 'separator' ? (
          <div key={`sep-${i}`} style={{ borderTop: '1px solid var(--panel-line)', margin: '4px 0' }} />
        ) : (
          <button
            key={item.action}
            type="button"
            role="menuitem"
            style={{ ...railContextMenuItemStyle, color: item.danger ? 'var(--bad)' : 'var(--ink)' }}
            onClick={() => {
              onAction(item.action, menu.nodeId);
              onClose();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
