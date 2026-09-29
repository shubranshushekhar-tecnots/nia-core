'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import type { ConsoleUserDetail } from '@/lib/api/consoleServer';
import { revokeUserSessionsAction } from '@/lib/console/actions';
import {
  consoleBreadcrumbCurrentStyle,
  consoleBreadcrumbLinkStyle,
  consoleBreadcrumbRowStyle,
  consoleBreadcrumbSepStyle,
  consoleColJoinedStyle,
  consoleColMemberStyle,
  consoleColRoleStyle,
  consoleContentStyle,
  consoleDangerBtnStyle,
  consoleDetailHeaderTitleColStyle,
  consoleEmptyStyle,
  consoleGhostBtnStyle,
  consoleHeaderActionsStyle,
  consoleHeaderRowStyle,
  consoleHeaderSubStyle,
  consoleHeaderTitleStyle,
  consolePlanFieldLabelStyle,
  consolePlanFieldStyle,
  consolePlanFormActionsStyle,
  consolePlanFormErrorStyle,
  consolePlanFormWarningStyle,
  consoleRowJoinedCellStyle,
  consoleRowLinkStyle,
  consoleRowRoleCellStyle,
  consoleRowStyle,
  consoleStatCardStyle,
  consoleStatLabelStyle,
  consoleStatsRowStyle,
  consoleStatValueStyle,
  consoleSuspendFormStyle,
  consoleSuspendTextareaStyle,
  consoleTableHeadRowStyle,
  consoleTableStyle,
} from './styles';

/**
 * Console v1 User Detail screen (docs/plans/console-plan.md build order
 * step 12, Slice 3e). Reached only via a link from the Users list or an
 * org detail Members row (ConsoleShell's NAV has no entry for it — see its
 * own doc comment), same as Org Detail. Breadcrumb/header/stat-card layout
 * mirrors ConsoleOrgDetailClient's own precedent for this Console's one
 * other detail screen.
 *
 * Profile, org memberships (with role), and session count/last-sign-in
 * only — never a password, token, or 2FA-secret field, matching
 * routes/console.ts's own doc comment on this route's explicit SELECT/
 * response allowlist. No per-membership "···" menu: that one still doesn't
 * exist yet (same "don't render a non-functional control" convention as
 * every other Console screen's doc comment) — but Slice 3f (build order
 * step 13) does add one real header action: "Sign out everywhere".
 *
 * Same inline-form-not-modal pattern as ConsoleOrgDetailClient's own
 * suspend/unsuspend control (`revokeMode` in place of `suspendMode`,
 * reusing that screen's exact suspend-form styles rather than inventing
 * new ones — this is also a required-reason destructive confirmation).
 * `currentStaffUserId` (the signed-in staff member's own id, threaded down
 * from app/console/users/[userId]/page.tsx's own getSessionUser() call) is
 * used only to show a client-side warning when a staffer is about to revoke
 * their *own* sessions — the backend allows this unconditionally (see
 * routes/console.ts's doc comment on POST .../revoke-sessions), so this is
 * pure confirmation copy, not a permission check.
 */
