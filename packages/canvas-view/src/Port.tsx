'use client';

import { Handle, useConnection, useNodeConnections, type HandleType, type Position } from '@xyflow/react';

// Presentational wrapper around React Flow's <Handle>, used only by
// GraphFlowNode.tsx (apps/web) / ReadOnlyGraphNode.tsx (this package).
// Implements the 4 port states from the redesign brief:
//  - open: no edge attached, no drag in progress
//  - connected: this handle already has >=1 edge
//  - valid: a connection is being dragged from elsewhere and this handle is
//    a legal drop target for it (per React Flow's own isValidConnection)
//  - invalid: a connection is being dragged and this handle is NOT a legal
//    drop target
// "valid"/"invalid" only apply to the handle the pointer is over — every
// other idle handle stays "open"/"connected" during a drag, matching how
// React Flow itself reports isValid (null unless hovering a handle).
type PortState = 'open' | 'connected' | 'valid' | 'invalid';

const PORT_STYLE: Record<PortState, { background: string; border: string }> = {
  open: { background: 'var(--nx-bg)', border: 'var(--nx-ink-2)' },
  connected: { background: 'var(--nx-ink-2)', border: 'var(--nx-ink-2)' },
  valid: { background: 'var(--nx-blue-panel)', border: 'var(--nx-blue-panel)' },
  invalid: { background: 'var(--nx-danger)', border: 'var(--nx-danger)' },
};

export function Port({ type, position, handleId }: { type: HandleType; position: Position; handleId?: string }) {
  const connections = useNodeConnections({ handleType: type, handleId });
  const connection = useConnection();

  let state: PortState = connections.length > 0 ? 'connected' : 'open';
  if (connection.inProgress && connection.toHandle?.type === type && connection.toHandle.id === (handleId ?? null)) {
    state = connection.isValid ? 'valid' : 'invalid';
  }

  const { background, border } = PORT_STYLE[state];

  return (
    <Handle
      type={type}
      position={position}
      id={handleId}
      // data-port-state drives the "open" hover recolour (border only, no
      // fill change) via the .nx-port-open:hover rule in theme.css — a
      // pure-CSS pseudo-class can't be expressed through the inline style
      // object below, so this state needs to reach the DOM node too.
      data-port-state={state}
      className={state === 'open' ? 'nx-port-open' : undefined}
      style={{
        width: 12,
        height: 12,
        background,
        border: `1.5px solid ${border}`,
        borderRadius: 'var(--nx-radius)',
      }}
    />
  );
}
