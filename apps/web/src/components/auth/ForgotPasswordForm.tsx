'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import AuthShell from './AuthShell';
import { forgotPassword, type ActionState } from '@/lib/auth/actions';
import {
  createLinkStyle,
  errorTextStyle,
  fieldLabelStyle,
  fieldStyle,
  signinBtnStyle,
  subtitleStyle,
  successTextStyle,
  titleStyle,
} from './styles';

const initialState: ActionState = null;

export default function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(forgotPassword, initialState);

  const footer = (
    <>
      <span style={{ fontSize: 14.5, color: 'var(--text-2)' }}>Remembered it? </span>
      <Link href="/login" style={createLinkStyle}>Back to sign in</Link>
    </>
  );

  if (state?.success) {
    return (
      <AuthShell footer={footer} narrow>
        <h1 style={titleStyle}>Check your email</h1>
        <p style={successTextStyle}>
          If an account exists for that address, we&rsquo;ve sent a link to reset your password.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell footer={footer} narrow>
      <h1 style={titleStyle}>Reset your password</h1>
      <p style={subtitleStyle}>Enter your work email and we&rsquo;ll send you a reset link.</p>

      <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <label htmlFor="email" style={fieldLabelStyle}>Work email</label>
          <input
            id="email"
            name="email"
            type="text"
            placeholder="shub@icecream.co"
            spellCheck={false}
            style={fieldStyle(Boolean(state?.fieldErrors?.email), false)}
          />
          {state?.fieldErrors?.email && <span style={errorTextStyle}>{state.fieldErrors.email[0]}</span>}
        </div>

        <button type="submit" disabled={pending} style={signinBtnStyle}>
          {pending ? 'Sending\u2026' : 'Send reset link'}
        </button>
      </form>
    </AuthShell>
  );
}
