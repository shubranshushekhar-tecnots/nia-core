'use client';

import { useActionState, useEffect, useRef } from 'react';
import { submitTalkToSales } from '@/lib/landing/actions';
import type { ActionState } from '@/lib/auth/actions';
import Button from './Button';
import { hlErrorTextStyle, hlFieldLabelStyle, hlFieldStyle, hlTextareaStyle } from './styles';

const initialState: ActionState = null;

const teamSizeOptions = ['1\u201310', '11\u201350', '51\u2013200', '201\u20131000', '1000+'];

export default function TalkToSalesDialog({ onClose }: { onClose: () => void }) {
  const [state, formAction, pending] = useActionState(submitTalkToSales, initialState);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const hasError = (field: string) => Boolean(state?.fieldErrors?.[field]);

  return (
    <div className="hl-scope hl-dialog-overlay" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="hl-dialog-card"
        style={{ position: 'relative' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="talk-to-sales-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="hl-dialog-close" aria-label="Close" onClick={onClose}>
          &times;
        </button>

        {state?.success ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
            <h2 id="talk-to-sales-title" style={{ margin: 0, fontSize: 24, fontWeight: 500, color: 'var(--hl-ink)' }}>
              Thanks &mdash; we got it.
            </h2>
            <p style={{ margin: 0, fontSize: 15, lineHeight: '24px', color: 'var(--hl-ink-2)' }}>
              Someone from our team will reach out within one business day.
            </p>
            <div style={{ marginTop: 16 }}>
              <Button variant="outline" ground="light" onClick={onClose}>Close</Button>
            </div>
          </div>
        ) : (
          <>
            <h2 id="talk-to-sales-title" style={{ margin: 0, fontSize: 24, fontWeight: 500, color: 'var(--hl-ink)' }}>
              Talk to sales
            </h2>
            <p style={{ margin: '8px 0 0', fontSize: 15, lineHeight: '24px', color: 'var(--hl-ink-2)' }}>
              Tell us about your team and we&rsquo;ll follow up shortly.
            </p>

            <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 24 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor="sales-name" style={hlFieldLabelStyle}>Name</label>
                <input
                  id="sales-name"
                  name="name"
                  type="text"
                  autoFocus
                  placeholder="Jordan Lee"
                  className="hl-field"
                  style={hlFieldStyle(hasError('name'))}
                />
                {state?.fieldErrors?.name && <span style={hlErrorTextStyle}>{state.fieldErrors.name[0]}</span>}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor="sales-email" style={hlFieldLabelStyle}>Work email</label>
                <input
                  id="sales-email"
                  name="workEmail"
                  type="email"
                  placeholder="jordan@company.com"
                  className="hl-field"
                  style={hlFieldStyle(hasError('workEmail'))}
                />
                {state?.fieldErrors?.workEmail && <span style={hlErrorTextStyle}>{state.fieldErrors.workEmail[0]}</span>}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor="sales-company" style={hlFieldLabelStyle}>Company</label>
                <input
                  id="sales-company"
                  name="company"
                  type="text"
                  placeholder="Acme Inc."
                  className="hl-field"
                  style={hlFieldStyle(hasError('company'))}
                />
                {state?.fieldErrors?.company && <span style={hlErrorTextStyle}>{state.fieldErrors.company[0]}</span>}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor="sales-team-size" style={hlFieldLabelStyle}>Team size</label>
                <select
                  id="sales-team-size"
                  name="teamSize"
                  defaultValue=""
                  className="hl-field"
                  style={hlFieldStyle(false)}
                >
                  <option value="" disabled>Select a range</option>
                  {teamSizeOptions.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor="sales-message" style={hlFieldLabelStyle}>What are you looking to do?</label>
                <textarea
                  id="sales-message"
                  name="message"
                  placeholder="Tell us a bit about your use case&hellip;"
                  className="hl-field"
                  style={hlTextareaStyle(false)}
                />
              </div>

              {state?.error && <span style={hlErrorTextStyle}>{state.error}</span>}

              <Button type="submit" variant="solid" ground="light" disabled={pending} style={{ width: '100%', marginTop: 4 }}>
                {pending ? 'Sending\u2026' : 'Send request'}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
