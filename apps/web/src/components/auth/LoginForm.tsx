'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import AuthShell from './AuthShell';
import GoogleIcon from './GoogleIcon';
import { login, loginWithGoogle, type ActionState } from '@/lib/auth/actions';
import {
  createLinkStyle,
  errorTextStyle,
  eyeBtnStyle,
  fieldLabelStyle,
  fieldStyle,
  forgotLinkStyle,
  googleBtnStyle,
  signinBtnStyle,
  ssoLinkStyle,
  subtitleStyle,
  titleStyle,
} from './styles';

const initialState: ActionState = null;

export default function LoginForm() {
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? '';
  const [state, formAction, pending] = useActionState(login, initialState);
  const [pwShown, setPwShown] = useState(false);
  const hasError = Boolean(state?.error);

  return (
    <AuthShell
      footer={
        <>
          <span style={{ fontSize: 14.5, color: 'var(--text-2)' }}>New to Nia Core? </span>
          <Link href="/signup" style={createLinkStyle}>Create an account</Link>
        </>
      }
    >
      <h1 style={titleStyle}>Sign in</h1>
      <p style={subtitleStyle}>Use your work account to reach your organization&rsquo;s data.</p>

      <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
          {state?.fieldErrors?.email && <span style={errorTextStyle}>{state.fieldErrors.email[0]}</span>}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
            <label htmlFor="password" style={fieldLabelStyle}>Password</label>
            <Link href="/forgot-password" style={forgotLinkStyle}>Forgot password?</Link>
          </div>
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
          {state?.fieldErrors?.password && <span style={errorTextStyle}>{state.fieldErrors.password[0]}</span>}
        </div>

        {state?.error && (
          <span style={errorTextStyle}>{state.error}</span>
        )}

        <button type="submit" disabled={pending} style={signinBtnStyle}>
          {pending ? 'Signing in\u2026' : 'Sign in'}
        </button>
      </form>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '22px 0' }}>
        <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
        <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>or</span>
        <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
      </div>

      <form action={loginWithGoogle}>
        <button type="submit" style={googleBtnStyle}>
          <GoogleIcon />
          Continue with Google
        </button>
      </form>

      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
        <button type="button" style={ssoLinkStyle}>Sign in with SSO instead</button>
      </div>
    </AuthShell>
  );
}
