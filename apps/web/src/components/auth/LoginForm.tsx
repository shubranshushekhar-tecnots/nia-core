'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import AuthShell from './AuthShell';
import { login, verifyTwoFactor, type ActionState } from '@/lib/auth/actions';
import { setStoredBearerToken } from '@/lib/auth/browserSession';
import { nxModalErrorStyle, nxModalFieldStyle } from '@/components/app/styles';
import { nxOnboardingAlertStyle } from './onboardingStyles';
import {
  nxAuthCodeFieldStyle,
  nxAuthEyeBtnStyle,
  nxAuthFieldGroupStyle,
  nxAuthFormStyle,
  nxAuthLabelStyle,
  nxAuthPasswordFieldStyle,
  nxAuthPasswordRowStyle,
  nxAuthSubmitBtnStyle,
  nxAuthSubmitLabelRowStyle,
  nxAuthToggleLinkStyle,
} from './nxStyles';

const initialState: ActionState = null;

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? '';
  const [loginState, loginAction, loginPending] = useActionState(login, initialState);
  const [verifyState, verifyAction, verifyPending] = useActionState(verifyTwoFactor, initialState);
  const [pwShown, setPwShown] = useState(false);
  const [useBackupCode, setUseBackupCode] = useState(false);

  // Console v1 Slice 4 (docs/plans/console-plan.md §4b): login() reports
  // twoFactorRequired once the account has 2FA enabled, and verifyTwoFactor()
  // re-reports it on a failed attempt so a wrong code re-renders this same
  // step instead of bouncing back to the email/password form.
  const twoFactorRequired = Boolean(loginState?.twoFactorRequired || verifyState?.twoFactorRequired);
  const activeState = twoFactorRequired ? (verifyState ?? loginState) : loginState;
  const hasError = Boolean(activeState?.error);
  const stepTwoNext = loginState?.next ?? next;

  // Console redesign Slice 2: `next=/console...` means this sign-in is for
  // the staff Console, not the customer app — show a red staff header
  // instead of the normal one so it's visually distinct before any
  // session/role check happens.
  const isStaffLogin = next.startsWith('/console');

  // Better Auth's session cookie is httpOnly (the actions can't redirect
  // themselves and hand back a token in the same breath) — store the
  // bearer token for Client Component API calls (lib/auth/browserSession.ts),
  // then navigate once the cookie + token are both in place.
  useEffect(() => {
    if (verifyState?.success && verifyState.token) {
      setStoredBearerToken(verifyState.token);
      router.push(verifyState.next ?? '/app');
    }
  }, [verifyState, router]);

  useEffect(() => {
    if (loginState?.success && loginState.token) {
      setStoredBearerToken(loginState.token);
      router.push(loginState.next ?? '/app');
    }
  }, [loginState, router]);

  return (
    <AuthShell
      kicker={twoFactorRequired ? 'ACCOUNT / TWO-FACTOR' : isStaffLogin ? 'STAFF / SIGN IN' : 'ACCOUNT / SIGN IN'}
      heading={twoFactorRequired ? 'Enter your code' : isStaffLogin ? 'Staff console sign-in' : 'Sign in'}
      subtitle={
        twoFactorRequired
          ? useBackupCode
            ? 'Enter one of your backup codes.'
            : 'Enter the 6-digit code from your authenticator app.'
          : isStaffLogin
            ? 'Restricted to Nia Core staff. Sign in with your staff account; 2FA is required.'
            : "Use your work account to reach your organization's data."
      }
      // Staff accounts are only ever created via the manageStaff CLI, never
      // self-signup — so the staff sign-in never shows a "Create an
      // account" footer (omitting the props makes AuthShell's own
      // `hasFooter` check false). Customer sign-in is unaffected.
      footerQuestion={isStaffLogin ? undefined : 'New to Nia Core?'}
      footerLinkText={isStaffLogin ? undefined : 'Create an account'}
      footerHref={isStaffLogin ? undefined : next ? `/signup?next=${encodeURIComponent(next)}` : '/signup'}
      staffMode={isStaffLogin}
    >
      {!twoFactorRequired ? (
        <form action={loginAction} className="nx-auth-form-pad" style={nxAuthFormStyle}>
          {next && <input type="hidden" name="next" value={next} />}

          <div style={nxAuthFieldGroupStyle}>
            <label htmlFor="email" style={nxAuthLabelStyle(Boolean(loginState?.fieldErrors?.email))}>Work email</label>
            <input
              id="email"
              name="email"
              type="text"
              placeholder="shub@icecream.co"
              spellCheck={false}
              className="nx-modal-field"
              style={nxModalFieldStyle(hasError || Boolean(loginState?.fieldErrors?.email))}
            />
            {loginState?.fieldErrors?.email && <span style={nxModalErrorStyle}>{loginState.fieldErrors.email[0]}</span>}
          </div>

          <div style={nxAuthFieldGroupStyle}>
            <label htmlFor="password" style={nxAuthLabelStyle(Boolean(loginState?.fieldErrors?.password))}>Password</label>
            <div style={nxAuthPasswordRowStyle}>
              <input
                id="password"
                name="password"
                type={pwShown ? 'text' : 'password'}
                placeholder={'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
                className="nx-modal-field"
                style={nxAuthPasswordFieldStyle(hasError || Boolean(loginState?.fieldErrors?.password))}
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
            {loginState?.fieldErrors?.password && (
              <span style={nxModalErrorStyle}>{loginState.fieldErrors.password[0]}</span>
            )}
          </div>

          {loginState?.error && (
            <div role="alert" style={nxOnboardingAlertStyle}>
              {loginState.error}
            </div>
          )}

          <button type="submit" disabled={loginPending} style={nxAuthSubmitBtnStyle(loginPending)}>
            <span style={nxAuthSubmitLabelRowStyle}>
              {loginPending && <span className="nx-spinner" aria-hidden />}
              {loginPending ? 'Signing in\u2026' : 'Sign in'}
            </span>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
              <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" />
            </svg>
          </button>
        </form>
      ) : (
        <form action={verifyAction} className="nx-auth-form-pad" style={nxAuthFormStyle}>
          {stepTwoNext && <input type="hidden" name="next" value={stepTwoNext} />}
          <input type="hidden" name="method" value={useBackupCode ? 'backup' : 'totp'} />

          <div style={nxAuthFieldGroupStyle}>
            <label htmlFor="code" style={nxAuthLabelStyle(Boolean(activeState?.fieldErrors?.code))}>
              {useBackupCode ? 'Backup code' : 'Verification code'}
            </label>
            <input
              id="code"
              name="code"
              type="text"
              placeholder={useBackupCode ? 'xxxx-xxxx' : '000000'}
              inputMode={useBackupCode ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              autoFocus
              spellCheck={false}
              className="nx-modal-field"
              style={nxAuthCodeFieldStyle(hasError || Boolean(activeState?.fieldErrors?.code))}
            />
            {activeState?.fieldErrors?.code && <span style={nxModalErrorStyle}>{activeState.fieldErrors.code[0]}</span>}
          </div>

          {activeState?.error && (
            <div role="alert" style={nxOnboardingAlertStyle}>
              {activeState.error}
            </div>
          )}

          <button type="submit" disabled={verifyPending} style={nxAuthSubmitBtnStyle(verifyPending)}>
            <span style={nxAuthSubmitLabelRowStyle}>
              {verifyPending && <span className="nx-spinner" aria-hidden />}
              {verifyPending ? 'Verifying\u2026' : 'Verify'}
            </span>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
              <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" />
            </svg>
          </button>

          <button
            type="button"
            onClick={() => setUseBackupCode((v) => !v)}
            style={nxAuthToggleLinkStyle}
          >
            {useBackupCode ? 'Use an authenticator code instead' : 'Use a backup code instead'}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
