'use client';

import { useActionState, useRef, useState, type CSSProperties } from 'react';
import type { OrgRole } from '@nia/schemas';
import { createInvite, revokeInvite, type InviteActionState, type InviteLink } from '@/lib/invites/actions';
import { nxModalLabelStyle, nxModalFieldStyle, nxModalErrorStyle } from '@/components/app/styles';
import {
  nxMembersInviteFormStyle,
  nxMembersInviteFieldGridStyle,
  nxMembersInviteFieldColStyle,
  nxMembersMonoFieldOverride,
  nxMembersInviteHintStyle,
  nxMembersInviteSubmitStyle,
  nxMembersCreatedCardStyle,
  nxMembersCreatedHeadingStyle,
  nxMembersLinkRowStyle,
  nxMembersLinkChipStyle,
  nxMembersCopyBtnStyle,
  nxMembersCopyFallbackStyle,
  nxMembersCreatedBodyStyle,
  nxMembersCreateAnotherStyle,
  nxMembersInviteListStyle,
  nxMembersInviteRowStyle,
  nxMembersInviteInfoColStyle,
  nxMembersInviteLineStyle,
  nxMembersInviteMetaStyle,
  nxMembersRevokeBtnStyle,
  nxMembersInviteEmptyStyle,
} from '@/components/members/styles';

const initialState: InviteActionState = null;

// Order matches Members.dc.html's invite-form <select> literally (differs
// from the per-row role select's viewer-first order — that's the design).
const ROLE_OPTIONS: OrgRole[] = ['member', 'viewer', 'admin', 'owner'];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function inviteStatus(invite: InviteLink): 'Active' | 'Used up' | 'Expired' | 'Revoked' {
  if (invite.revokedAt) return 'Revoked';
  if (new Date(invite.expiresAt).getTime() <= Date.now()) return 'Expired';
  if (invite.maxUses !== null && invite.uses >= invite.maxUses) return 'Used up';
  return 'Active';
}

// Status → line color, per MembersStates.dc.html's renderVals(): Active
// renders in the blue-panel accent, the rest step down through ink-2/ink-3.
const STATUS_INK: Record<string, string> = {
  Active: 'var(--nx-blue-panel)',
  'Used up': 'var(--nx-ink-2)',
  Expired: 'var(--nx-ink-2)',
  Revoked: 'var(--nx-ink-3)',
};

