'use client';

import { useActionState } from 'react';
import Logo from '@/components/Logo';
import { createOrganization, type ActionState } from '@/lib/auth/actions';
import { nxModalErrorStyle, nxModalFieldStyle } from '@/components/app/styles';
import {
  nxOnboardingAlertStyle,
  nxOnboardingColumnStyle,
  nxOnboardingFieldGroupStyle,
  nxOnboardingHeaderStyle,
  nxOnboardingHeadingStyle,
  nxOnboardingLabelStyle,
  nxOnboardingMainStyle,
  nxOnboardingNoteStyle,
  nxOnboardingPageStyle,
  nxOnboardingPanelStyle,
  nxOnboardingSubmitStyle,
  nxOnboardingSubtitleStyle,
  nxOnboardingWordmarkStyle,
} from './onboardingStyles';

const initialState: ActionState = null;

// Precision Dark redesign (Step 8A item 1) — matches SettingsStates.dc.html
// section 02 ("CREATE ORGANIZATION · ONBOARDING FORM": idle, field errors,
// pending, server error). No longer wrapped in AuthShell (components/auth/
// styles.ts's light-indigo [data-auth-theme] chrome) — a full-bleed
// [data-app-theme] page of its own instead, same pattern as the
// accept-invite page. AuthShell itself stays untouched; login/signup get
// their own board later. Logic/copy/action are unchanged from the
// pre-redesign version — this is a render-only restyle.
export default function OnboardingForm() {
  const [state, formAction, pending] = useActionState(createOrganization, initialState);
  const nameError = Boolean(state?.fieldErrors?.name);
  const slugError = Boolean(state?.fieldErrors?.slug);

  return (
    <div data-app-theme="" data-om-theme="light" style={nxOnboardingPageStyle}>
      <div style={nxOnboardingHeaderStyle}>
        <Logo size={28} showWordmark={false} />
        <span style={nxOnboardingWordmarkStyle}>Nia Core</span>
      </div>

      <div style={nxOnboardingMainStyle}>
        <div style={nxOnboardingColumnStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h1 style={nxOnboardingHeadingStyle}>Set up your organization</h1>
            <p style={nxOnboardingSubtitleStyle}>You&rsquo;ll be the first owner — invite teammates once you&rsquo;re in.</p>
          </div>

          <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={nxOnboardingPanelStyle}>
              <div style={nxOnboardingFieldGroupStyle}>
                <label htmlFor="name" style={nxOnboardingLabelStyle(nameError)}>Organization name</label>
                <input id="name" name="name" type="text" placeholder="Ice Cream Co" className="nx-modal-field" style={nxModalFieldStyle(nameError)} />
                {state?.fieldErrors?.name && <span style={nxModalErrorStyle}>{state.fieldErrors.name[0]}</span>}
              </div>

              <div style={nxOnboardingFieldGroupStyle}>
                <label htmlFor="slug" style={nxOnboardingLabelStyle(slugError)}>URL slug</label>
                <input
                  id="slug"
                  name="slug"
                  type="text"
                  placeholder="icecream-co"
                  spellCheck={false}
                  className="nx-modal-field"
                  style={nxModalFieldStyle(slugError)}
                />
                <span style={nxOnboardingNoteStyle}>Lowercase letters, numbers, and hyphens only.</span>
                {state?.fieldErrors?.slug && <span style={nxModalErrorStyle}>{state.fieldErrors.slug[0]}</span>}
              </div>
            </div>

            {state?.error && (
              <div role="alert" style={nxOnboardingAlertStyle}>
                {state.error}
              </div>
            )}

            <button type="submit" disabled={pending} style={nxOnboardingSubmitStyle(pending)}>
              {pending ? (
                <>
                  <span className="nx-spinner" aria-hidden />
                  Creating&hellip;
                </>
              ) : (
                <>
                  Create organization
                  <span aria-hidden>{'\u2192'}</span>
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
