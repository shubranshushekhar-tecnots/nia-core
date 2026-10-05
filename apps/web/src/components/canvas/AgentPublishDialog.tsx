'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import type { AgentJobSetup } from '@nia/schemas';
import {
  previewPublishAgentSetup,
  publishAgentSetup,
  AgentSetupApiError,
  type AgentSetupPreviewResult,
} from '@/lib/api/agentSetupClient';
import {
  nxModalBodyStyle,
  nxModalBodyTextStyle,
  nxModalCancelCellStyle,
  nxModalCardStyle,
  nxModalDangerCellStyle,
  nxModalErrorStyle,
  nxModalFooterStyle,
  nxModalOverlayStyle,
  nxModalTitleStyle,
} from '@/components/app/styles';

/**
 * Slice R4 (B.7, item 6) — "Publish shows the preview (what changes, and a
 * clear warning when the change forces a full reload), then publishes."
 * Modeled on DeleteConnectionDialog.tsx's pre-check-then-confirm shape:
 * loads previewPublishAgentSetup on mount, shows its diff, and only then
 * lets the user actually call publishAgentSetup.
 */
export default function AgentPublishDialog({
  workflowId,
  sourceConnectionId,
  destinationConnectionId,
  setup,
  onClose,
  onPublished,
}: {
  workflowId: string;
  sourceConnectionId: string;
  destinationConnectionId: string;
  setup: AgentJobSetup;
  onClose: () => void;
  onPublished: () => void;
}) {
  const [preview, setPreview] = useState<AgentSetupPreviewResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    previewPublishAgentSetup(workflowId, { sourceConnectionId, destinationConnectionId, setup })
      .then((res) => {
        if (!cancelled) setPreview(res);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof AgentSetupApiError ? err.message : "Couldn't preview this change.");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setup is a fresh object every render; compare by workflowId only.
  }, [workflowId]);

  const handlePublish = async () => {
    setPublishing(true);
    setPublishError(null);
    try {
      await publishAgentSetup(workflowId, { sourceConnectionId, destinationConnectionId, setup });
      onPublished();
    } catch (err) {
      setPublishError(err instanceof AgentSetupApiError ? err.message : "Couldn't publish. Try again.");
      setPublishing(false);
    }
  };

  const hasChanges = (preview?.diff.changedFields.length ?? 0) > 0 || !preview?.currentlyPublished;

  return (
    <div style={nxModalOverlayStyle} onClick={onClose}>
      <div style={nxModalCardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={nxModalBodyStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 20 }}>
            <span style={nxModalTitleStyle}>Publish to agent?</span>
            <p style={{ ...nxModalBodyTextStyle, margin: 0 }}>
              The agent picks this up on its next check-in and runs it locally.
            </p>

            {preview === null && !loadError && (
              <span style={{ fontSize: 12.5, color: 'var(--nx-ink-3)' }}>Checking what would change…</span>
            )}
            {loadError && <span style={nxModalErrorStyle}>{loadError}</span>}

            {preview && !preview.currentlyPublished && (
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--nx-ink-3)' }}>This is a new job for the agent.</span>
            )}

            {preview && preview.currentlyPublished && preview.diff.changedFields.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--nx-ink-3)' }}>Changing:</span>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--nx-ink-3)' }}>
                  {preview.diff.changedFields.map((field) => (
                    <li key={field}>{field}</li>
                  ))}
                </ul>
              </div>
            )}

            {preview && preview.currentlyPublished && preview.diff.changedFields.length === 0 && (
              <span style={{ fontSize: 12.5, color: 'var(--nx-ink-3)' }}>No changes from what&apos;s currently published.</span>
            )}

            {preview?.diff.forcesFullReload && (
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--nx-warn)' }}>
                This forces a full reload of the destination the next time the agent runs it.
              </span>
            )}

            {publishError && <span style={nxModalErrorStyle}>{publishError}</span>}
          </div>
        </div>

        <div style={nxModalFooterStyle}>
          <button type="button" style={nxModalCancelCellStyle} onClick={onClose} disabled={publishing}>
            Cancel
          </button>
          <button
            type="button"
            className="nx-wipe"
            style={{ ...nxModalDangerCellStyle(publishing), '--wipe-fill': 'var(--nx-ink)', '--wipe-on': 'var(--nx-bg)' } as CSSProperties}
            onClick={handlePublish}
            disabled={publishing || preview === null || !hasChanges}
          >
            {publishing ? 'Publishing…' : 'Publish'}
          </button>
        </div>
      </div>
    </div>
  );
}
