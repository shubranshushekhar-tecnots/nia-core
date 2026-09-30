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
  nxHelpPanelBodyStyle,
  nxHelpPanelCloseCellStyle,
  nxHelpPanelCopyBtnStyle,
  nxHelpPanelFooterCloseStyle,
  nxHelpPanelFooterStyle,
  nxHelpPanelHeaderStyle,
  nxHelpPanelListStyle,
  nxHelpPanelOverlayStyle,
  nxHelpPanelProblemLabelStyle,
  nxHelpPanelProblemRowStyle,
  nxHelpPanelSectionLabelStyle,
  nxHelpPanelSectionStyle,
  nxHelpPanelShellStyle,
  nxHelpPanelSqlBlockStyle,
  nxHelpPanelTextStyle,
  nxHelpPanelTitleStyle,
  nxHelpPanelWarnTextStyle,
} from './styles';

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
    <div style={nxHelpPanelOverlayStyle} onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${HELP_STEP_LABEL[step]} help for ${connectorLabel}`}
        tabIndex={-1}
        style={nxHelpPanelShellStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={nxHelpPanelHeaderStyle}>
          <span style={nxHelpPanelTitleStyle}>
            {HELP_STEP_LABEL[step]} — {connectorLabel}
          </span>
          <button type="button" aria-label="Close" style={nxHelpPanelCloseCellStyle} onClick={onClose}>
            {'\u00D7'}
          </button>
        </div>

        <div style={nxHelpPanelBodyStyle}>
          {!section ? (
            <div style={nxHelpPanelSectionStyle}>
              <p style={nxHelpPanelTextStyle}>No help content for this step yet.</p>
            </div>
          ) : (
            <>
              <div style={nxHelpPanelSectionStyle}>
                <p style={nxHelpPanelTextStyle}>{section.what}</p>
              </div>

              <div style={nxHelpPanelSectionStyle}>
                <span style={nxHelpPanelSectionLabelStyle}>Why</span>
                <p style={nxHelpPanelTextStyle}>{section.why}</p>
              </div>

              <div style={nxHelpPanelSectionStyle}>
                <span style={nxHelpPanelSectionLabelStyle}>How</span>
                <ol style={nxHelpPanelListStyle}>
                  {section.how.map((line, i) => (
                    <li key={i} style={nxHelpPanelTextStyle}>
                      {line}
                    </li>
                  ))}
                </ol>
              </div>

              {resolvedSql.mode !== 'none' && (
                <div style={nxHelpPanelSectionStyle}>
                  {resolvedSql.mode === 'real' || resolvedSql.mode === 'illustration' ? (
                    <>
                      <pre style={nxHelpPanelSqlBlockStyle}>{resolvedSql.text}</pre>
                      {showCopyButton ? (
                        <button type="button" style={nxHelpPanelCopyBtnStyle} onClick={handleCopy}>
                          {copied ? 'Copied' : 'Copy statement'}
                        </button>
                      ) : (
                        <p style={nxHelpPanelTextStyle}>
                          Shown for illustration only. Use the generator on the form to create your own credentials.
                        </p>
                      )}
                    </>
                  ) : (
                    <p style={nxHelpPanelWarnTextStyle}>
                      No statement text for this connector — ask your database admin.
                    </p>
                  )}
                </div>
              )}

              <div style={nxHelpPanelSectionStyle}>
                <span style={nxHelpPanelSectionLabelStyle}>Common problems</span>
                {section.problems.map((p, i) => (
                  <div key={i} style={nxHelpPanelProblemRowStyle}>
                    <span style={nxHelpPanelProblemLabelStyle}>{p.problem}</span>
                    <p style={nxHelpPanelTextStyle}>{p.fix}</p>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div style={nxHelpPanelFooterStyle}>
          {/* Reserved for a future "Still stuck? Contact support" link (docs/plans/learning-mode.md) — not built yet. */}
          <button type="button" style={nxHelpPanelFooterCloseStyle} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
