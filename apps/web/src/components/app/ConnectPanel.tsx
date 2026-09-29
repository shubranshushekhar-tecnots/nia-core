'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { friendlyAppError, friendlyConnectionError, type ConfigField } from '@nia/schemas';
import { createConnection, installConnector, testConnection, ConnectionsApiError } from '@/lib/api/connectionsClient';
import { useModalA11y } from '@/lib/a11y/useModalDialog';
import ConnectionForm from './ConnectionForm';
import {
  connectPanelStepDividerStyle,
  connectPanelStepStyle,
  connectPanelStepsStyle,
  connectPanelTestDotStyle,
  connectPanelTestLabelStyle,
  connectPanelTestMetaStyle,
  connectPanelTestRowStyle,
  modalActionsStyle,
  modalBtnGhostStyle,
  modalBtnPrimaryStyle,
  modalCardStyle,
  modalOverlayStyle,
  modalTitleStyle,
} from './styles';

// Same field body as AddConnectionDialog.tsx via the shared ConnectionForm
// (see condition #1: "de-duplicate, no copied logic left"). Kept as a
// second shell rather than making AddConnectionDialog take a `step` prop
// because the two flows diverge in submit mechanics (Server Action +
// revalidatePath vs. this panel's browser fetch + local step state, needed
// so the Test step has the created connection's id immediately — see
// connectionsClient.ts's createConnection() header comment) and in overall
// shape (3-step wizard vs. single-step dialog).

type Step = 'details' | 'test' | 'done';

type TestResult = { status: 'pending' | 'ok' | 'error'; latencyMs?: number; summary?: string; fix?: string; details?: string };

