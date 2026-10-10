'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import AuthShell from './AuthShell';
import { login, verifyTwoFactor, requestLoginCode, loginWithCode, type ActionState } from '@/lib/auth/actions';
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
  nxAuthToggleLinkStyle,
} from './nxStyles';

const initialState: ActionState = null;

export default function LoginForm({ requestMode = false }: { requestMode?: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? '';
  // Email Phase 2: resetPasswordWithCode() redirects here with
  // ?message=... after a successful password reset (session deletion means
  // it can no longer auto-sign the user back in) — surfaced once on the
  // plain password step, same note style already used for the OTP flow.
  const message = searchParams.get('message');
  const [loginState, loginAction, loginPending] = useActionState(login, initialState);
  const [verifyState, verifyAction, verifyPending] = useActionState(verifyTwoFactor, initialState);
  const [requestCodeState, requestCodeAction, requestCodePending] = useActionState(requestLoginCode, initialState);
  const [codeLoginState, codeLoginAction, codeLoginPending] = useActionState(loginWithCode, initialState);
  const [pwShown, setPwShown] = useState(false);
  const [useBackupCode, setUseBackupCode] = useState(false);
  // Email Phase 2: "Email me a code" is a third step alongside the
  // existing password-step/2FA-step, toggled from the password step.
  // `email` is lifted into state (rather than left as an uncontrolled
  // input, like the password field stays) purely so it carries across
  // from the "send code" screen to the "enter code" screen without a
  // round trip through the server.
  const [useCode, setUseCode] = useState(false);
  const [email, setEmail] = useState('');
  const codeSent = Boolean(requestCodeState?.message);

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

  useEffect(() => {
    if (codeLoginState?.success && codeLoginState.token) {
      setStoredBearerToken(codeLoginState.token);
      router.push(codeLoginState.next ?? '/app');
    }
  }, [codeLoginState, router]);

  return (
    <AuthShell
      kicker={twoFactorRequired ? 'ACCOUNT / TWO-FACTOR' : isStaffLogin ? 'STAFF / SIGN IN' : 'ACCOUNT / SIGN IN'}
      heading={
        twoFactorRequired
          ? 'Enter your code'
          : isStaffLogin
            ? 'Staff console sign-in'
            : useCode
              ? 'Sign in with a code'
              : 'Sign in'
      }
      subtitle={
        twoFactorRequired
          ? useBackupCode
            ? 'Enter one of your backup codes.'
            : 'Enter the 6-digit code from your authenticator app.'
          : isStaffLogin
            ? 'Restricted to Nia Core staff. Sign in with your staff account; 2FA is required.'
            : useCode
              ? codeSent
                ? 'Enter the 6-digit code we emailed you.'
                : "We'll email you a one-time code — no password needed."
              : "Use your work account to reach your organization's data."
      }
      // Staff accounts are only ever created via the manageStaff CLI, never
      // self-signup — so the staff sign-in never shows a "Create an
      // account" footer (omitting the props makes AuthShell's own
      // `hasFooter` check false). Customer sign-in is unaffected.
      // Email Phase 3: when SIGNUP_MODE=request, point this footer at
      // /request-access instead of /signup — /signup itself stays reachable
      // (unlinked, not blocked by middleware) for the approved/invited flows.
      footerQuestion={isStaffLogin ? undefined : 'New to Nia Core?'}
      footerLinkText={isStaffLogin ? undefined : requestMode ? 'Request access' : 'Create an account'}
      footerHref={
        isStaffLogin
          ? undefined
          : requestMode
            ? '/request-access'
            : next
              ? `/signup?next=${encodeURIComponent(next)}`
              : '/signup'
      }
      staffMode={isStaffLogin}
    >
      {!twoFactorRequired ? (
        useCode ? (
          !codeSent ? (
            <form action={requestCodeAction} className="nx-auth-form-pad" style={nxAuthFormStyle}>
              {next && <input type="hidden" name="next" value={next} />}

              <div style={nxAuthFieldGroupStyle}>
                <label htmlFor="code-email" style={nxAuthLabelStyle(Boolean(requestCodeState?.fieldErrors?.email))}>
                  Work email
                </label>
                <input
                  id="code-email"
                  name="email"
                  type="text"
                  placeholder="shub@icecream.co"
                  spellCheck={false}
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="nx-modal-field"
                  style={nxModalFieldStyle(Boolean(requestCodeState?.fieldErrors?.email))}
                />
                {requestCodeState?.fieldErrors?.email && (
                  <span style={nxModalErrorStyle}>{requestCodeState.fieldErrors.email[0]}</span>
                )}
              </div>

              <button type="submit" disabled={requestCodePending} style={nxAuthSubmitBtnStyle(requestCodePending)}>
                <span style={nxAuthSubmitLabelRowStyle}>
                  {requestCodePending && <span className="nx-spinner" aria-hidden />}
                  {requestCodePending ? 'Sending\u2026' : 'Send code'}
                </span>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
                  <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" />
                </svg>
              </button>

              <button type="button" onClick={() => setUseCode(false)} style={nxAuthToggleLinkStyle}>
                Use your password instead
              </button>
            </form>
          ) : (
            <form action={codeLoginAction} className="nx-auth-form-pad" style={nxAuthFormStyle}>
              {next && <input type="hidden" name="next" value={next} />}
              <input type="hidden" name="email" value={email} />

              <p style={nxAuthNoteStyle}>{requestCodeState?.message}</p>

              <div style={nxAuthFieldGroupStyle}>
                <label htmlFor="login-otp" style={nxAuthLabelStyle(Boolean(codeLoginState?.fieldErrors?.otp))}>
                  Verification code
                </label>
                <input
                  id="login-otp"
                  name="otp"
                  type="text"
                  placeholder="000000"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  spellCheck={false}
                  className="nx-modal-field"
                  style={nxAuthCodeFieldStyle(Boolean(codeLoginState?.error) || Boolean(codeLoginState?.fieldErrors?.otp))}
                />
                {codeLoginState?.fieldErrors?.otp && (
                  <span style={nxModalErrorStyle}>{codeLoginState.fieldErrors.otp[0]}</span>
                )}
              </div>

              {codeLoginState?.error && (
                <div role="alert" style={nxOnboardingAlertStyle}>
                  {codeLoginState.error}
                </div>
              )}

              <button type="submit" disabled={codeLoginPending} style={nxAuthSubmitBtnStyle(codeLoginPending)}>
                <span style={nxAuthSubmitLabelRowStyle}>
                  {codeLoginPending && <span className="nx-spinner" aria-hidden />}
                  {codeLoginPending ? 'Signing in\u2026' : 'Sign in'}
                </span>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" aria-hidden>
                  <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" />
                </svg>
              </button>

              <button type="button" onClick={() => setUseCode(false)} style={nxAuthToggleLinkStyle}>
                Use your password instead
              </button>
            </form>
          )
        ) : (
        <form action={loginAction} className="nx-auth-form-pad" style={nxAuthFormStyle}>
          {next && <input type="hidden" name="next" value={next} />}

          {message && <p style={nxAuthNoteStyle}>{message}</p>}

          <div style={nxAuthFieldGroupStyle}>
            <label htmlFor="email" style={nxAuthLabelStyle(Boolean(loginState?.fieldErrors?.email))}>Work email</label>
            <input
              id="email"
              name="email"
              type="text"
              placeholder="shub@icecream.co"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
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

          <button type="button" onClick={() => setUseCode(true)} style={nxAuthToggleLinkStyle}>
            Email me a code instead
          </button>
          <Link href="/reset-password" style={nxAuthToggleLinkStyle}>
            Forgot password?
          </Link>
        </form>
        )
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
