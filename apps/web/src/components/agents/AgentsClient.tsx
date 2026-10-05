'use client';

import { useEffect, useState } from 'react';
import { canManageAgent, type ActorRole } from '@nia/schemas';
import type { PlatformAgent } from '@/lib/agents/types';
import { listAgentsClient } from '@/lib/api/agentsClient';
import { revokeAgentAction } from '@/lib/agents/actions';
import AddAgentDialog from './AddAgentDialog';
import RevokeAgentDialog from './RevokeAgentDialog';
import {
  nxAgentsAddBtnStyle,
  nxAgentsAvatarStyle,
  nxAgentsColumnHeaderRowStyle,
  nxAgentsEmptyPanelStyle,
  nxAgentsEmptyStepNumStyle,
  nxAgentsEmptyStepStyle,
  nxAgentsEmptyTextStyle,
  nxAgentsEyebrowStyle,
  nxAgentsH1Style,
  nxAgentsHeaderRowStyle,
  nxAgentsMetaCellStyle,
  nxAgentsNameStyle,
  nxAgentsRevokeBtnStyle,
  nxAgentsRowStyle,
  nxAgentsStatusBadgeStyle,
  nxAgentsStatusDotStyle,
  nxAgentsSubtitleStyle,
  nxAgentsTitleColStyle,
} from './styles';

const POLL_INTERVAL_MS = 15_000;

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '\u2014';
}

/**
 * docs/plans/agent-canvas-integration.md Slice L3 — Agents list + Add/Revoke
 * controls. Polls listAgentsClient() every ~15s while mounted so the
 * online/offline status (derived server-side from last_check_in_at) stays
 * fresh without a manual refresh, matching B.13's monitoring requirement.
 */
export default function AgentsClient({
  callerRole,
  callerUserId,
  agents: initialAgents,
  memberNames,
  canPair,
}: {
  callerRole: ActorRole;
  callerUserId: string;
  agents: PlatformAgent[];
  memberNames: Record<string, string>;
  canPair: boolean;
}) {
  const [agents, setAgents] = useState(initialAgents);
  const [addOpen, setAddOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<PlatformAgent | null>(null);

  function refreshAgents() {
    listAgentsClient()
      .then(setAgents)
      .catch(() => {
        // Transient poll/refresh failure — keep showing the last known
        // list rather than clearing it; the next tick will try again.
      });
  }

  useEffect(() => {
    const interval = setInterval(refreshAgents, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  return (
    <>
      <div style={nxAgentsHeaderRowStyle}>
        <div style={nxAgentsTitleColStyle}>
          <span style={nxAgentsEyebrowStyle}>Platform</span>
          <h1 style={nxAgentsH1Style}>Agents</h1>
          <p style={nxAgentsSubtitleStyle}>Machines paired to run jobs for this workspace.</p>
        </div>
        {canPair && (
          <button type="button" style={nxAgentsAddBtnStyle(false)} onClick={() => setAddOpen(true)}>
            Add agent
          </button>
        )}
      </div>

      {agents.length === 0 ? (
        <div style={nxAgentsEmptyPanelStyle}>
          <div style={nxAgentsEmptyStepStyle}>
            <span style={nxAgentsEmptyStepNumStyle}>1</span>
            <p style={nxAgentsEmptyTextStyle}>
              An agent is a small program you run on your own machine that lets it pick up jobs from this workspace.
            </p>
          </div>
          <div style={nxAgentsEmptyStepStyle}>
            <span style={nxAgentsEmptyStepNumStyle}>2</span>
            <p style={nxAgentsEmptyTextStyle}>
              {canPair
                ? 'Click "Add agent," name it, and copy the pairing command it shows you.'
                : 'Ask an admin, owner, or member to click "Add agent" and share the pairing command with you.'}
            </p>
          </div>
          <div style={nxAgentsEmptyStepStyle}>
            <span style={nxAgentsEmptyStepNumStyle}>3</span>
            <p style={nxAgentsEmptyTextStyle}>
              Run that command on the machine. Once it checks in, it will show up here as online.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div style={nxAgentsColumnHeaderRowStyle}>
            <span />
            <span>Name</span>
            <span>Status</span>
            <span>Last check-in</span>
            <span>Version</span>
            <span>Host</span>
            <span>Paired by</span>
            <span>Created</span>
            <span />
          </div>
          {agents.map((agent) => {
            const revoked = agent.status === 'revoked';
            const canRevoke = !revoked && canManageAgent(callerRole, callerUserId, agent.createdByUserId);
            // A revoked agent's row is never removed from the list — the API
            // never deletes platform_agents rows on revoke (revoke_agent only
            // flips status to 'revoked', see apps/api/src/services/agents.ts)
            // — so the list shows "Revoked" here instead, consistent with
            // what listAgents()/listAgentsClient() keep returning.
            const badgeLabel = revoked ? 'Revoked' : agent.online ? 'Online' : 'Offline';
            return (
              <div key={agent.id} style={nxAgentsRowStyle}>
                <div style={nxAgentsAvatarStyle}>{agent.displayName.slice(0, 1).toUpperCase() || '?'}</div>
                <span style={nxAgentsNameStyle}>{agent.displayName}</span>
                <span style={nxAgentsStatusBadgeStyle(agent.online && !revoked)}>
                  <span style={nxAgentsStatusDotStyle(agent.online && !revoked)} />
                  {badgeLabel}
                </span>
                <span style={nxAgentsMetaCellStyle}>{formatDate(agent.lastCheckInAt)}</span>
                <span style={nxAgentsMetaCellStyle}>{agent.agentVersion ?? '\u2014'}</span>
                <span style={nxAgentsMetaCellStyle}>{agent.hostName ?? '\u2014'}</span>
                <span style={nxAgentsMetaCellStyle}>{memberNames[agent.createdByUserId] ?? agent.createdByUserId}</span>
                <span style={nxAgentsMetaCellStyle}>{formatDate(agent.createdAt)}</span>
                {canRevoke && (
                  <button type="button" style={nxAgentsRevokeBtnStyle} onClick={() => setRevokeTarget(agent)}>
                    Revoke
                  </button>
                )}
              </div>
            );
          })}
        </>
      )}

      {addOpen && <AddAgentDialog onClose={() => setAddOpen(false)} onSuccess={refreshAgents} />}
      {revokeTarget && (
        <RevokeAgentDialog
          title={`Revoke ${revokeTarget.displayName}?`}
          message="Every job running through this agent will lose its link to the platform. This can't be undone."
          hiddenFields={{ agentId: revokeTarget.id }}
          action={revokeAgentAction}
          onClose={() => setRevokeTarget(null)}
          onSuccess={refreshAgents}
        />
      )}
    </>
  );
}
