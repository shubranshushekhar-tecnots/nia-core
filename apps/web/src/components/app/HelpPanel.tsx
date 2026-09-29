'use client';

/**
 * Learning-mode Layer 2 (docs/plans/learning-mode.md) — "Help with this
 * step" panel. Pure presentation over packages/schemas/src/help/content.ts's
 * typed content table: what / why / how (numbered) / common problems + fixes,
 * plus a copy-ready statement for steps that show one (read-only-user,
 * grant-write-access, revoke-access).
 *
 * SQL rendering (Step 3 review): this component never bakes in or offers a
 * Copy button for a shared-placeholder statement. If the calling screen has
 * a real, just-generated credential/namespace, pass it via `values` — the
 * statement is then built from those real values and shown with a Copy
 * button. Without `values`, the statement is shown for illustration only
 * (built from packages/schemas' fixed placeholder values), with no Copy
 * button, and a note pointing the user at the real generator on the form.
 * This is enforced by apps/web/src/lib/help/resolveHelpSql.ts, not by this
 * component's own judgement — see that file's header for why the invariant
 * ("no copy button ever renders with placeholder values") holds by
 * construction.
 *
 * Not wired into any screen yet (docs/plans/learning-mode.md Step 3 scope) —
 * a later step adds the entry points (AddConnectionDialog, EditConnection
 * Dialog, GrantAccessPanel, RevokeAccessPanel) that render this with a real
 * `step`/`connectorId` (and, where available, real `values`). Per the plan's
 * answer "(3) no Ask Copilot on Add/Edit dialogs", this component never
 * renders an Ask Copilot button — that's a separate, later step for the
 * write-grant entry points only.
 *
 * The footer reserves a "Still stuck?" slot per the plan ("Help panel
 * reserves a footer slot for a future 'Still stuck? Contact support' (not
 * built now)") — structural only, no working button yet.
 *
 * Accessibility (docs/plans/learning-mode.md line 29: "help panel keyboard-
 * reachable"): the panel is a modal dialog (`role="dialog"`,
 * `aria-modal="true"`, `aria-label`), takes focus on mount, closes on Esc,
 * and restores focus to whatever was focused before it opened (the trigger)
 * on close/unmount — same pattern any keyboard-only or screen-reader user
 * needs from a modal.
 */
import { useState } from 'react';
import {
  getHelpSection,
  HELP_CONNECTOR_LABEL,
  HELP_STEP_LABEL,
  type HelpConnectorId,
  type HelpSqlValues,
} from '@nia/schemas';
import type { HelpStepKey } from '@nia/schemas';
import { resolveHelpSql, shouldShowCopyButton } from '@/lib/help/resolveHelpSql';
import { useModalA11y } from '@/lib/a11y/useModalDialog';
import {
  modalActionsStyle,
  modalBtnGhostStyle,
  modalCardStyle,
  modalOverlayStyle,
  modalTitleStyle,
} from './styles';

const copyButtonStyle = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--ink)',
  background: 'var(--surface)',
  border: '1px solid var(--line2)',
  borderRadius: 6,
  padding: '5px 10px',
  cursor: 'pointer',
} as const;

export default function HelpPanel({
  step,
  connectorId,
  values,
  onClose,
}: {
  step: HelpStepKey;
  connectorId: string;
  /** Real, currently-active values from the calling screen (e.g. a just-generated credential). Omit to show illustration-only SQL with no Copy button. */
  values?: HelpSqlValues;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const section = getHelpSection(step, connectorId);
  const connectorLabel = HELP_CONNECTOR_LABEL[connectorId as HelpConnectorId] ?? connectorId;
  const resolvedSql = resolveHelpSql(step, connectorId, values);
  const showCopyButton = shouldShowCopyButton(resolvedSql);

  const panelRef = useModalA11y<HTMLDivElement>(onClose);

  async function handleCopy() {
    if (resolvedSql.mode !== 'real') return;
    await navigator.clipboard.writeText(resolvedSql.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div style={modalOverlayStyle} onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${HELP_STEP_LABEL[step]} help for ${connectorLabel}`}
        tabIndex={-1}
        style={{ ...modalCardStyle, width: 440, maxHeight: '80vh', overflowY: 'auto', outline: 'none' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={modalTitleStyle}>
          {HELP_STEP_LABEL[step]} — {connectorLabel}
        </div>

        {!section ? (
          <div style={{ fontSize: 13, color: 'var(--text-2)' }}>No help content for this step yet.</div>
        ) : (
          <>
            <div style={{ fontSize: 13, color: 'var(--text)' }}>{section.what}</div>

            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>Why</div>
              <div style={{ fontSize: 13, color: 'var(--text-2)' }}>{section.why}</div>
            </div>

            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>How</div>
              <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {section.how.map((line, i) => (
                  <li key={i} style={{ fontSize: 13, color: 'var(--text-2)' }}>
                    {line}
                  </li>
                ))}
              </ol>
            </div>

            {resolvedSql.mode !== 'none' && (
              <div>
                {resolvedSql.mode === 'real' || resolvedSql.mode === 'illustration' ? (
                  <>
                    <pre
                      style={{
                        fontFamily: 'var(--font-data)',
                        fontSize: 11,
                        background: 'var(--surface2)',
                        border: '1px solid var(--line)',
                        borderRadius: 6,
                        padding: 8,
                        whiteSpace: 'pre-wrap',
                        overflowX: 'auto',
                        marginBottom: 8,
                      }}
                    >
                      {resolvedSql.text}
                    </pre>
                    {showCopyButton ? (
                      <button type="button" style={copyButtonStyle} onClick={handleCopy}>
                        {copied ? 'Copied' : 'Copy statement'}
                      </button>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                        Shown for illustration only. Use the generator on the form to create your own credentials.
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--warn)' }}>
                    No statement text for this connector — ask your database admin.
                  </div>
                )}
              </div>
            )}

            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>Common problems</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {section.problems.map((p, i) => (
                  <div key={i}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{p.problem}</div>
                    <div style={{ fontSize: 13, color: 'var(--text-2)' }}>{p.fix}</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        <div style={modalActionsStyle}>
          {/* Reserved for a future "Still stuck? Contact support" link (docs/plans/learning-mode.md) — not built yet. */}
          <div style={{ flex: 1 }} />
          <button type="button" style={modalBtnGhostStyle} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
