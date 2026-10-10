'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import AuthShell from './AuthShell';
import { signup, verifySignupEmail, type ActionState } from '@/lib/auth/actions';
import { setStoredBearerToken } from '@/lib/auth/browserSession';
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

export default function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? '';
  const [state, formAction, pending] = useActionState(signup, initialState);
  // Email Phase 3 security fix: a second action/form for the "enter the
  // code we emailed you" step, shown instead of a redirect whenever
  // signup() reports emailVerificationRequired (SIGNUP_MODE=request) —
  // mirrors LoginForm's requestCodeAction/codeLoginAction split.
  const [verifyState, verifyAction, verifyPending] = useActionState(verifySignupEmail, initialState);
  const [pwShown, setPwShown] = useState(false);
  const hasError = Boolean(state?.error);

  const verificationRequired = Boolean(state?.emailVerificationRequired || verifyState?.emailVerificationRequired);
  const activeState = verificationRequired ? (verifyState ?? state) : state;
  const verifyEmail = verifyState?.email ?? state?.email ?? '';
  const verifyNext = verifyState?.next ?? state?.next ?? next;

  // Same reasoning as LoginForm: httpOnly session cookie means the token
  // for Client Component API calls has to be handed back explicitly and
  // stored here, before navigating. Covers both the direct-signup success
  // path and the post-verification success path (both return the same
  // {success, token, next} shape).
  useEffect(() => {
    if (activeState?.success && activeState.token) {
      setStoredBearerToken(activeState.token);
      router.push(activeState.next ?? '/app');
    }
  }, [activeState, router]);

  return (
    <AuthShell
      kicker={verificationRequired ? 'ACCOUNT / VERIFY EMAIL' : 'ACCOUNT / SIGN UP'}
      heading={verificationRequired ? 'Check your email' : 'Create your account'}
      subtitle={
        verificationRequired
          ? `Enter the code we sent to ${verifyEmail}.`
          : 'One account, any number of organizations.'
      }
      footerQuestion="Already have an account?"
      footerLinkText="Sign in"
      footerHref={next ? `/login?next=${encodeURIComponent(next)}` : '/login'}
    >
      {verificationRequired ? (
        <form action={verifyAction} className="nx-auth-form-pad" style={nxAuthFormStyle}>
          {verifyNext && <input type="hidden" name="next" value={verifyNext} />}
          <input type="hidden" name="email" value={verifyEmail} />

          <div style={nxAuthFieldGroupStyle}>
            <label htmlFor="signup-otp" style={nxAuthLabelStyle(Boolean(verifyState?.fieldErrors?.otp))}>
              Verification code
            </label>
            <input
              id="signup-otp"
              name="otp"
              type="text"
              placeholder="000000"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              spellCheck={false}
              className="nx-modal-field"
              style={nxAuthCodeFieldStyle(Boolean(verifyState?.error) || Boolean(verifyState?.fieldErrors?.otp))}
            />
            {verifyState?.fieldErrors?.otp && <span style={nxModalErrorStyle}>{verifyState.fieldErrors.otp[0]}</span>}
          </div>

          {verifyState?.error && (
            <div role="alert" style={nxOnboardingAlertStyle}>
              {verifyState.error}
            </div>
          )}

          <button type="submit" disabled={verifyPending} style={nxAuthSubmitBtnStyle(verifyPending)}>
            <span style={nxAuthSubmitLabelRowStyle}>
              {verifyPending && <span className="nx-spinner" aria-hidden />}
              {verifyPending ? 'Verifying\u2026' : 'Verify and continue'}
            </span>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
              <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" />
            </svg>
          </button>
        </form>
      ) : (
      <form action={formAction} className="nx-auth-form-pad" style={nxAuthFormStyle}>
        {next && <input type="hidden" name="next" value={next} />}
        <div style={nxAuthFieldGroupStyle}>
          <label htmlFor="fullName" style={nxAuthLabelStyle(Boolean(state?.fieldErrors?.fullName))}>Full name</label>
          <input id="fullName" name="fullName" type="text" placeholder="Shub Kumar" className="nx-modal-field" style={nxModalFieldStyle(Boolean(state?.fieldErrors?.fullName))} />
          {state?.fieldErrors?.fullName && <span style={nxModalErrorStyle}>{state.fieldErrors.fullName[0]}</span>}
        </div>

        <div style={nxAuthFieldGroupStyle}>
          <label htmlFor="email" style={nxAuthLabelStyle(Boolean(state?.fieldErrors?.email))}>Work email</label>
          <input
            id="email"
            name="email"
            type="text"
            placeholder="shub@icecream.co"
            spellCheck={false}
            className="nx-modal-field"
            style={nxModalFieldStyle(hasError || Boolean(state?.fieldErrors?.email))}
          />
          {state?.fieldErrors?.email && <span style={nxModalErrorStyle}>{state.fieldErrors.email[0]}</span>}
        </div>

        <div style={nxAuthFieldGroupStyle}>
          <label htmlFor="password" style={nxAuthLabelStyle(Boolean(state?.fieldErrors?.password))}>Password</label>
          <div style={nxAuthPasswordRowStyle}>
            <input
              id="password"
              name="password"
              type={pwShown ? 'text' : 'password'}
              placeholder="At least 8 characters"
              className="nx-modal-field"
              style={nxAuthPasswordFieldStyle(hasError || Boolean(state?.fieldErrors?.password))}
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
          <span style={nxAuthNoteStyle}>Long passphrases beat complex short ones.</span>
          {state?.fieldErrors?.password && <span style={nxModalErrorStyle}>{state.fieldErrors.password[0]}</span>}
        </div>

        {state?.error && (
          <div role="alert" style={nxOnboardingAlertStyle}>
            {state.error}
          </div>
        )}

        <button type="submit" disabled={pending} style={nxAuthSubmitBtnStyle(pending)}>
          <span style={nxAuthSubmitLabelRowStyle}>
            {pending && <span className="nx-spinner" aria-hidden />}
            {pending ? 'Creating account\u2026' : 'Create account'}
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
