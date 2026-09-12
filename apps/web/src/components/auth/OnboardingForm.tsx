'use client';

import { useActionState } from 'react';
import AuthShell from './AuthShell';
import { createOrganization, type ActionState } from '@/lib/auth/actions';
import {
  errorTextStyle,
  fieldLabelStyle,
  fieldStyle,
  noteStyle,
  signinBtnStyle,
  subtitleStyle,
  titleStyle,
} from './styles';

const initialState: ActionState = null;

export default function OnboardingForm() {
  const [state, formAction, pending] = useActionState(createOrganization, initialState);

  return (
    <AuthShell narrow>
      <h1 style={titleStyle}>Set up your organization</h1>
      <p style={subtitleStyle}>You&rsquo;ll be the first owner — invite teammates once you&rsquo;re in.</p>

      <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <label htmlFor="name" style={fieldLabelStyle}>Organization name</label>
          <input id="name" name="name" type="text" placeholder="Ice Cream Co" style={fieldStyle(Boolean(state?.fieldErrors?.name), false)} />
          {state?.fieldErrors?.name && <span style={errorTextStyle}>{state.fieldErrors.name[0]}</span>}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <label htmlFor="slug" style={fieldLabelStyle}>URL slug</label>
          <input
            id="slug"
            name="slug"
            type="text"
            placeholder="icecream-co"
            spellCheck={false}
            style={fieldStyle(Boolean(state?.fieldErrors?.slug), false)}
          />
          <span style={noteStyle}>Lowercase letters, numbers, and hyphens only.</span>
          {state?.fieldErrors?.slug && <span style={errorTextStyle}>{state.fieldErrors.slug[0]}</span>}
        </div>

        {state?.error && <span style={errorTextStyle}>{state.error}</span>}

        <button type="submit" disabled={pending} style={signinBtnStyle}>
          {pending ? 'Creating\u2026' : 'Create organization'}
        </button>
      </form>
    </AuthShell>
  );
}
