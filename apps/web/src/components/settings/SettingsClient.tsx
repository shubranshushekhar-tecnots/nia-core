'use client';

import { useActionState, useState, type CSSProperties } from 'react';
import type { ActionState } from '@/lib/auth/actions';
import { updateOrganization, updateProfileName } from '@/lib/settings/actions';
import { removeMember } from '@/lib/members/actions';
import NxMembersDeleteDialog from '@/components/members/NxMembersDeleteDialog';
import { nxModalErrorStyle, nxModalFieldStyle, nxModalLabelStyle } from '@/components/app/styles';
import AppearancePicker from './AppearancePicker';
import {
  nxSettingsBodyStyle,
  nxSettingsDangerBtnStyle,
  nxSettingsErrorAlertStyle,
  nxSettingsFieldGridStyle,
  nxSettingsFieldRowStyle,
  nxSettingsFormStyle,
  nxSettingsH1Style,
  nxSettingsHeaderRowStyle,
  nxSettingsEyebrowStyle,
  nxSettingsLinkRowArrowStyle,
  nxSettingsLinkRowLabelStyle,
  nxSettingsLinkRowStyle,
  nxSettingsNoOrgTextStyle,
  nxSettingsReadOnlyValueStyle,
  nxSettingsSaveBtnStyle,
  nxSettingsSavedAlertStyle,
  nxSettingsSectionDangerStyle,
  nxSettingsSectionHintStyle,
  nxSettingsSectionStyle,
  nxSettingsSectionTitleDangerStyle,
  nxSettingsSectionTitleStyle,
  nxSettingsSubtitleStyle,
} from './styles';

const initialState: ActionState = null;

