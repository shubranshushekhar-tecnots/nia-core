'use client';

import { useActionState, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import AuthShell from './AuthShell';
import { login, type ActionState } from '@/lib/auth/actions';
import { setStoredBearerToken } from '@/lib/auth/browserSession';
import {
  createLinkStyle,
  errorTextStyle,
  eyeBtnStyle,
  fieldLabelStyle,
  fieldStyle,
  signinBtnStyle,
  subtitleStyle,
  titleStyle,
} from './styles';

const initialState: ActionState = null;

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? '';
  const [state, formAction, pending] = useActionState(login, initialState);
  const [pwShown, setPwShown] = useState(false);
  const hasError = Boolean(state?.error);

  // Better Auth's session cookie is httpOnly (login() can't redirect
  // itself and hand back a token in the same breath) — store the bearer
  // token for Client Component API calls (lib/auth/browserSession.ts),
  // then navigate once the cookie + token are both in place.
  useEffect(() => {
    if (state?.success && state.token) {
      setStoredBearerToken(state.token);
      router.push(state.next ?? '/app');
    }
  }, [state, router]);

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
          {state?.fieldErrors?.password && <span style={errorTextStyle}>{state.fieldErrors.password[0]}</span>}
        </div>

        {state?.error && (
          <span style={errorTextStyle}>{state.error}</span>
        )}

        <button type="submit" disabled={pending} style={signinBtnStyle}>
          {pending ? 'Signing in\u2026' : 'Sign in'}
        </button>
      </form>
    </AuthShell>
  );
}
