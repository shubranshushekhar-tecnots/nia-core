'use client';

import { useState } from 'react';
import { can, type ActorRole } from '@nia/schemas';
import { addProjectMember, removeProjectMember, type ProjectMemberProfile } from '@/lib/projectMembers/actions';
import DeleteConfirmDialog from '@/components/app/DeleteConfirmDialog';
import { primaryBtnStyle } from '@/components/app/styles';
import {
  addMemberRowStyle,
  addMemberSelectStyle,
  memberActionsColStyle,
  memberIdentityColStyle,
  memberListStyle,
  memberMetaStyle,
  memberNameStyle,
  memberRemoveBtnStyle,
  memberRowStyle,
  membersSectionTitleStyle,
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={membersSectionTitleStyle}>Project members</span>
      <div style={memberListStyle}>
        {members.length === 0 && (
          <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>No members added to this project yet.</span>
        )}
        {members.map((member) => {
          const isSelf = member.userId === callerUserId;
          const canRemove = isSelf || canManage;
          return (
            <div key={member.userId} style={memberRowStyle}>
              <div style={memberIdentityColStyle}>
                <span style={memberNameStyle}>{member.name ?? member.email ?? member.userId}</span>
                <span style={memberMetaStyle}>{member.email ?? 'No email on file'}</span>
              </div>
              <div style={memberActionsColStyle}>
                {canRemove ? (
                  <button type="button" style={memberRemoveBtnStyle} onClick={() => setRemoveTarget(member)}>
                    {isSelf ? 'Leave' : 'Remove'}
                  </button>
                ) : (
                  <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Not permitted</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {canManage && (
        <div style={addMemberRowStyle}>
          <select
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            style={addMemberSelectStyle}
            disabled={adding || addable.length === 0}
          >
            <option value="">{addable.length === 0 ? 'All org members already added' : 'Add an org member\u2026'}</option>
            {addable.map((a) => (
              <option key={a.userId} value={a.userId}>
                {a.name ?? a.email ?? a.userId}
              </option>
            ))}
          </select>
          <button type="button" style={primaryBtnStyle} disabled={!selectedUserId || adding} onClick={onAdd}>
            {adding ? 'Adding\u2026' : 'Add'}
          </button>
        </div>
      )}
      {addError && <span style={{ fontSize: 12, color: 'var(--bad)' }}>{addError}</span>}

      {removeTarget && (
        <DeleteConfirmDialog
          title={removeTarget.userId === callerUserId ? 'Leave this project?' : 'Remove this person?'}
          message={
            removeTarget.userId === callerUserId
              ? "You'll lose access to this project."
              : `${removeTarget.name ?? removeTarget.email ?? 'This person'} will lose access to this project.`
          }
          hiddenFields={{ projectId, targetUserId: removeTarget.userId }}
          action={removeProjectMember}
          onClose={() => setRemoveTarget(null)}
        />
      )}
    </div>
  );
}
