'use client';

import { useState, type ChangeEvent } from 'react';
import { canManageMember, type OrgRole } from '@nia/schemas';
import { changeMemberRole, removeMember, type MemberProfile } from '@/lib/members/actions';
import type { InviteLink } from '@/lib/invites/actions';
import InvitesClient from '@/components/app/InvitesClient';
import DeleteConfirmDialog from '@/components/app/DeleteConfirmDialog';
import {
  addMemberRowStyle,
  memberActionsColStyle,
  memberIdentityColStyle,
  memberListStyle,
  memberMetaStyle,
  memberNameStyle,
  memberRemoveBtnStyle,
  memberRoleBadgeStyle,
  memberRoleSelectStyle,
  memberRowStyle,
  membersSectionTitleStyle,
} from './styles';

const ROLE_OPTIONS: OrgRole[] = ['member', 'admin', 'owner', 'viewer'];

// Subscription Phase 2, Slice 7. canManageMember() here is UX only (which
// roles to even offer, disabling controls for rows the caller can't touch)
// — the organization_members RLS policies + protect_last_super_admin
// trigger (0001/0004_owner_rename.sql) are the real enforcement; a rejected
// attempt still surfaces the server's friendly error message below.
export default function MembersClient({
  callerRole,
  callerUserId,
  members,
  canInvite,
  invites,
}: {
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={membersSectionTitleStyle}>Members</span>
        <div style={memberListStyle}>
          {members.map((member) => {
            const isSelf = member.userId === callerUserId;
            const canManageRole = canManageMember(callerRole, member.role);
            const canRemove = isSelf || canManageRole;
            const roleOptions = ROLE_OPTIONS.filter((r) => canManageMember(callerRole, member.role, r));

            return (
              <div key={member.userId} style={memberRowStyle}>
                <div style={memberIdentityColStyle}>
                  <span style={memberNameStyle}>{member.name ?? member.email ?? member.userId}</span>
                  <span style={memberMetaStyle}>{member.email ?? 'No email on file'}</span>
                  {rowErrors[member.userId] && (
                    <span style={{ fontSize: 12, color: 'var(--bad)' }}>{rowErrors[member.userId]}</span>
                  )}
                </div>
                <div style={memberActionsColStyle}>
                  {canManageRole && roleOptions.length > 0 ? (
                    <select
                      value={member.role}
                      disabled={pendingUserId === member.userId}
                      onChange={(e) => onRoleChange(member, e)}
                      style={memberRoleSelectStyle}
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
                    <span style={memberRoleBadgeStyle}>{member.role}</span>
                  )}
                  {canRemove ? (
                    <button
                      type="button"
                      style={memberRemoveBtnStyle}
                      onClick={() => setRemoveTarget(member)}
                    >
                      {isSelf ? 'Leave' : 'Remove'}
                    </button>
                  ) : (
                    <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                      {member.role === 'owner' ? 'Only an owner can manage owners' : 'Not permitted'}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* canInvite is only true for admin/owner (members.invite gate in page.tsx),
          so this narrowing cast is safe even though callerRole's own type also
          admits 'individual' (a user with no org can never reach this branch). */}
      {canInvite && <InvitesClient invites={invites} callerRole={callerRole as Exclude<OrgRole, 'viewer' | 'individual'>} />}

      {removeTarget && (
        <DeleteConfirmDialog
          title={removeTarget.userId === callerUserId ? 'Leave this organization?' : 'Remove this member?'}
          message={
            removeTarget.userId === callerUserId
              ? "You'll lose access to this organization's projects and connections."
              : `${removeTarget.name ?? removeTarget.email ?? 'This member'} will lose access immediately.`
          }
          hiddenFields={{ targetUserId: removeTarget.userId }}
          action={removeMember}
          onClose={() => setRemoveTarget(null)}
        />
      )}
    </div>
  );
}
