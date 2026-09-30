'use client';

import { useMemo, useState, type ChangeEvent } from 'react';
import { canManageMember, type OrgRole } from '@nia/schemas';
import { changeMemberRole, removeMember, type MemberProfile } from '@/lib/members/actions';
import type { InviteLink } from '@/lib/invites/actions';
import InvitesClient from '@/components/app/InvitesClient';
import NxMembersDeleteDialog from './NxMembersDeleteDialog';
import {
  nxMembersAvatarStyle,
  nxMembersBodyGridStyle,
  nxMembersColumnHeaderRowStyle,
  nxMembersEmailStyle,
  nxMembersEyebrowStyle,
  nxMembersFooterNoteStyle,
  nxMembersH1Style,
  nxMembersHeaderLeftColStyle,
  nxMembersHeaderRowStyle,
  nxMembersIdentityColStyle,
  nxMembersInviteSectionStyle,
  nxMembersJoinedStyle,
  nxMembersNameRowStyle,
  nxMembersPermissionNoteStyle,
  nxMembersRemoveBtnStyle,
  nxMembersRoleBadgeStyle,
  nxMembersRoleColStyle,
  nxMembersRoleErrorStyle,
  nxMembersRolePendingStyle,
  nxMembersRoleSelectStyle,
  nxMembersRowStyle,
  nxMembersSectionCountStyle,
  nxMembersSectionHeaderStyle,
  nxMembersSectionStyle,
  nxMembersSectionTitleStyle,
  nxMembersStatCellStyle,
  nxMembersStatLabelStyle,
  nxMembersStatValueStyle,
  nxMembersStatsGridStyle,
  nxMembersSubtitleStyle,
  nxMembersTitleColStyle,
  nxMembersYouTagStyle,
} from './styles';

