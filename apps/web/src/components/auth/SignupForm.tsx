'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import AuthShell from './AuthShell';
import GoogleIcon from './GoogleIcon';
import { signup, loginWithGoogle, type ActionState } from '@/lib/auth/actions';
import {
  createLinkStyle,
  errorTextStyle,
  eyeBtnStyle,
  fieldLabelStyle,
  fieldStyle,
  googleBtnStyle,
  noteStyle,
  signinBtnStyle,
  ssoLinkStyle,
  subtitleStyle,
  titleStyle,
} from './styles';

const initialState: ActionState = null;

export default function SignupForm() {
  const [state, formAction, pending] = useActionState(signup, initialState);
  const [pwShown, setPwShown] = useState(false);
  const hasError = Boolean(state?.error);

  return (
    <AuthShell
      footer={
        <>
          <span style={{ fontSize: 14.5, color: 'var(--text-2)' }}>Already have an account? </span>
          <Link href="/login" style={createLinkStyle}>Sign in</Link>
        </>
      }
    >
      <h1 style={titleStyle}>Create your account</h1>
      <p style={subtitleStyle}>One account, any number of organizations.</p>

      <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <label htmlFor="fullName" style={fieldLabelStyle}>Full name</label>
          <input id="fullName" name="fullName" type="text" placeholder="Shub Kumar" style={fieldStyle(false, false)} />
          {state?.fieldErrors?.fullName && <span style={errorTextStyle}>{state.fieldErrors.fullName[0]}</span>}
        </div>

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
          <label htmlFor="password" style={fieldLabelStyle}>Password</label>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <input
              id="password"
              name="password"
              type={pwShown ? 'text' : 'password'}
              placeholder="At least 8 characters"
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
          <span style={noteStyle}>Long passphrases beat complex short ones.</span>
          {state?.fieldErrors?.password && <span style={errorTextStyle}>{state.fieldErrors.password[0]}</span>}
        </div>

        {state?.error && <span style={errorTextStyle}>{state.error}</span>}

        <button type="submit" disabled={pending} style={signinBtnStyle}>
          {pending ? 'Creating account\u2026' : 'Create account'}
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
        <button type="button" style={ssoLinkStyle}>Sign up with SSO instead</button>
      </div>
    </AuthShell>
  );
}
