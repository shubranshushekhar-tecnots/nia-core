'use client';

import { useActionState, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import AuthShell from './AuthShell';
import { login, verifyTwoFactor, type ActionState } from '@/lib/auth/actions';
import { setStoredBearerToken } from '@/lib/auth/browserSession';
import {
  createLinkStyle,
  errorTextStyle,
  eyeBtnStyle,
  fieldLabelStyle,
  fieldStyle,
  forgotLinkStyle,
  signinBtnStyle,
  subtitleStyle,
  titleStyle,
} from './styles';

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
      footer={
        <>
          <span style={{ fontSize: 14.5, color: 'var(--text-2)' }}>New to Nia Core? </span>
          <Link href={next ? `/signup?next=${encodeURIComponent(next)}` : '/signup'} style={createLinkStyle}>Create an account</Link>
        </>
      }
    >
      {!twoFactorRequired ? (
        <>
          <h1 style={titleStyle}>Sign in</h1>
          <p style={subtitleStyle}>Use your work account to reach your organization&rsquo;s data.</p>

          <form action={loginAction} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {next && <input type="hidden" name="next" value={next} />}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <label htmlFor="email" style={fieldLabelStyle}>Work email</label>
              <input
                id="email"
                name="email"
                type="text"
                placeholder="shub@icecream.co"
                spellCheck={false}
                style={fieldStyle(hasError, false)}
              />
              {loginState?.fieldErrors?.email && <span style={errorTextStyle}>{loginState.fieldErrors.email[0]}</span>}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <label htmlFor="password" style={fieldLabelStyle}>Password</label>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <input
                  id="password"
                  name="password"
                  type={pwShown ? 'text' : 'password'}
                  placeholder={'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
                  style={fieldStyle(hasError, true)}
                />
                <button
                  type="button"
                  onClick={() => setPwShown((v) => !v)}
                  aria-label={pwShown ? 'Hide password' : 'Show password'}
                  aria-pressed={pwShown}
                  style={eyeBtnStyle}
                >
                  {pwShown ? '\uD83D\uDF8B' : '\u25C9'}
                </button>
              </div>
              {loginState?.fieldErrors?.password && (
                <span style={errorTextStyle}>{loginState.fieldErrors.password[0]}</span>
              )}
            </div>

            {loginState?.error && <span style={errorTextStyle}>{loginState.error}</span>}

            <button type="submit" disabled={loginPending} style={signinBtnStyle}>
              {loginPending ? 'Signing in\u2026' : 'Sign in'}
            </button>
          </form>
        </>
      ) : (
        <>
          <h1 style={titleStyle}>Enter your code</h1>
          <p style={subtitleStyle}>
            {useBackupCode
              ? 'Enter one of your backup codes.'
              : 'Enter the 6-digit code from your authenticator app.'}
          </p>

          <form action={verifyAction} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {stepTwoNext && <input type="hidden" name="next" value={stepTwoNext} />}
            <input type="hidden" name="method" value={useBackupCode ? 'backup' : 'totp'} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <label htmlFor="code" style={fieldLabelStyle}>
                {useBackupCode ? 'Backup code' : 'Verification code'}
              </label>
              <input
                id="code"
                name="code"
                type="text"
                inputMode={useBackupCode ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                autoFocus
                spellCheck={false}
                style={fieldStyle(hasError, false)}
              />
              {activeState?.fieldErrors?.code && <span style={errorTextStyle}>{activeState.fieldErrors.code[0]}</span>}
            </div>

            {activeState?.error && <span style={errorTextStyle}>{activeState.error}</span>}

            <button type="submit" disabled={verifyPending} style={signinBtnStyle}>
              {verifyPending ? 'Verifying\u2026' : 'Verify'}
            </button>

            <button
              type="button"
              onClick={() => setUseBackupCode((v) => !v)}
              style={{ ...forgotLinkStyle, textAlign: 'left' }}
            >
              {useBackupCode ? 'Use an authenticator code instead' : 'Use a backup code instead'}
            </button>
          </form>
        </>
      )}
    </AuthShell>
  );
}
