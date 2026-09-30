'use client';

import { useState } from 'react';
import { can, type ActorRole } from '@nia/schemas';
import { addProjectMember, removeProjectMember, type ProjectMemberProfile } from '@/lib/projectMembers/actions';
import NxMembersDeleteDialog from './NxMembersDeleteDialog';
import { nxModalErrorStyle } from '@/components/app/styles';
import {
  nxProjectMembersPanelStyle,
  nxProjectMembersHeaderStyle,
  nxProjectMembersEmptyStyle,
  nxProjectMemberRowStyle,
  nxProjectMemberAvatarStyle,
  nxProjectMemberIdentityColStyle,
  nxProjectMemberNameStyle,
  nxProjectMemberEmailStyle,
  nxProjectMemberActionTextStyle,
  nxProjectMemberNotPermittedStyle,
  nxProjectMembersAddRowStyle,
  nxProjectMembersAddSelectStyle,
  nxProjectMembersAddBtnStyle,
} from './styles';

// Subscription Phase 2, Slice 7 ("Project members panel"). Org-scoped
// projects only — the page that renders this only fetches project members
// when orgId is non-null (personal/owner_id projects have no membership
// concept beyond their one owner). can(callerRole, 'members.remove') is the
// same admin/owner gate project_members_insert_admins_or_owner /
// project_members_delete_admins_or_self (0054_project_members.sql) enforce
// server-side — this is UX only, RLS is the real boundary.
export default function ProjectMembersPanel({
  projectId,
  callerRole,
  callerUserId,
  members,
  addable,
}: {
  projectId: string;
  callerRole: ActorRole;
  callerUserId: string;
  members: ProjectMemberProfile[];
  addable: ProjectMemberProfile[];
}) {
  const canManage = can(callerRole, 'members.remove');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [removeTarget, setRemoveTarget] = useState<ProjectMemberProfile | null>(null);

  async function onAdd() {
    if (!selectedUserId) return;
    setAdding(true);
    setAddError('');
    const result = await addProjectMember(projectId, selectedUserId);
    setAdding(false);
    if (result.error) {
      setAddError(result.error);
    } else {
      setSelectedUserId('');
    }
  }

  const noneAddable = addable.length === 0;

  return (
    <div style={nxProjectMembersPanelStyle}>
      <div style={nxProjectMembersHeaderStyle}>Project members</div>

      {members.length === 0 && <p style={nxProjectMembersEmptyStyle}>No members added to this project yet.</p>}

      {members.map((member) => {
        const isSelf = member.userId === callerUserId;
        const canRemove = isSelf || canManage;
        const label = member.name ?? member.email ?? member.userId;
        return (
          <div key={member.userId} style={nxProjectMemberRowStyle}>
            <span style={nxProjectMemberAvatarStyle()}>
              {label.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase()}
            </span>
            <div style={nxProjectMemberIdentityColStyle}>
              <span style={nxProjectMemberNameStyle}>{label}</span>
              <span style={nxProjectMemberEmailStyle}>{member.email ?? 'No email on file'}</span>
            </div>
            {canRemove ? (
              <button
                type="button"
                style={{ ...nxProjectMemberActionTextStyle, background: 'none', border: 'none', cursor: 'pointer' }}
                onClick={() => setRemoveTarget(member)}
              >
                {isSelf ? 'Leave' : 'Remove'}
              </button>
            ) : (
              <span style={nxProjectMemberNotPermittedStyle}>Not permitted</span>
            )}
          </div>
        );
      })}

      {canManage && (
        <div style={nxProjectMembersAddRowStyle}>
          <select
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            style={nxProjectMembersAddSelectStyle(noneAddable)}
            disabled={adding || noneAddable}
          >
            <option value="">{noneAddable ? 'All org members already added' : 'Add an org member\u2026'}</option>
            {addable.map((a) => (
              <option key={a.userId} value={a.userId}>
                {a.name ?? a.email ?? a.userId}
              </option>
            ))}
          </select>
          <button
            type="button"
            style={nxProjectMembersAddBtnStyle(!selectedUserId || adding)}
            disabled={!selectedUserId || adding}
            onClick={onAdd}
          >
            {adding ? 'Adding\u2026' : 'Add'}
          </button>
        </div>
      )}
      {addError && <span style={{ ...nxModalErrorStyle, padding: '8px 16px' }}>{addError}</span>}

      {removeTarget && (
        <NxMembersDeleteDialog
          title={removeTarget.userId === callerUserId ? 'Leave this project?' : 'Remove this person?'}
          message={
            removeTarget.userId === callerUserId
              ? "You'll lose access to this project."
              : `${removeTarget.name ?? removeTarget.email ?? 'This person'} will lose access to this project.`
          }
          confirmLabel={removeTarget.userId === callerUserId ? 'Leave' : 'Remove'}
          hiddenFields={{ projectId, targetUserId: removeTarget.userId }}
          action={removeProjectMember}
          onClose={() => setRemoveTarget(null)}
        />
      )}
    </div>
  );
}