const ROLE_OPTIONS: OrgRole[] = ['viewer', 'member', 'admin', 'owner'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatJoined(iso: string): string {
  return new Date(iso)
    .toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    .toUpperCase();
}

function inviteIsActive(invite: InviteLink): boolean {
  if (invite.revokedAt) return false;
  if (new Date(invite.expiresAt).getTime() <= Date.now()) return false;
  if (invite.maxUses !== null && invite.uses >= invite.maxUses) return false;
  return true;
}

// Subscription Phase 2, Slice 7. canManageMember() here is UX only (which
// roles to even offer, disabling controls for rows the caller can't touch)
// — the organization_members RLS policies + protect_last_super_admin
// trigger (0001/0004_owner_rename.sql) are the real enforcement; a rejected
// attempt still surfaces the server's friendly error message below.
export default function MembersClient({
  orgName,
  callerRole,
  callerUserId,
  members,
  canInvite,
  invites,
}: {
  orgName: string;
  callerRole: Exclude<OrgRole, 'viewer'> | 'individual';
  callerUserId: string;
  members: MemberProfile[];
  canInvite: boolean;
  invites: InviteLink[];
}) {
  // No local copy of `members` — changeMemberRole/removeMember both call
  // revalidatePath('/app/members'), which re-renders the parent Server
  // Component and flows fresh props down here automatically (same
  // prop-only convention as ProjectsListClient). Only pure UI state
  // (pending/error) lives locally.
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [removeTarget, setRemoveTarget] = useState<MemberProfile | null>(null);

  const counts = useMemo(() => {
    const ownersAndAdmins = members.filter((m) => m.role === 'owner' || m.role === 'admin').length;
    const viewers = members.filter((m) => m.role === 'viewer').length;
    const activeInvites = invites.filter(inviteIsActive).length;
    return [
      { label: 'Members', n: pad2(members.length), highlight: true },
      { label: 'Owners + admins', n: pad2(ownersAndAdmins), highlight: false },
      { label: 'Active invites', n: pad2(activeInvites), highlight: false },
      { label: 'Viewers', n: pad2(viewers), highlight: false },
    ];
  }, [members, invites]);

  async function onRoleChange(member: MemberProfile, e: ChangeEvent<HTMLSelectElement>) {
    const newRole = e.target.value as OrgRole;
    setPendingUserId(member.userId);
    setRowErrors((prev) => ({ ...prev, [member.userId]: '' }));

    const result = await changeMemberRole(member.userId, newRole);
    setPendingUserId(null);

    if (result.error) {
      setRowErrors((prev) => ({ ...prev, [member.userId]: result.error! }));
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={nxMembersHeaderRowStyle}>
        <div style={nxMembersHeaderLeftColStyle}>
          <span style={nxMembersEyebrowStyle}>Platform / Members &amp; roles</span>
          <div style={nxMembersTitleColStyle}>
            <h1 style={nxMembersH1Style}>Members &amp; roles</h1>
            <p style={nxMembersSubtitleStyle}>Everyone with access to {orgName}, and their role.</p>
          </div>
        </div>
        <div style={nxMembersStatsGridStyle}>
          {counts.map((c) => (
            <div key={c.label} style={nxMembersStatCellStyle(c.highlight)}>
              <span style={nxMembersStatLabelStyle}>{c.label}</span>
              <span style={nxMembersStatValueStyle}>{c.n}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={nxMembersBodyGridStyle}>
        <section style={nxMembersSectionStyle}>
          <div style={nxMembersSectionHeaderStyle}>
            <span style={nxMembersSectionTitleStyle}>Members</span>
            <span style={nxMembersSectionCountStyle}>{pad2(members.length)}</span>
          </div>
          <div style={nxMembersColumnHeaderRowStyle}>
            <span />
            <span>Person</span>
            <span>Role</span>
            <span>Joined</span>
            <span />
          </div>
          {members.map((member) => {
            const isSelf = member.userId === callerUserId;
            const canManageRole = canManageMember(callerRole, member.role);
            const canRemove = isSelf || canManageRole;
            const roleOptions = ROLE_OPTIONS.filter((r) => canManageMember(callerRole, member.role, r));
            const isPending = pendingUserId === member.userId;
            const rowError = rowErrors[member.userId];

            return (
              <div key={member.userId} style={nxMembersRowStyle}>
                <span style={nxMembersAvatarStyle(isSelf)}>
                  {(member.name ?? member.email ?? '?')
                    .split(' ')
                    .map((p) => p[0])
                    .join('')
                    .slice(0, 2)
                    .toUpperCase()}
                </span>
                <div style={nxMembersIdentityColStyle}>
                  <span style={nxMembersNameRowStyle}>
                    {member.name ?? member.email ?? member.userId}
                    {isSelf && <span style={nxMembersYouTagStyle}>YOU</span>}
                  </span>
                  <span style={nxMembersEmailStyle}>{member.email ?? 'No email on file'}</span>
                </div>
                <div style={nxMembersRoleColStyle}>
                  {canManageRole && roleOptions.length > 0 ? (
                    <select
                      aria-label={`Role for ${member.name ?? member.email ?? member.userId}`}
                      value={member.role}
                      disabled={isPending}
                      onChange={(e) => onRoleChange(member, e)}
                      style={nxMembersRoleSelectStyle}
                    >
                      {/* Always include the member's current role even if canManageMember would
                          otherwise exclude it as a *target* (e.g. an admin can't promote to owner,
                          but must still see an existing owner's role rendered correctly). */}
                      {!roleOptions.includes(member.role) && <option value={member.role}>{member.role}</option>}
                      {roleOptions.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span style={nxMembersRoleBadgeStyle}>{member.role}</span>
                  )}
                  {isPending && <span style={nxMembersRolePendingStyle}>Saving</span>}
                  {rowError && <span style={nxMembersRoleErrorStyle}>{rowError}</span>}
                </div>
                <span style={nxMembersJoinedStyle}>{formatJoined(member.joinedAt)}</span>
                {canRemove ? (
                  <button type="button" style={nxMembersRemoveBtnStyle} onClick={() => setRemoveTarget(member)}>
                    {isSelf ? 'Leave' : 'Remove'}
                  </button>
                ) : (
                  <span style={nxMembersPermissionNoteStyle}>
                    {member.role === 'owner' ? 'Only an owner can manage owners' : 'Not permitted'}
                  </span>
                )}
              </div>
            );
          })}
          <p style={nxMembersFooterNoteStyle}>
            Owners can manage everyone. Admins see owners as a fixed badge — only an owner can manage owners. The
            last owner can&apos;t leave or be demoted.
          </p>
        </section>

        <section style={nxMembersInviteSectionStyle}>
          <div style={nxMembersSectionHeaderStyle}>
            <span style={nxMembersSectionTitleStyle}>Invite links</span>
          </div>
          {/* canInvite is only true for admin/owner (members.invite gate in page.tsx),
              so this narrowing cast is safe even though callerRole's own type also
              admits 'individual' (a user with no org can never reach this branch). */}
          {canInvite && (
            <InvitesClient invites={invites} callerRole={callerRole as Exclude<OrgRole, 'viewer' | 'individual'>} />
          )}
        </section>
      </div>

      {removeTarget && (
        <NxMembersDeleteDialog
          title={removeTarget.userId === callerUserId ? 'Leave this organization?' : 'Remove this member?'}
          message={
            removeTarget.userId === callerUserId
              ? "You'll lose access to this organization's projects and connections."
              : `${removeTarget.name ?? removeTarget.email ?? 'This member'} will lose access immediately.`
          }
          confirmLabel={removeTarget.userId === callerUserId ? 'Leave' : 'Remove'}
          hiddenFields={{ targetUserId: removeTarget.userId }}
          action={removeMember}
          onClose={() => setRemoveTarget(null)}
        />
      )}
    </div>
  );
}
