'use client';

import { useActionState, useEffect } from 'react';
import type { ActionState } from '@/lib/auth/actions';
import { nxModalOverlayStyle } from '@/components/app/styles';
import {
  nxMembersDialogAlertStyle,
  nxMembersDialogBodyStyle,
  nxMembersDialogBodyTextStyle,
  nxMembersDialogCancelCellStyle,
  nxMembersDialogCardStyle,
  nxMembersDialogConfirmCellStyle,
  nxMembersDialogFooterStyle,
  nxMembersDialogTagStyle,
  nxMembersDialogTitleStyle,
} from './styles';

const initialState: ActionState = null;

// Precision Dark redesign — Members & roles. Same delete-confirm anatomy
// as DeleteConfirmDialog.tsx (identical props/action/effect behavior) but
// restyled to match Members.dc.html's dialog exactly (500px card, danger-
// red confirm cell with a trailing × icon, dedicated alert banner for
// blocked errors e.g. protect_last_super_admin). DeleteConfirmDialog.tsx
// itself stays untouched — it's shared by projects/workflows dialogs
// outside this step's scope. Used by both the org members page and
// ProjectMembersPanel ("Same dialog anatomy as org members" per the
// design's states doc).
export default function NxMembersDeleteDialog({
  title,
  message,
  confirmLabel,
  hiddenFields,
  action,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  hiddenFields: Record<string, string>;
  action: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);

  useEffect(() => {
    if (state?.success) onClose();
  }, [state, onClose]);

  return (
    <div style={nxModalOverlayStyle} onClick={onClose}>
      <div style={nxMembersDialogCardStyle} onClick={(e) => e.stopPropagation()}>
        <form action={formAction} style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={nxMembersDialogBodyStyle}>
            <span style={nxMembersDialogTagStyle}>{confirmLabel}</span>
            <h2 style={nxMembersDialogTitleStyle}>{title}</h2>
            <p style={nxMembersDialogBodyTextStyle}>{message}</p>
            {Object.entries(hiddenFields).map(([key, value]) => (
              <input key={key} type="hidden" name={key} value={value} />
            ))}
          </div>
          {state?.error && (
            <div role="alert" style={nxMembersDialogAlertStyle}>
              {'\u2715 '}
              {state.error}
              {state.errorFix && <span style={{ display: 'block', marginTop: 2 }}>{state.errorFix}</span>}
            </div>
          )}
          <div style={nxMembersDialogFooterStyle}>
            <button type="button" style={nxMembersDialogCancelCellStyle} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={pending} style={nxMembersDialogConfirmCellStyle(pending)}>
              {pending ? `${confirmLabel === 'Leave' ? 'Leaving' : 'Deleting'}\u2026` : confirmLabel}
              {!pending && <span>{'\u00d7'}</span>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
