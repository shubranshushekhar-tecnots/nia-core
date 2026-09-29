'use client';

import { useActionState, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import AuthShell from '../auth/AuthShell';
import {
  enableTwoFactorEnrollment,
  verifyTwoFactorEnrollment,
  type EnrollActionState,
} from '@/lib/auth/actions';
import {
  errorTextStyle,
  eyeBtnStyle,
  fieldLabelStyle,
  fieldStyle,
  noteStyle,
  signinBtnStyle,
  subtitleStyle,
  titleStyle,
} from '../auth/styles';

const initialState: EnrollActionState = null;

export default function ConsoleEnrollClient() {
  const [enableState, enableAction, enablePending] = useActionState(enableTwoFactorEnrollment, initialState);
  const [verifyState, verifyAction, verifyPending] = useActionState(verifyTwoFactorEnrollment, initialState);
  const [pwShown, setPwShown] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const enrolled = Boolean(enableState?.totpURI);

  useEffect(() => {
    if (enableState?.totpURI) {
      QRCode.toDataURL(enableState.totpURI).then(setQrDataUrl).catch(() => setQrDataUrl(null));
    }
  }, [enableState?.totpURI]);

  if (!enrolled) {
    return (
      <AuthShell narrow>
        <h1 style={titleStyle}>Set up two-factor</h1>
        <p style={subtitleStyle}>
          Console access requires two-factor authentication. Confirm your password to get started.
        </p>

        <form action={enableAction} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <label htmlFor="password" style={fieldLabelStyle}>Password</label>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <input
                id="password"
                name="password"
                type={pwShown ? 'text' : 'password'}
                placeholder={'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
                style={fieldStyle(Boolean(enableState?.error || enableState?.fieldErrors?.password), true)}
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
            {enableState?.fieldErrors?.password && (
              <span style={errorTextStyle}>{enableState.fieldErrors.password[0]}</span>
            )}
          </div>

          {enableState?.error && <span style={errorTextStyle}>{enableState.error}</span>}

          <button type="submit" disabled={enablePending} style={signinBtnStyle}>
            {enablePending ? 'Continuing\u2026' : 'Continue'}
          </button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell narrow>
      <h1 style={titleStyle}>Scan the code</h1>
      <p style={subtitleStyle}>
        Scan with your authenticator app, or enter the key manually. Then enter the 6-digit code to finish.
      </p>

      {qrDataUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={qrDataUrl}
          alt="Two-factor authentication QR code"
          width={180}
          height={180}
          style={{ display: 'block', margin: '0 auto 16px', borderRadius: 12 }}
        />
      )}

      {enableState?.secret && (
        <p style={{ ...noteStyle, textAlign: 'center', marginBottom: 16, wordBreak: 'break-all' }}>
          Manual entry key: <span style={{ fontFamily: 'var(--font-data)' }}>{enableState.secret}</span>
        </p>
      )}

      {enableState?.backupCodes && enableState.backupCodes.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <p style={{ ...noteStyle, marginBottom: 8 }}>
            Save these backup codes somewhere safe. Each can be used once if you lose access to your authenticator app.
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '6px 16px',
              fontFamily: 'var(--font-data)',
              fontSize: 13,
              color: 'var(--text-2)',
            }}
          >
            {enableState.backupCodes.map((code) => (
              <span key={code}>{code}</span>
            ))}
          </div>
        </div>
      )}

      <form action={verifyAction} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <label htmlFor="code" style={fieldLabelStyle}>Verification code</label>
          <input
            id="code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            spellCheck={false}
            style={fieldStyle(Boolean(verifyState?.error || verifyState?.fieldErrors?.code), false)}
          />
          {verifyState?.fieldErrors?.code && <span style={errorTextStyle}>{verifyState.fieldErrors.code[0]}</span>}
        </div>

        {verifyState?.error && <span style={errorTextStyle}>{verifyState.error}</span>}

        <button type="submit" disabled={verifyPending} style={signinBtnStyle}>
          {verifyPending ? 'Verifying\u2026' : 'Verify and continue'}
        </button>
      </form>
    </AuthShell>
  );
}
