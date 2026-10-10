'use client';

import { useActionState } from 'react';
import AuthShell from './AuthShell';
import { submitAccessRequest, type AccessRequestActionState } from '@/lib/accessRequests/actions';
import { nxModalErrorStyle, nxModalFieldStyle } from '@/components/app/styles';
import {
  nxAuthCheckboxGroupStyle,
  nxAuthCheckboxLabelStyle,
  nxAuthFieldGroupStyle,
  nxAuthFormStyle,
  nxAuthLabelStyle,
  nxAuthNoteStyle,
  nxAuthSubmitBtnStyle,
  nxAuthSubmitLabelRowStyle,
  nxAuthTextareaStyle,
} from './nxStyles';

const DATA_SOURCE_OPTIONS = ['SQL Server', 'MySQL', 'PostgreSQL', 'MongoDB', 'Supabase', 'Other'];

const initialState: AccessRequestActionState = null;

export default function RequestAccessForm() {
  const [state, formAction, pending] = useActionState(submitAccessRequest, initialState);

  if (state?.success) {
    return (
      <AuthShell
        kicker="ACCOUNT / REQUEST ACCESS"
        heading="Thanks — we'll be in touch"
        subtitle="We'll email you once your request has been reviewed."
        footerQuestion="Already have an account?"
        footerLinkText="Sign in"
        footerHref="/login"
      >
        <div className="nx-auth-form-pad" style={nxAuthFormStyle}>
          <p style={nxAuthNoteStyle}>
            If your email is approved, you&apos;ll get a link to finish creating your account.
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      kicker="ACCOUNT / REQUEST ACCESS"
      heading="Request access"
      subtitle="Tell us a bit about you and we'll get back to you."
      footerQuestion="Already have an account?"
      footerLinkText="Sign in"
      footerHref="/login"
    >
      <form action={formAction} className="nx-auth-form-pad" style={nxAuthFormStyle}>
        {/* Honeypot — hidden from real users via CSS, not display:none (bots
            that skip rendering honor display:none and avoid it). */}
        <div style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0, pointerEvents: 'none' }} aria-hidden>
          <label htmlFor="website">Website</label>
          <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
        </div>

        <div style={nxAuthFieldGroupStyle}>
          <label htmlFor="fullName" style={nxAuthLabelStyle(Boolean(state?.fieldErrors?.fullName))}>Full name</label>
          <input id="fullName" name="fullName" type="text" placeholder="Shub Kumar" className="nx-modal-field" style={nxModalFieldStyle(Boolean(state?.fieldErrors?.fullName))} />
          {state?.fieldErrors?.fullName && <span style={nxModalErrorStyle}>{state.fieldErrors.fullName[0]}</span>}
        </div>

        <div style={nxAuthFieldGroupStyle}>
          <label htmlFor="email" style={nxAuthLabelStyle(Boolean(state?.fieldErrors?.email))}>Work email</label>
          <input id="email" name="email" type="text" placeholder="shub@icecream.co" spellCheck={false} className="nx-modal-field" style={nxModalFieldStyle(Boolean(state?.fieldErrors?.email))} />
          {state?.fieldErrors?.email && <span style={nxModalErrorStyle}>{state.fieldErrors.email[0]}</span>}
        </div>

        <div style={nxAuthFieldGroupStyle}>
          <label htmlFor="company" style={nxAuthLabelStyle(Boolean(state?.fieldErrors?.company))}>Company</label>
          <input id="company" name="company" type="text" placeholder="Ice Cream Co" className="nx-modal-field" style={nxModalFieldStyle(Boolean(state?.fieldErrors?.company))} />
          {state?.fieldErrors?.company && <span style={nxModalErrorStyle}>{state.fieldErrors.company[0]}</span>}
        </div>

        <div style={nxAuthFieldGroupStyle}>
          <label htmlFor="jobRole" style={nxAuthLabelStyle(false)}>Role (optional)</label>
          <input id="jobRole" name="jobRole" type="text" placeholder="Data Analyst" className="nx-modal-field" style={nxModalFieldStyle(false)} />
        </div>

        <div style={nxAuthFieldGroupStyle}>
          <label htmlFor="useCase" style={nxAuthLabelStyle(Boolean(state?.fieldErrors?.useCase))}>
            What would you like to use Nia for?
          </label>
          <textarea id="useCase" name="useCase" rows={3} className="nx-modal-field" style={nxAuthTextareaStyle(Boolean(state?.fieldErrors?.useCase))} />
          {state?.fieldErrors?.useCase && <span style={nxModalErrorStyle}>{state.fieldErrors.useCase[0]}</span>}
        </div>

        <div style={nxAuthFieldGroupStyle}>
          <span style={nxAuthLabelStyle(false)}>Data sources (optional)</span>
          <div style={nxAuthCheckboxGroupStyle}>
            {DATA_SOURCE_OPTIONS.map((option) => (
              <label key={option} style={nxAuthCheckboxLabelStyle}>
                <input type="checkbox" name="dataSources" value={option} />
                {option}
              </label>
            ))}
          </div>
        </div>

        <div style={nxAuthFieldGroupStyle}>
          <label htmlFor="referralSource" style={nxAuthLabelStyle(false)}>How did you hear about us? (optional)</label>
          <input id="referralSource" name="referralSource" type="text" className="nx-modal-field" style={nxModalFieldStyle(false)} />
        </div>

        <div style={nxAuthFieldGroupStyle}>
          <label style={nxAuthCheckboxLabelStyle}>
            <input type="checkbox" name="consent" />
            I agree to be contacted about my request.
          </label>
          {state?.fieldErrors?.consent && <span style={nxModalErrorStyle}>{state.fieldErrors.consent[0]}</span>}
        </div>

        <button type="submit" disabled={pending} style={nxAuthSubmitBtnStyle(pending)}>
          <span style={nxAuthSubmitLabelRowStyle}>
            {pending && <span className="nx-spinner" aria-hidden />}
            {pending ? 'Submitting\u2026' : 'Request access'}
          </span>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
            <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" />
          </svg>
        </button>
      </form>
    </AuthShell>
  );
}