export default function ConnectPanel({
  connectorName,
  connectorId,
  configSchema,
  onClose,
}: {
  connectorName: string;
  connectorId: string;
  configSchema: ConfigField[];
  onClose: () => void;
}) {
  const router = useRouter();
  const panelRef = useModalA11y<HTMLDivElement>(onClose);
  const [step, setStep] = useState<Step>('details');
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [detailsError, setDetailsError] = useState<{ summary: string; fix?: string; details?: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [test, setTest] = useState<TestResult>({ status: 'pending' });

  async function handleDetailsSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setDetailsError(null);
    setFieldErrors({});

    const formData = new FormData(e.currentTarget);
    const displayName = String(formData.get('displayName') ?? '').trim();
    if (!displayName) {
      setFieldErrors({ displayName: ['Name is required'] });
      return;
    }
    if (displayName.length > 120) {
      setFieldErrors({ displayName: ['Keep it under 120 characters'] });
      return;
    }

    const fields: Record<string, unknown> = {};
    for (const field of configSchema) {
      const raw = formData.get(field.key);
      if (raw === null || raw === '') continue;
      if (field.type === 'number') fields[field.key] = Number(raw);
      else if (field.type === 'boolean') fields[field.key] = raw === 'on' || raw === 'true';
      else if (field.type === 'password') fields[field.key] = String(raw);
      else fields[field.key] = String(raw).trim();
    }

    setSubmitting(true);
    try {
      let created;
      try {
        created = await createConnection(connectorId, displayName, fields);
      } catch (err) {
        // "Connect" collapses install + first connection into one step (see
        // condition #2 in the approved plan) — the catalog no longer has a
        // separate Install control for the 4 real connectors, so this is
        // the only place install-before-connect (connections.ts ~line 200)
        // gets satisfied for a not-yet-installed connector.
        if (err instanceof ConnectionsApiError && err.code === 'NOT_INSTALLED') {
          await installConnector(connectorId);
          created = await createConnection(connectorId, displayName, fields);
        } else {
          throw err;
        }
      }
      setConnectionId(created.id);
      setStep('test');
      void runTest(created.id);
    } catch (err) {
      if (err instanceof ConnectionsApiError) {
        const { summary, fix, helpStepKey, details } = friendlyAppError(err.code, err.message, undefined, err.details);
        setDetailsError({ summary, fix, details });
        void helpStepKey; // surfaced via the existing "Help with this step" trigger, not auto-opened
      } else {
        setDetailsError({ summary: "Couldn't create the connection. Check the details and try again." });
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function runTest(id: string) {
    setTest({ status: 'pending' });
    try {
      const result = await testConnection(id);
      if (result.ok) {
        setTest({ status: 'ok', latencyMs: result.latencyMs });
      } else {
        const { summary, fix, details } = friendlyConnectionError(result.error ?? '');
        setTest({ status: 'error', summary, fix, details });
      }
    } catch (err) {
      if (err instanceof ConnectionsApiError) {
        const { summary, fix, details } = friendlyConnectionError(err.message);
        setTest({ status: 'error', summary, fix, details });
      } else {
        setTest({ status: 'error', summary: "Couldn't run the test. Try again." });
      }
    }
  }

  function handleFinish() {
    router.refresh();
    onClose();
  }

  const stepState = (s: Step): 'done' | 'active' | 'pending' => {
    const order: Step[] = ['details', 'test', 'done'];
    const current = order.indexOf(step);
    const target = order.indexOf(s);
    if (target < current) return 'done';
    if (target === current) return 'active';
    return 'pending';
  };

  return (
    <div style={modalOverlayStyle} onClick={onClose}>
      <div ref={panelRef} tabIndex={-1} style={modalCardStyle} onClick={(e) => e.stopPropagation()}>
        {step !== 'details' && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={modalTitleStyle}>Connect {connectorName}</span>
          </div>
        )}

        <div style={connectPanelStepsStyle}>
          <span style={connectPanelStepStyle(stepState('details'))}>1. Details</span>
          <span style={connectPanelStepDividerStyle} />
          <span style={connectPanelStepStyle(stepState('test'))}>2. Test</span>
          <span style={connectPanelStepDividerStyle} />
          <span style={connectPanelStepStyle(stepState('done'))}>3. Done</span>
        </div>

        {step === 'details' && (
          <form onSubmit={handleDetailsSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <ConnectionForm
              title={`Connect ${connectorName}`}
              connectorName={connectorName}
              connectorId={connectorId}
              configSchema={configSchema}
              idPrefix="connect"
              errors={{
                fieldErrors,
                message: detailsError?.summary,
                fix: detailsError?.fix,
                details: detailsError?.details,
              }}
            />

            <div style={modalActionsStyle}>
              <button type="button" style={modalBtnGhostStyle} onClick={onClose}>
                Cancel
              </button>
              <button type="submit" disabled={submitting} style={modalBtnPrimaryStyle}>
                {submitting ? 'Connecting\u2026' : 'Continue'}
              </button>
            </div>
          </form>
        )}

        {step === 'test' && connectionId && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={connectPanelTestRowStyle(test.status)}>
              <span
                style={{
                  ...connectPanelTestDotStyle,
                  background: test.status === 'ok' ? 'var(--live-fill)' : test.status === 'error' ? 'var(--bad, #d64545)' : 'var(--line2)',
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={connectPanelTestLabelStyle}>
                  {test.status === 'pending' && 'Testing connection\u2026'}
                  {test.status === 'ok' && 'Connection succeeded'}
                  {test.status === 'error' && (test.summary ?? 'Connection failed')}
                </span>
                {test.status === 'ok' && typeof test.latencyMs === 'number' && (
                  <span style={connectPanelTestMetaStyle}>{test.latencyMs}ms</span>
                )}
                {test.status === 'error' && test.fix && <span style={connectPanelTestMetaStyle}>{test.fix}</span>}
              </div>
            </div>
            {test.status === 'error' && test.details && test.details !== test.summary && (
              <details>
                <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--ink4)' }}>Show details</summary>
                <span style={{ display: 'block', marginTop: 4, fontSize: 12, color: 'var(--ink4)' }}>{test.details}</span>
              </details>
            )}
            <div style={modalActionsStyle}>
              <button type="button" style={modalBtnGhostStyle} onClick={onClose}>
                Close
              </button>
              {test.status === 'error' && (
                <button type="button" style={modalBtnGhostStyle} onClick={() => void runTest(connectionId)}>
                  Retry test
                </button>
              )}
              <button
                type="button"
                disabled={test.status === 'pending'}
                style={modalBtnPrimaryStyle}
                onClick={() => setStep('done')}
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <span style={{ fontSize: 13.5, color: 'var(--ink)' }}>
              {test.status === 'ok'
                ? 'Connection is ready to use in workflows.'
                : 'Connection was saved. You can retest it any time from the connections list.'}
            </span>
            <div style={modalActionsStyle}>
              <button type="button" style={modalBtnPrimaryStyle} onClick={handleFinish}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
