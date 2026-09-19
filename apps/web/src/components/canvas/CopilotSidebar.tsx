'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Connection } from '@/lib/connections/types';
import type { LocalMessage } from '@/lib/chat/useChatSession';
import Logo from '@/components/Logo';
import CommandBar from './CommandBar';
import {
  COPILOT_WIDTH_DEFAULT,
  COPILOT_WIDTH_MAX,
  COPILOT_WIDTH_MIN,
  copilotChatAreaStyle,
  copilotHeaderStyle,
  copilotShellStyle,
  copilotSubtitleStyle,
  copilotTitleStyle,
  copilotToggleBtnStyle,
  dragHandleStyle,
} from './styles';
import { ChevronRightIcon } from './navIcons';

/**
 * Docked 344px right-panel shell (Task 2, decision 1). Owns the panel chrome
 * only — logo/title, collapse/expand toggle. The actual chat + Copilot
 * plan-propose surface below is CommandBar, which is live end-to-end as of
 * Phase 7 Session 3 (see its own header comment) — the "Coming soon" badge
 * and mock suggestions caption this shell used to show are gone.
 */

export default function CopilotSidebar({
  open,
  onToggle,
  workflowId,
  connections,
  wiredConnectionIds,
  selectedConnectionId,
  messages,
  streamStage,
  sending,
  transportError,
  send,
  retry,
  resetConversation,
}: {
  open: boolean;
  onToggle: () => void;
  workflowId: string;
  connections: Connection[];
  wiredConnectionIds: string[];
  selectedConnectionId: string | null;
  messages: LocalMessage[];
  streamStage: string | null;
  sending: boolean;
  transportError: boolean;
  send: (connectionIds: string[], message: string) => Promise<void>;
  retry: () => void;
  resetConversation: () => void;
}) {
  const [width, setWidth] = useState(COPILOT_WIDTH_DEFAULT);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      // Panel is right-anchored — dragging left (negative deltaX) grows it.
      // Also cap against the viewport (leave at least 320px for the canvas
      // itself) so COPILOT_WIDTH_MAX doesn't overflow on narrower screens.
      const viewportCap = Math.max(COPILOT_WIDTH_MIN, window.innerWidth - 320);
      const max = Math.min(COPILOT_WIDTH_MAX, viewportCap);
      const next = Math.min(max, Math.max(COPILOT_WIDTH_MIN, drag.startWidth + (drag.startX - e.clientX)));
      setWidth(next);
    }
    function onUp() {
      if (dragRef.current) {
        dragRef.current = null;
        setDragging(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  function handleDragPointerDown(e: ReactPointerEvent) {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: width };
    setDragging(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  // Collapsed = zero width, no visible chrome — copilotShellStyle already
  // handles that natively. The sole reopen affordance is the Logo toggle in
  // CanvasHeader.tsx / FlowCanvas.tsx's full-view controls, not a dedicated
  // rail here, so there's no duplicate brand mark sitting on the canvas.
  if (!open) {
    return <div style={copilotShellStyle(false, width)} data-testid="copilot-sidebar" />;
  }

  return (
    <div style={copilotShellStyle(true, width)} data-testid="copilot-sidebar">
      <div
        style={dragHandleStyle('vertical', dragging)}
        onPointerDown={handleDragPointerDown}
        data-testid="copilot-sidebar-drag-handle"
      />
      <div style={copilotHeaderStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Logo size={22} showWordmark={false} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span style={copilotTitleStyle}>Nia AI</span>
            <span style={copilotSubtitleStyle}>Ask anything about your workflow</span>
          </div>
        </div>
        <button
          type="button"
          style={copilotToggleBtnStyle}
          onClick={onToggle}
          aria-label="Collapse Copilot"
          title="Collapse Copilot"
        >
          <ChevronRightIcon size={14} />
        </button>
      </div>

      <div style={copilotChatAreaStyle}>
        <CommandBar
          workflowId={workflowId}
          connections={connections}
          wiredConnectionIds={wiredConnectionIds}
          selectedConnectionId={selectedConnectionId}
          messages={messages}
          streamStage={streamStage}
          sending={sending}
          transportError={transportError}
          send={send}
          retry={retry}
          resetConversation={resetConversation}
        />
      </div>
    </div>
  );
}