export default function SettingsClient({
  userId,
  email,
  fullName,
  org,
  role,
  canUpdateOrg,
  canViewMembers,
  canBilling,
}: {
  userId: string;
  email: string;
  fullName: string | null;
  org: { id: string; name: string; slug: string } | null;
  role: 'individual' | 'member' | 'admin' | 'owner' | 'viewer';
  canUpdateOrg: boolean;
  canViewMembers: boolean;
  canBilling: boolean;
}) {
  const [profileState, profileAction, profilePending] = useActionState(updateProfileName, initialState);
  const [orgState, orgAction, orgPending] = useActionState(updateOrganization, initialState);
  const [leaving, setLeaving] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div style={nxSettingsHeaderRowStyle}>
        <span style={nxSettingsEyebrowStyle}>Platform / Settings</span>
        <h1 style={nxSettingsH1Style}>Settings</h1>
        <p style={nxSettingsSubtitleStyle}>Your profile, organization, and workspace preferences.</p>
      </div>

      <div style={nxSettingsBodyStyle}>
        {/* ---- Profile ---- */}
        <section style={nxSettingsSectionStyle}>
          <h2 style={nxSettingsSectionTitleStyle}>Profile</h2>
          <form action={profileAction} style={nxSettingsFormStyle}>
            <div style={nxSettingsFieldRowStyle}>
              <label htmlFor="fullName" style={nxModalLabelStyle}>
                Name
              </label>
              <input
                id="fullName"
                name="fullName"
                type="text"
                maxLength={120}
                defaultValue={fullName ?? ''}
                style={nxModalFieldStyle(Boolean(profileState?.fieldErrors?.fullName))}
              />
              {profileState?.fieldErrors?.fullName && (
                <span style={nxModalErrorStyle}>{profileState.fieldErrors.fullName[0]}</span>
              )}
            </div>
            <div style={nxSettingsFieldRowStyle}>
              <span style={nxModalLabelStyle}>Email</span>
              <span style={nxSettingsReadOnlyValueStyle}>{email}</span>
              <p style={nxSettingsSectionHintStyle}>Email changes aren&apos;t available yet.</p>
            </div>
            {profileState?.error && <div role="alert" style={nxSettingsErrorAlertStyle}>{profileState.error}</div>}
            {profileState?.success && <div role="alert" style={nxSettingsSavedAlertStyle}>Saved.</div>}
            <button type="submit" disabled={profilePending} style={nxSettingsSaveBtnStyle(profilePending)}>
              {profilePending ? 'Saving\u2026' : 'Save'}
            </button>
          </form>
        </section>

        {/* ---- Appearance ---- */}
        <section style={nxSettingsSectionStyle}>
          <h2 style={nxSettingsSectionTitleStyle}>Appearance</h2>
          <AppearancePicker />
        </section>

        {/* ---- Organization ---- */}
        {org ? (
          <section style={nxSettingsSectionStyle}>
            <h2 style={nxSettingsSectionTitleStyle}>Organization</h2>
            {canUpdateOrg ? (
              <form action={orgAction} style={nxSettingsFormStyle}>
                <div style={nxSettingsFieldGridStyle}>
                  <div style={nxSettingsFieldRowStyle}>
                    <label htmlFor="orgName" style={nxModalLabelStyle}>
                      Name
                    </label>
                    <input
                      id="orgName"
                      name="name"
                      type="text"
                      defaultValue={org.name}
                      style={nxModalFieldStyle(Boolean(orgState?.fieldErrors?.name))}
                    />
                    {orgState?.fieldErrors?.name && <span style={nxModalErrorStyle}>{orgState.fieldErrors.name[0]}</span>}
                  </div>
                  <div style={nxSettingsFieldRowStyle}>
                    <label htmlFor="orgSlug" style={nxModalLabelStyle}>
                      Slug
                    </label>
                    <input
                      id="orgSlug"
                      name="slug"
                      type="text"
                      defaultValue={org.slug}
                      style={nxModalFieldStyle(Boolean(orgState?.fieldErrors?.slug))}
                    />
                    {orgState?.fieldErrors?.slug && <span style={nxModalErrorStyle}>{orgState.fieldErrors.slug[0]}</span>}
                  </div>
                </div>
                {role === 'owner' && (
                  <p style={nxSettingsSectionHintStyle}>
                    To make someone else an owner, change their role in{' '}
                    <a href="/app/members" style={{ color: 'var(--nx-ink-2)' }}>
                      Members &amp; roles →
                    </a>
                  </p>
                )}
                {orgState?.error && <div role="alert" style={nxSettingsErrorAlertStyle}>{orgState.error}</div>}
                {orgState?.success && <div role="alert" style={nxSettingsSavedAlertStyle}>Saved.</div>}
                <button type="submit" disabled={orgPending} style={nxSettingsSaveBtnStyle(orgPending)}>
                  {orgPending ? 'Saving\u2026' : 'Save'}
                </button>
              </form>
            ) : (
              <div style={nxSettingsFieldGridStyle}>
                <div style={nxSettingsFieldRowStyle}>
                  <span style={nxModalLabelStyle}>Name</span>
                  <span style={nxSettingsReadOnlyValueStyle}>{org.name}</span>
                </div>
                <div style={nxSettingsFieldRowStyle}>
                  <span style={nxModalLabelStyle}>Slug</span>
                  <span style={nxSettingsReadOnlyValueStyle}>{org.slug}</span>
                </div>
              </div>
            )}
          </section>
        ) : (
          <section style={nxSettingsSectionStyle}>
            <h2 style={nxSettingsSectionTitleStyle}>Organization</h2>
            <p style={nxSettingsNoOrgTextStyle}>You&apos;re on a personal workspace, not an organization.</p>
          </section>
        )}

        {/* ---- Members & Billing links ---- */}
        {(canViewMembers || canBilling) && (
          <section style={nxSettingsSectionStyle}>
            {canViewMembers && (
              <a href="/app/members" style={nxSettingsLinkRowStyle}>
                <span style={nxSettingsLinkRowLabelStyle}>Members &amp; roles</span>
                <span style={nxSettingsLinkRowArrowStyle}>{'\u2197'}</span>
              </a>
            )}
            {canBilling && (
              <a href="/app/billing" style={nxSettingsLinkRowStyle}>
                <span style={nxSettingsLinkRowLabelStyle}>Billing</span>
                <span style={nxSettingsLinkRowArrowStyle}>{'\u2197'}</span>
              </a>
            )}
          </section>
        )}

        {/* ---- Danger zone ---- */}
        {org && (
          <section style={nxSettingsSectionDangerStyle}>
            <h2 style={nxSettingsSectionTitleDangerStyle}>Danger zone</h2>
            <button
              type="button"
              className="nx-wipe"
              style={{ ...nxSettingsDangerBtnStyle, '--wipe-fill': 'var(--nx-danger)', '--wipe-on': 'var(--nx-bg)' } as CSSProperties}
              onClick={() => setLeaving(true)}
            >
              Leave organization
            </button>
          </section>
        )}
      </div>

      {leaving && (
        <NxMembersDeleteDialog
          title="Leave this organization?"
          message="You'll lose access to this organization's projects and connections."
          confirmLabel="Leave"
          hiddenFields={{ targetUserId: userId }}
          action={removeMember}
          onClose={() => setLeaving(false)}
        />
      )}
    </div>
  );
}
