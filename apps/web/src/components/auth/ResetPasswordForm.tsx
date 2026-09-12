'use client';

import { useActionState, useState } from 'react';
import AuthShell from './AuthShell';
import { resetPassword, type ActionState } from '@/lib/auth/actions';
import {
  errorTextStyle,
  eyeBtnStyle,
  fieldLabelStyle,
  fieldStyle,
  signinBtnStyle,
  subtitleStyle,
  titleStyle,
} from './styles';

const initialState: ActionState = null;

export default function ResetPasswordForm() {
  const [state, formAction, pending] = useActionState(resetPassword, initialState);
  const [pwShown, setPwShown] = useState(false);

  return (
    <AuthShell narrow>
      <h1 style={titleStyle}>Set a new password</h1>
      <p style={subtitleStyle}>Choose a new password for your account.</p>

      <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <label htmlFor="password" style={fieldLabelStyle}>New password</label>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <input
              id="password"
              name="password"
              type={pwShown ? 'text' : 'password'}
              placeholder="At least 8 characters"
              style={fieldStyle(Boolean(state?.fieldErrors?.password), true)}
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

        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <label htmlFor="confirmPassword" style={fieldLabelStyle}>Confirm password</label>
          <input
            id="confirmPassword"
            name="confirmPassword"
            type={pwShown ? 'text' : 'password'}
            placeholder="Repeat your password"
            style={fieldStyle(Boolean(state?.fieldErrors?.confirmPassword), false)}
          />
          {state?.fieldErrors?.confirmPassword && (
            <span style={errorTextStyle}>{state.fieldErrors.confirmPassword[0]}</span>
          )}
        </div>

        {state?.error && <span style={errorTextStyle}>{state.error}</span>}

        <button type="submit" disabled={pending} style={signinBtnStyle}>
          {pending ? 'Saving\u2026' : 'Save new password'}
        </button>
      </form>
    </AuthShell>
  );
}
