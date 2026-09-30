'use client';

import { useActionState, useState } from 'react';
import type { OrgRole } from '@nia/schemas';
import { createInvite, revokeInvite, type InviteActionState, type InviteLink } from '@/lib/invites/actions';
import {
  modalLabelStyle,
  modalFieldStyle,
  modalErrorStyle,
  primaryBtnStyle,
  pageEmptyCardStyle,
} from '@/components/app/styles';

const initialState: InviteActionState = null;

const ROLE_OPTIONS: OrgRole[] = ['viewer', 'member', 'admin', 'owner'];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function inviteStatus(invite: InviteLink): string {
  if (invite.revokedAt) return 'Revoked';
  if (new Date(invite.expiresAt).getTime() <= Date.now()) return 'Expired';
  if (invite.maxUses !== null && invite.uses >= invite.maxUses) return 'Used up';
  return 'Active';
}

export default function InvitesClient({ invites, callerRole }: { invites: InviteLink[]; callerRole: OrgRole }) {
  const [state, formAction, pending] = useActionState(createInvite, initialState);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  async function handleRevoke(id: string) {
    setRevokeError(null);
    setRevokingId(id);
    const result = await revokeInvite(id);
    setRevokingId(null);
    if (result.error) setRevokeError(result.error);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 640 }}>
      <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
            <label htmlFor="role" style={modalLabelStyle}>Role</label>
            <select id="role" name="role" defaultValue="member" style={modalFieldStyle(false)}>
              {ROLE_OPTIONS.filter((r) => r !== 'owner' || callerRole === 'owner').map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
            <label htmlFor="expiresInDays" style={modalLabelStyle}>Expires in (days)</label>
            <input id="expiresInDays" name="expiresInDays" type="number" min={1} max={365} defaultValue={7} style={modalFieldStyle(false)} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
            <label htmlFor="maxUses" style={modalLabelStyle}>Max uses (optional)</label>
            <input id="maxUses" name="maxUses" type="number" min={1} placeholder="Unlimited" style={modalFieldStyle(false)} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
            <label htmlFor="emailDomain" style={modalLabelStyle}>Email domain (optional)</label>
            <input id="emailDomain" name="emailDomain" type="text" placeholder="example.com" style={modalFieldStyle(Boolean(state?.fieldErrors?.emailDomain))} />
            {state?.fieldErrors?.emailDomain && <span style={modalErrorStyle}>{state.fieldErrors.emailDomain[0]}</span>}
          </div>
        </div>

        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          Email addresses aren&apos;t verified yet, so the domain lock is advisory — someone could still sign up
          with a self-reported address on that domain.
        </span>

        {state?.error && <span style={modalErrorStyle}>{state.error}</span>}

        <button type="submit" disabled={pending} style={{ ...primaryBtnStyle, alignSelf: 'flex-start' }}>
          {pending ? 'Creating…' : 'Create invite'}
        </button>

        {state?.success && state.link && (
          <div style={pageEmptyCardStyle}>
            <span style={{ fontWeight: 600, color: 'var(--text)' }}>Invite link created</span>
            <span style={{ fontSize: 13, wordBreak: 'break-all' }}>{state.link}</span>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
              This is shown once — copy it now. It won&apos;t be shown again.
            </span>
          </div>
        )}
      </form>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {revokeError && <span style={modalErrorStyle}>{revokeError}</span>}
        {invites.length === 0 ? (
          <div style={pageEmptyCardStyle}>No invites yet.</div>
        ) : (
          invites.map((invite) => {
            const status = inviteStatus(invite);
            return (
              <div
                key={invite.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '12px 14px',
                  borderRadius: 10,
                  border: '1px solid var(--line)',
                  background: 'var(--surface)',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text)' }}>
                    {invite.role} {'\u00b7'} {status}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
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
                    style={{
                      height: 30,
                      padding: '0 12px',
                      fontSize: 12.5,
                      fontWeight: 500,
                      borderRadius: 8,
                      border: '1px solid var(--line)',
                      background: 'transparent',
                      color: 'var(--bad)',
                      cursor: 'pointer',
                    }}
                  >
                    {revokingId === invite.id ? 'Revoking…' : 'Revoke'}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
