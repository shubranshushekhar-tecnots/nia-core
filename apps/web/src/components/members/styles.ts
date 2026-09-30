import type { CSSProperties } from 'react';

/**
 * Subscription Phase 2, Slice 7 (Members & roles + project members panel).
 * Dedicated file per the slice instruction — these pages never add to
 * components/app/styles.ts, matching the precedent already set by
 * components/billing/styles.ts.
 */

export const memberListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

export const memberRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '12px 14px',
  borderRadius: 10,
  border: '1px solid var(--line)',
  background: 'var(--surface)',
};

export const memberIdentityColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
};

export const memberNameStyle: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 500,
  color: 'var(--text)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const memberMetaStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--text-3)',
};

export const memberActionsColStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flex: 'none',
};

export const memberRoleSelectStyle: CSSProperties = {
  height: 30,
  padding: '0 8px',
  fontSize: 12.5,
  borderRadius: 8,
  border: '1px solid var(--line)',
  background: 'var(--bg)',
  color: 'var(--text)',
};

export const memberRoleBadgeStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 500,
  color: 'var(--text-2)',
  padding: '4px 10px',
};

export const memberRemoveBtnStyle: CSSProperties = {
  height: 30,
  padding: '0 12px',
  fontSize: 12.5,
  fontWeight: 500,
  borderRadius: 8,
  border: '1px solid var(--line)',
  background: 'transparent',
  color: 'var(--bad)',
  cursor: 'pointer',
};

export const viewOnlyNoteStyle: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--text-3)',
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px dashed var(--line)',
  width: 'fit-content',
};

export const membersSectionTitleStyle: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 600,
  color: 'var(--text)',
};

export const addMemberRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

export const addMemberSelectStyle: CSSProperties = {
  height: 32,
  padding: '0 8px',
  fontSize: 12.5,
  borderRadius: 8,
  border: '1px solid var(--line)',
  background: 'var(--bg)',
  color: 'var(--text)',
  flex: 1,
  minWidth: 160,
};