export default function InvitesClient({ invites, callerRole }: { invites: InviteLink[]; callerRole: OrgRole }) {
  const [state, formAction, pending] = useActionState(createInvite, initialState);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState(false);
  const linkChipRef = useRef<HTMLSpanElement>(null);

  async function handleRevoke(id: string) {
    setRevokeError(null);
    setRevokingId(id);
    const result = await revokeInvite(id);
    setRevokingId(null);
    if (result.error) setRevokeError(result.error);
  }

  async function handleCopy(link: string) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(link);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        return;
      } catch {
        // Fall through to the selection fallback below.
      }
    }
    // No Clipboard API (or it rejected, e.g. insecure context/permissions) —
    // select the link text so the user can still copy it with ⌘C, and never
    // claim "Copied" for something that didn't actually happen.
    if (linkChipRef.current) {
      const range = document.createRange();
      range.selectNodeContents(linkChipRef.current);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    setCopyFallback(true);
    setTimeout(() => setCopyFallback(false), 2000);
  }

  return (
    <>
      <form action={formAction} style={nxMembersInviteFormStyle}>
        <div style={nxMembersInviteFieldGridStyle}>
          <div style={nxMembersInviteFieldColStyle}>
            <label htmlFor="role" style={nxModalLabelStyle}>Role</label>
            <select
              id="role"
              name="role"
              defaultValue="member"
              className="nx-modal-field"
              style={{ ...nxModalFieldStyle(false), ...nxMembersMonoFieldOverride, textTransform: 'uppercase' }}
            >
              {ROLE_OPTIONS.filter((r) => r !== 'owner' || callerRole === 'owner').map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          <div style={nxMembersInviteFieldColStyle}>
            <label htmlFor="expiresInDays" style={nxModalLabelStyle}>Expires in (days)</label>
            <input
              id="expiresInDays"
              name="expiresInDays"
              type="number"
              min={1}
              max={365}
              defaultValue={7}
              className="nx-modal-field"
              style={{ ...nxModalFieldStyle(false), ...nxMembersMonoFieldOverride }}
            />
          </div>
        </div>

        <div style={nxMembersInviteFieldGridStyle}>
          <div style={nxMembersInviteFieldColStyle}>
            <label htmlFor="maxUses" style={nxModalLabelStyle}>Max uses (optional)</label>
            <input
              id="maxUses"
              name="maxUses"
              type="number"
              min={1}
              placeholder="Unlimited"
              className="nx-modal-field"
              style={{ ...nxModalFieldStyle(false), ...nxMembersMonoFieldOverride }}
            />
          </div>
          <div style={nxMembersInviteFieldColStyle}>
            <label htmlFor="emailDomain" style={nxModalLabelStyle}>Email domain (optional)</label>
            <input
              id="emailDomain"
              name="emailDomain"
              type="text"
              placeholder="example.com"
              className="nx-modal-field"
              style={{ ...nxModalFieldStyle(Boolean(state?.fieldErrors?.emailDomain)), ...nxMembersMonoFieldOverride }}
            />
            {state?.fieldErrors?.emailDomain && <span style={nxModalErrorStyle}>{state.fieldErrors.emailDomain[0]}</span>}
          </div>
        </div>

        <p style={nxMembersInviteHintStyle}>
          Email addresses aren&apos;t verified yet, so the domain lock is advisory — someone could still sign up
          with a self-reported address on that domain.
        </p>

        {state?.error && <span style={nxModalErrorStyle}>{state.error}</span>}

        <button type="submit" disabled={pending} style={nxMembersInviteSubmitStyle(pending)}>
          {pending ? 'Creating\u2026' : 'Create invite'}
          {!pending && <span>{'\u2192'}</span>}
        </button>

        {state?.success && state.link && (
          <div style={nxMembersCreatedCardStyle}>
            <span style={nxMembersCreatedHeadingStyle}>Invite link created</span>
            <div style={nxMembersLinkRowStyle}>
              <span ref={linkChipRef} style={nxMembersLinkChipStyle}>{state.link}</span>
              <button type="button" style={nxMembersCopyBtnStyle} onClick={() => handleCopy(state.link!)}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            {copyFallback && <span style={nxMembersCopyFallbackStyle}>Press {'\u2318'}C to copy</span>}
            <p style={nxMembersCreatedBodyStyle}>
              This is shown once — copy it now. It won&apos;t be shown again.
            </p>
          </div>
        )}
      </form>

      <div style={nxMembersInviteListStyle}>
        {revokeError && <span style={{ ...nxModalErrorStyle, padding: '10px 24px' }}>{revokeError}</span>}
        {invites.length === 0 ? (
          <p style={nxMembersInviteEmptyStyle}>No invites yet.</p>
        ) : (
          invites.map((invite) => {
            const status = inviteStatus(invite);
            const ink = status === 'Revoked' ? 'var(--nx-ink-3)' : 'var(--nx-ink)';
            return (
              <div key={invite.id} style={nxMembersInviteRowStyle}>
                <div style={nxMembersInviteInfoColStyle}>
                  <span style={nxMembersInviteLineStyle(ink)}>
                    {invite.role} {'\u00b7'}{' '}
                    <span style={{ color: STATUS_INK[status] }}>{status}</span>
                  </span>
                  <span style={nxMembersInviteMetaStyle}>
                    Expires {formatDate(invite.expiresAt)} {'\u00b7'} used {invite.uses}
                    {invite.maxUses !== null ? `/${invite.maxUses}` : ''}
                    {invite.emailDomain ? ` \u00b7 ${invite.emailDomain} only` : ''}
                  </span>
                </div>
                {status === 'Active' && (
                  <button
                    type="button"
                    onClick={() => handleRevoke(invite.id)}
                    disabled={revokingId === invite.id}
                    className="nx-wipe"
                    style={{ ...nxMembersRevokeBtnStyle, '--wipe-fill': 'var(--nx-danger)', '--wipe-on': 'var(--nx-bg)' } as CSSProperties}
                  >
                    {revokingId === invite.id ? 'Revoking\u2026' : 'Revoke'}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
