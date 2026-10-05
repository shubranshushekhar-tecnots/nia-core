'use client';

import { useActionState, useRef, useState, type CSSProperties } from 'react';
import { pairAgentAction, type AgentActionState } from '@/lib/agents/actions';
import { useModalA11y } from '@/lib/a11y/useModalDialog';
import {
  nxModalBodyStyle,
  nxModalCancelCellStyle,
  nxModalCardStyle,
  nxModalErrorStyle,
  nxModalFieldStyle,
  nxModalFooterStyle,
  nxModalLabelStyle,
  nxModalOverlayStyle,
  nxModalPrimaryCellStyle,
  nxModalTitleStyle,
} from '@/components/app/styles';
import {
  nxAgentsCommandChipStyle,
  nxAgentsCommandRowStyle,
  nxAgentsCopyBtnStyle,
  nxAgentsCopyFallbackStyle,
  nxAgentsCreatedBodyStyle,
  nxAgentsCreatedCardStyle,
  nxAgentsCreatedHeadingStyle,
  nxAgentsExpiryStyle,
} from './styles';

const initialState: AgentActionState = null;

// docs/plans/agent-canvas-integration.md Slice L3's "Add agent" flow — name
// first, then the full pairing command shown exactly once (mirrors
// InvitesClient.tsx's reveal-once pattern; see that file for the handleCopy
// precedent this copies). Unlike AddConnectionDialog, this does NOT close
// itself on `state?.success` — it has to stay mounted to show the command.
// Closing the dialog (Cancel/overlay/Esc) discards all local state,
// including `state.code`, for good — nothing here persists it anywhere.
export default function AddAgentDialog({ onClose }: { onClose: () => void }) {
  const [state, formAction, pending] = useActionState(pairAgentAction, initialState);
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState(false);
  const commandRef = useRef<HTMLSpanElement>(null);

  const platformUrl = typeof window !== 'undefined' ? window.location.origin : '';
  const command = state?.success && state.code ? `nia-agent pair --code ${state.code} --url ${platformUrl}` : '';

  async function handleCopy() {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        return;
      } catch {
        // Fall through to the selection fallback below.
      }
    }
    if (commandRef.current) {
      const range = document.createRange();
      range.selectNodeContents(commandRef.current);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    setCopyFallback(true);
    setTimeout(() => setCopyFallback(false), 2000);
  }

  return (
    <div style={nxModalOverlayStyle} onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add agent"
        tabIndex={-1}
        style={{ ...nxModalCardStyle, outline: 'none' }}
        onClick={(e) => e.stopPropagation()}
      >
        <form action={formAction} style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={nxModalBodyStyle}>
            <span style={nxModalTitleStyle}>Add agent</span>

            {!state?.success && (
              <>
                <label htmlFor="agent-name" style={nxModalLabelStyle}>Name</label>
                <input
                  id="agent-name"
                  name="name"
                  type="text"
                  placeholder="e.g. laptop-etl"
                  autoFocus
                  className="nx-modal-field"
                  style={nxModalFieldStyle(Boolean(state?.fieldErrors?.name))}
                />
                {state?.fieldErrors?.name && <span style={nxModalErrorStyle}>{state.fieldErrors.name[0]}</span>}
                {state?.error && <span style={nxModalErrorStyle}>{state.error}</span>}
              </>
            )}

            {state?.success && state.code && (
              <div style={nxAgentsCreatedCardStyle}>
                <span style={nxAgentsCreatedHeadingStyle}>Run this on the machine you want to pair</span>
                <div style={nxAgentsCommandRowStyle}>
                  <span ref={commandRef} style={nxAgentsCommandChipStyle}>{command}</span>
                  <button type="button" style={nxAgentsCopyBtnStyle} onClick={handleCopy}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                {copyFallback && <span style={nxAgentsCopyFallbackStyle}>Press {'\u2318'}C to copy</span>}
                {state.expiresAt && (
                  <span style={nxAgentsExpiryStyle}>Expires {new Date(state.expiresAt).toLocaleString()}</span>
                )}
                <p style={nxAgentsCreatedBodyStyle}>
                  This is shown once — copy it now. It won&apos;t be shown again.
                </p>
              </div>
            )}
          </div>
          <div style={nxModalFooterStyle}>
            <button type="button" style={nxModalCancelCellStyle} onClick={onClose}>
              {state?.success ? 'Done' : 'Cancel'}
            </button>
            {!state?.success && (
              <button
                type="submit"
                disabled={pending}
                className="nx-wipe"
                style={{ ...nxModalPrimaryCellStyle(pending), '--wipe-fill': 'var(--nx-ink)', '--wipe-on': 'var(--nx-bg)' } as CSSProperties}
              >
                {pending ? 'Adding\u2026' : 'Add agent'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