export default function ConsoleUserDetailClient({
  user,
  currentStaffUserId,
}: {
  user: ConsoleUserDetail;
  currentStaffUserId: string;
}) {
  const meta = `${user.email} · ${user.memberships.length} orgs · Joined ${formatDate(user.createdAt)}`;

  const [sessionCount, setSessionCount] = useState(user.sessionCount);
  const [revokeMode, setRevokeMode] = useState(false);
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeDone, setRevokeDone] = useState<number | null>(null);
  const [isRevokePending, startRevokeTransition] = useTransition();

  const isSelf = user.id === currentStaffUserId;

  function startRevoking() {
    setRevokeReason('');
    setRevokeError(null);
    setRevokeMode(true);
  }

  function handleRevoke() {
    const reason = revokeReason.trim();
    if (!reason) {
      setRevokeError('Reason is required.');
      return;
    }
    setRevokeError(null);
    startRevokeTransition(async () => {
      const result = await revokeUserSessionsAction(user.id, reason);
      if (!result.ok) {
        setRevokeError(result.error);
        return;
      }
      setSessionCount(0);
      setRevokeDone(result.revokedSessionCount);
      setRevokeMode(false);
    });
  }

  return (
    <div style={consoleContentStyle}>
      <div style={consoleBreadcrumbRowStyle}>
        <Link href="/console/users" style={consoleBreadcrumbLinkStyle}>
          Users
        </Link>
        <span style={consoleBreadcrumbSepStyle}>/</span>
        <span style={consoleBreadcrumbCurrentStyle}>{user.name || user.email}</span>
      </div>

      <div style={consoleHeaderRowStyle}>
        <div style={consoleDetailHeaderTitleColStyle}>
          <span style={consoleHeaderTitleStyle}>{user.name || user.email}</span>
          <span style={consoleHeaderSubStyle}>{meta}</span>
          {revokeDone !== null && (
            <span style={consolePlanFormWarningStyle}>Signed out of {revokeDone} session(s).</span>
          )}
        </div>
        {!revokeMode && (
          <div style={consoleHeaderActionsStyle}>
            <button type="button" onClick={startRevoking} style={consoleDangerBtnStyle}>
              Sign out everywhere
            </button>
          </div>
        )}
      </div>

      {revokeMode && (
        <div style={consoleSuspendFormStyle}>
          {isSelf && (
            <span style={consolePlanFormWarningStyle}>
              You are about to sign yourself out everywhere too — you&rsquo;ll need to log back in.
            </span>
          )}
          <div style={consolePlanFieldStyle}>
            <label htmlFor="console-revoke-reason" style={consolePlanFieldLabelStyle}>
              Reason
            </label>
            <textarea
              id="console-revoke-reason"
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
              disabled={isRevokePending}
              style={consoleSuspendTextareaStyle}
              placeholder="Why is this user being signed out everywhere?"
            />
          </div>
          <div style={consolePlanFormActionsStyle}>
            <button type="button" onClick={handleRevoke} disabled={isRevokePending} style={consoleDangerBtnStyle}>
              {isRevokePending ? 'Signing out…' : 'Confirm sign out'}
            </button>
            <button
              type="button"
              onClick={() => setRevokeMode(false)}
              disabled={isRevokePending}
              style={consoleGhostBtnStyle}
            >
              Cancel
            </button>
          </div>
          {revokeError && <span style={consolePlanFormErrorStyle}>{revokeError}</span>}
        </div>
      )}

      <div style={consoleStatsRowStyle}>
        <div style={consoleStatCardStyle}>
          <span style={consoleStatLabelStyle}>Email verified</span>
          <span style={consoleStatValueStyle}>{user.emailVerified ? 'Yes' : 'No'}</span>
        </div>
        <div style={consoleStatCardStyle}>
          <span style={consoleStatLabelStyle}>Sessions</span>
          <span style={consoleStatValueStyle}>{sessionCount}</span>
        </div>
        <div style={consoleStatCardStyle}>
          <span style={consoleStatLabelStyle}>Last sign-in</span>
          <span style={consoleStatValueStyle}>{user.lastSignInAt ? formatDate(user.lastSignInAt) : '—'}</span>
        </div>
      </div>

      <div style={consoleTableStyle}>
        <div style={consoleTableHeadRowStyle}>
          <span style={consoleColMemberStyle}>Organization</span>
          <span style={consoleColRoleStyle}>Role</span>
          <span style={consoleColJoinedStyle}>Joined</span>
        </div>

        {user.memberships.length === 0 && <div style={consoleEmptyStyle}>Not a member of any organization.</div>}

        {user.memberships.map((m) => (
          <Link key={m.orgId} href={`/console/orgs/${m.orgId}`} style={consoleRowLinkStyle}>
            <div style={consoleRowStyle}>
              <span style={consoleColMemberStyle}>{m.orgName}</span>
              <span style={consoleRowRoleCellStyle}>{m.role}</span>
              <span style={consoleRowJoinedCellStyle}>{formatDate(m.joinedAt)}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
