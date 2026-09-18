'use client';

import { useState } from 'react';
import type { Connection } from '@/lib/connections/types';
import type { LocalMessage } from '@/lib/chat/useChatSession';
import CommandBar from './CommandBar';
import {
  copilotChatAreaStyle,
  copilotCollapsedLogoStyle,
  copilotCollapsedRailStyle,
  copilotComingSoonBadgeStyle,
  copilotHeaderLogoStyle,
  copilotHeaderStyle,
  copilotMockSectionStyle,
  copilotShellStyle,
  copilotSubtitleStyle,
  copilotTitleStyle,
  copilotToggleBtnStyle,
} from './styles';

/**
 * Docked 344px right-panel shell (Task 2, decision 1). Owns the panel chrome
 * only — logo/title, coming-soon badge, collapse/expand toggle, and a single
 * -line mock "suggestions" caption (Phase 7 plan/ghost-preview surface; not
 * built this pass, per the scope override — no PlanSchema, no apply path,
 * nothing here calls an API or streams). The actual chat surface below is
 * the existing, still-fully-live CommandBar — unchanged behavior, just
 * restyled to fill this shell (see CommandBar.tsx's own header comment).
 */

export default function CopilotSidebar({
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
  const [open, setOpen] = useState(true);

  if (!open) {
    return (
      <div style={copilotCollapsedRailStyle} data-testid="copilot-sidebar">
        <img src="/splash-icon.png" alt="Nia Copilot" style={copilotCollapsedLogoStyle} />
        <button
          type="button"
          style={copilotToggleBtnStyle}
          onClick={() => setOpen(true)}
          aria-label="Open Copilot"
          title="Open Copilot"
        >
          {'\u2039'}
        </button>
      </div>
    );
  }

  return (
    <div style={copilotShellStyle(true)} data-testid="copilot-sidebar">
      <div style={copilotHeaderStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src="/splash-icon.png" alt="Nia AI" style={copilotHeaderLogoStyle} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span style={copilotTitleStyle}>Nia AI</span>
            <span style={copilotSubtitleStyle}>Copilot</span>
          </div>
          <span style={copilotComingSoonBadgeStyle}>Coming soon</span>
        </div>
        <button
          type="button"
          style={copilotToggleBtnStyle}
          onClick={() => setOpen(false)}
          aria-label="Collapse Copilot"
          title="Collapse Copilot"
        >
          {'\u203a'}
        </button>
      </div>

      <div style={copilotMockSectionStyle}>
        Ask Nia AI to draft a workflow change and preview it here before applying — arriving in Phase 7.
      </div>

      <div style={copilotChatAreaStyle}>
        <CommandBar
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
