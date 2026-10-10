'use client';

import { useActionState, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import AuthShell from './AuthShell';
import { requestPasswordReset, resetPasswordWithCode, type ActionState } from '@/lib/auth/actions';
import { nxModalErrorStyle, nxModalFieldStyle } from '@/components/app/styles';
import { nxOnboardingAlertStyle } from './onboardingStyles';
import {
  nxAuthCodeFieldStyle,
  nxAuthEyeBtnStyle,
  nxAuthFieldGroupStyle,
  nxAuthFormStyle,
  nxAuthLabelStyle,
  nxAuthNoteStyle,
  nxAuthPasswordFieldStyle,
  nxAuthPasswordRowStyle,
  nxAuthSubmitBtnStyle,
  nxAuthSubmitLabelRowStyle,
} from './nxStyles';

const initialState: ActionState = null;

// Email Phase 2: "code + link" reset. The emailed link is
// /reset-password?email=...&otp=...&next=... — arriving with both `email`
// and `otp` pre-filled skips straight to the "choose a new password" step;
// arriving with neither (a user who typed the URL themselves, or the
// "Forgot password?" link from LoginForm) starts at the request step. Both
// paths land on the same resetPasswordWithCode() action, which internally
// re-verifies the code before touching the password.
export default function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? '';
  const emailFromLink = searchParams.get('email') ?? '';
  const otpFromLink = searchParams.get('otp') ?? '';

  const [requestState, requestAction, requestPending] = useActionState(requestPasswordReset, initialState);
  const [resetState, resetAction, resetPending] = useActionState(resetPasswordWithCode, initialState);

  const [email, setEmail] = useState(emailFromLink);
  const [otp, setOtp] = useState(otpFromLink);
  const [pwShown, setPwShown] = useState(false);
  const [skipRequestStep] = useState(Boolean(emailFromLink && otpFromLink));

  const requestSent = Boolean(requestState?.message);
  const showResetStep = skipRequestStep || requestSent;

  // Email Phase 2 review fix: the emailed link puts the live OTP in the
  // URL (?email=...&otp=...) so it can pre-fill the form — but leaving it
  // there afterward means the code sits in browser history, and gets
  // re-sent on every reload. `email`/`otp` are already lifted into
  // component state above, so the form keeps working off this same
  // reload; this just scrubs the now-copied values out of the visible
  // URL/history entry.
  useEffect(() => {
    if (!emailFromLink && !otpFromLink) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('email');
    url.searchParams.delete('otp');
    window.history.replaceState(null, '', url.pathname + url.search);
    // Deliberately runs once on mount only — emailFromLink/otpFromLink
    // are already captured into email/otp state above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AuthShell
      kicker="ACCOUNT / RESET PASSWORD"
      heading={showResetStep ? 'Choose a new password' : 'Reset your password'}
      subtitle={
        showResetStep
          ? 'Enter the code we emailed you and a new password.'
          : "We'll email you a code to reset your password."
      }
      footerQuestion="Remembered it?"
      footerLinkText="Back to sign in"
      footerHref={next ? `/login?next=${encodeURIComponent(next)}` : '/login'}
    >
      {!showResetStep ? (
        <form action={requestAction} className="nx-auth-form-pad" style={nxAuthFormStyle}>
          <div style={nxAuthFieldGroupStyle}>
            <label htmlFor="request-email" style={nxAuthLabelStyle(Boolean(requestState?.fieldErrors?.email))}>
              Work email
            </label>
            <input
              id="request-email"
              name="email"
              type="text"
              placeholder="shub@icecream.co"
              spellCheck={false}
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="nx-modal-field"
              style={nxModalFieldStyle(Boolean(requestState?.fieldErrors?.email))}
            />
            {requestState?.fieldErrors?.email && (
              <span style={nxModalErrorStyle}>{requestState.fieldErrors.email[0]}</span>
            )}
          </div>

          <button type="submit" disabled={requestPending} style={nxAuthSubmitBtnStyle(requestPending)}>
            <span style={nxAuthSubmitLabelRowStyle}>
              {requestPending && <span className="nx-spinner" aria-hidden />}
              {requestPending ? 'Sending\u2026' : 'Send reset code'}
            </span>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
              <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" />
            </svg>
          </button>
        </form>
      ) : (
        <form action={resetAction} className="nx-auth-form-pad" style={nxAuthFormStyle}>
          {next && <input type="hidden" name="next" value={next} />}
          {requestSent && <p style={nxAuthNoteStyle}>{requestState?.message}</p>}

          <div style={nxAuthFieldGroupStyle}>
            <label htmlFor="reset-email" style={nxAuthLabelStyle(Boolean(resetState?.fieldErrors?.email))}>
              Work email
            </label>
            <input
              id="reset-email"
              name="email"
              type="text"
              placeholder="shub@icecream.co"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="nx-modal-field"
              style={nxModalFieldStyle(Boolean(resetState?.fieldErrors?.email))}
            />
            {resetState?.fieldErrors?.email && <span style={nxModalErrorStyle}>{resetState.fieldErrors.email[0]}</span>}
          </div>

          <div style={nxAuthFieldGroupStyle}>
            <label htmlFor="reset-otp" style={nxAuthLabelStyle(Boolean(resetState?.fieldErrors?.otp))}>
              Verification code
            </label>
            <input
              id="reset-otp"
              name="otp"
              type="text"
              placeholder="000000"
              inputMode="numeric"
              autoComplete="one-time-code"
              spellCheck={false}
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              className="nx-modal-field"
              style={nxAuthCodeFieldStyle(Boolean(resetState?.fieldErrors?.otp))}
            />
            {resetState?.fieldErrors?.otp && <span style={nxModalErrorStyle}>{resetState.fieldErrors.otp[0]}</span>}
          </div>

          <div style={nxAuthFieldGroupStyle}>
            <label htmlFor="new-password" style={nxAuthLabelStyle(Boolean(resetState?.fieldErrors?.password))}>
              New password
            </label>
            <div style={nxAuthPasswordRowStyle}>
              <input
                id="new-password"
                name="password"
                type={pwShown ? 'text' : 'password'}
                placeholder={'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
                className="nx-modal-field"
                style={nxAuthPasswordFieldStyle(Boolean(resetState?.fieldErrors?.password))}
              />
              <button
                type="button"
                onClick={() => setPwShown((v) => !v)}
                aria-label={pwShown ? 'Hide password' : 'Show password'}
                aria-pressed={pwShown}
                style={nxAuthEyeBtnStyle}
              >
                {pwShown ? (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
                    <path d="M2 2l12 12M6.6 6.7A2.5 2.5 0 0 0 8 10.5c.5 0 .97-.15 1.36-.4M4.3 4.5C2.7 5.6 1.5 8 1.5 8s2 4.5 6.5 4.5c1 0 1.9-.22 2.66-.58M9.6 3.72A6.8 6.8 0 0 1 8 3.5c4.5 0 6.5 4.5 6.5 4.5a10 10 0 0 1-1.86 2.5" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
                    <path d="M1.5 8S3.5 3.5 8 3.5 14.5 8 14.5 8 12.5 12.5 8 12.5 1.5 8 1.5 8Z" />
                    <circle cx="8" cy="8" r="2" />
                  </svg>
                )}
              </button>
            </div>
            {resetState?.fieldErrors?.password && (
              <span style={nxModalErrorStyle}>{resetState.fieldErrors.password[0]}</span>
            )}
          </div>

          {resetState?.error && (
            <div role="alert" style={nxOnboardingAlertStyle}>
              {resetState.error}
            </div>
          )}

          <button type="submit" disabled={resetPending} style={nxAuthSubmitBtnStyle(resetPending)}>
            <span style={nxAuthSubmitLabelRowStyle}>
              {resetPending && <span className="nx-spinner" aria-hidden />}
              {resetPending ? 'Resetting\u2026' : 'Reset password'}
            </span>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
              <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" />
            </svg>
          </button>
        </form>
      )}
    </AuthShell>
  );
}
