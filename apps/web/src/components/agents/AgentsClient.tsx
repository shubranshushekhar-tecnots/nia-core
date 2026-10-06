'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { canManageAgent, type ActorRole } from '@nia/schemas';
import type { AgentSetup, AgentSetupRun, PlatformAgent } from '@/lib/agents/types';
import { listAgentsClient, listAgentSetupsClient } from '@/lib/api/agentsClient';
import { revokeAgentAction } from '@/lib/agents/actions';
import AddAgentDialog from './AddAgentDialog';
import RevokeAgentDialog from './RevokeAgentDialog';
import {
  nxAgentsAddBtnStyle,
  nxAgentsAvatarStyle,
  nxAgentsColumnHeaderRowStyle,
  nxAgentsEmptyJobsTextStyle,
  nxAgentsEmptyPanelStyle,
  nxAgentsEmptyStepNumStyle,
  nxAgentsEmptyStepStyle,
  nxAgentsEmptyTextStyle,
  nxAgentsExpandPanelStyle,
  nxAgentsExpandSectionLabelStyle,
  nxAgentsExpandToggleStyle,
  nxAgentsEyebrowStyle,
  nxAgentsH1Style,
  nxAgentsHeaderLeftColStyle,
  nxAgentsHeaderRowStyle,
  nxAgentsJobRowStyle,
  nxAgentsJobsHeaderRowStyle,
  nxAgentsLocalTagStyle,
  nxAgentsMetaCellStyle,
  nxAgentsNameStyle,
  nxAgentsRevokeBtnStyle,
  nxAgentsRowStyle,
  nxAgentsRunRowStyle,
  nxAgentsRunsHeaderRowStyle,
  nxAgentsStatCellStyle,
  nxAgentsStatLabelStyle,
  nxAgentsStatsGridStyle,
  nxAgentsStatusBadgeStyle,
  nxAgentsStatusDotStyle,
  nxAgentsStatValueStyle,
  nxAgentsSubtitleStyle,
  nxAgentsTitleColStyle,
} from './styles';

const POLL_INTERVAL_MS = 15_000;

function formatDate(iso: string | null | undefined): string {
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
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [setupsByAgent, setSetupsByAgent] = useState<
    Record<string, { setups: AgentSetup[]; runs: AgentSetupRun[] }>
  >({});

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

  // Slice L4 — lazily load an agent's local jobs/runs the first time its
  // row is expanded, same shape as the existing poll-on-mount pattern.
  function toggleExpanded(agentId: string) {
    setExpandedAgentId((current) => (current === agentId ? null : agentId));
    if (!setupsByAgent[agentId]) {
      listAgentSetupsClient(agentId)
        .then((result) => setSetupsByAgent((prev) => ({ ...prev, [agentId]: result })))
        .catch(() => {
          // Leave the panel showing "no jobs" rather than erroring the page.
        });
    }
  }

  const onlineCount = agents.filter((a) => a.online && a.status !== 'revoked').length;
  const revokedCount = agents.filter((a) => a.status === 'revoked').length;
  const loadedSetups = Object.values(setupsByAgent);
  const localJobsCount = loadedSetups.length
    ? loadedSetups.reduce((sum, { setups }) => sum + setups.filter((s) => s.localJob !== null).length, 0)
    : null;

  return (
    <>
      <div className="nx-fade-up" style={nxAgentsHeaderRowStyle}>
        <div style={nxAgentsHeaderLeftColStyle}>
          <div style={nxAgentsTitleColStyle}>
            <span className="nx-clip-line" style={nxAgentsEyebrowStyle}>Platform</span>
            <h1 className="nx-clip-line" style={{ ...nxAgentsH1Style, animationDelay: '80ms' }}>Agents</h1>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <p style={nxAgentsSubtitleStyle}>Machines paired to run jobs for this workspace.</p>
            {canPair && (
              <button
                type="button"
                className="nx-wipe"
                style={{ ...nxAgentsAddBtnStyle(false), '--wipe-fill': 'var(--nx-ink)', '--wipe-on': 'var(--nx-bg)' } as CSSProperties}
                onClick={() => setAddOpen(true)}
              >
                Add agent
              </button>
            )}
          </div>
        </div>
        <div style={nxAgentsStatsGridStyle}>
          <div style={nxAgentsStatCellStyle(false)}>
            <span style={nxAgentsStatLabelStyle}>Agents</span>
            <span style={nxAgentsStatValueStyle}>{agents.length}</span>
          </div>
          <div style={nxAgentsStatCellStyle(true)}>
            <span style={nxAgentsStatLabelStyle}>Online</span>
            <span style={nxAgentsStatValueStyle}>{onlineCount}</span>
          </div>
          <div style={nxAgentsStatCellStyle(false)}>
            <span style={nxAgentsStatLabelStyle}>Local jobs</span>
            <span style={nxAgentsStatValueStyle}>{localJobsCount ?? '\u2014'}</span>
          </div>
          <div style={nxAgentsStatCellStyle(false)}>
            <span style={nxAgentsStatLabelStyle}>Revoked</span>
            <span style={nxAgentsStatValueStyle}>{revokedCount}</span>
          </div>
        </div>
      </div>

      {agents.length === 0 ? (
        <div className="nx-fade-up nx-halftone" style={nxAgentsEmptyPanelStyle}>
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
          <p style={nxAgentsEmptyTextStyle}>
            Don&apos;t have the agent installed yet?{' '}
            <a href="/downloads" style={{ color: 'var(--nx-ink)' }}>
              Download Nia Core Agent
            </a>
            . New to it? Read the{' '}
            <a href="/docs/agent/getting-started" style={{ color: 'var(--nx-ink)' }}>
              getting started guide
            </a>
            .
          </p>
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
            const badgeLabel = revoked
              ? 'Revoked'
              : agent.updateRequired
                ? 'Update required'
                : agent.online
                  ? 'Online'
                  : 'Offline';
            const badgeOk = agent.online && !revoked && !agent.updateRequired;
            const expanded = expandedAgentId === agent.id;
            const loaded = setupsByAgent[agent.id];
            const localJobs = (loaded?.setups ?? [])
              .map((s) => s.localJob)
              .filter((j): j is NonNullable<typeof j> => j !== null);
            const runs = loaded?.runs ?? [];
            const jobNameById = new Map(
              (loaded?.setups ?? []).map((s) => [s.id, s.localJob?.name ?? '\u2014'] as const),
            );
            return (
              <div key={agent.id}>
                <div style={nxAgentsRowStyle}>
                  <button
                    type="button"
                    className="nx-wipe"
                    style={{
                      ...nxAgentsExpandToggleStyle,
                      ...nxAgentsAvatarStyle,
                      '--wipe-fill': 'var(--nx-blue-panel)',
                      '--wipe-on': 'var(--nx-blue-panel-text)',
                    } as CSSProperties}
                    onClick={() => toggleExpanded(agent.id)}
                    aria-expanded={expanded}
                    aria-label={expanded ? 'Collapse agent jobs' : 'Expand agent jobs'}
                  >
                    {agent.displayName.slice(0, 1).toUpperCase() || '?'}
                  </button>
                  <span style={nxAgentsNameStyle}>{agent.displayName}</span>
                  <span style={nxAgentsStatusBadgeStyle(badgeOk)}>
                    <span style={nxAgentsStatusDotStyle(badgeOk)} />
                    {badgeLabel}
                  </span>
                  <span style={nxAgentsMetaCellStyle}>{formatDate(agent.lastCheckInAt)}</span>
                  <span style={nxAgentsMetaCellStyle}>{agent.agentVersion ?? '\u2014'}</span>
                  <span style={nxAgentsMetaCellStyle}>{agent.hostName ?? '\u2014'}</span>
                  <span style={nxAgentsMetaCellStyle}>{memberNames[agent.createdByUserId] ?? agent.createdByUserId}</span>
                  <span style={nxAgentsMetaCellStyle}>{formatDate(agent.createdAt)}</span>
                  {canRevoke && (
                    <button
                      type="button"
                      className="nx-wipe"
                      style={{ ...nxAgentsRevokeBtnStyle, '--wipe-fill': 'var(--nx-danger)', '--wipe-on': 'var(--nx-bg)' } as CSSProperties}
                      onClick={() => setRevokeTarget(agent)}
                    >
                      Revoke
                    </button>
                  )}
                </div>
                {expanded && (
                  <div style={nxAgentsExpandPanelStyle}>
                    <div>
                      <span style={nxAgentsExpandSectionLabelStyle}>Jobs set up on the agent machine</span>
                      {localJobs.length === 0 ? (
                        <p style={nxAgentsEmptyJobsTextStyle}>
                          {loaded ? 'No local jobs reported by this agent yet.' : 'Loading\u2026'}
                        </p>
                      ) : (
                        <>
                          <div style={nxAgentsJobsHeaderRowStyle}>
                            <span>Name</span>
                            <span>Source / destination</span>
                            <span>Mode</span>
                            <span>Schedule</span>
                            <span>State</span>
                            <span>Last run</span>
                            <span>Next run</span>
                          </div>
                          {localJobs.map((job) => (
                            <div key={job.id} style={nxAgentsJobRowStyle}>
                              <span style={nxAgentsNameStyle}>
                                {job.name}
                                <span style={nxAgentsLocalTagStyle}>Local</span>
                              </span>
                              <span style={nxAgentsMetaCellStyle}>
                                {job.sourceTable} &rarr; {job.destinationType}://{job.destinationHost}
                              </span>
                              <span style={nxAgentsMetaCellStyle}>{job.mode}</span>
                              <span style={nxAgentsMetaCellStyle}>{job.schedule ?? '\u2014'}</span>
                              <span style={nxAgentsStatusBadgeStyle(job.state === 'ok')}>
                                <span style={nxAgentsStatusDotStyle(job.state === 'ok')} />
                                {job.state}
                                {job.errorClass ? ` (${job.errorClass})` : ''}
                              </span>
                              <span style={nxAgentsMetaCellStyle}>{formatDate(job.lastRunAt)}</span>
                              <span style={nxAgentsMetaCellStyle}>{formatDate(job.nextRunAt)}</span>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                    <div>
                      <span style={nxAgentsExpandSectionLabelStyle}>Recent runs</span>
                      {runs.length === 0 ? (
                        <p style={nxAgentsEmptyJobsTextStyle}>
                          {loaded ? 'No runs reported yet.' : 'Loading\u2026'}
                        </p>
                      ) : (
                        <>
                          <div style={nxAgentsRunsHeaderRowStyle}>
                            <span>Job</span>
                            <span>Status</span>
                            <span>Rows sent</span>
                            <span>Deleted</span>
                            <span>Parts</span>
                            <span>Started</span>
                            <span>Finished</span>
                          </div>
                          {runs.map((run) => (
                            <div key={run.id} style={nxAgentsRunRowStyle}>
                              <span style={nxAgentsMetaCellStyle}>{jobNameById.get(run.agentSetupId) ?? '\u2014'}</span>
                              <span style={nxAgentsStatusBadgeStyle(run.status === 'ok')}>
                                <span style={nxAgentsStatusDotStyle(run.status === 'ok')} />
                                {run.status}
                                {run.errorClass ? ` (${run.errorClass})` : ''}
                              </span>
                              <span style={nxAgentsMetaCellStyle}>{run.rowsSent}</span>
                              <span style={nxAgentsMetaCellStyle}>{run.rowsDeleted}</span>
                              <span style={nxAgentsMetaCellStyle}>{run.parts}</span>
                              <span style={nxAgentsMetaCellStyle}>{formatDate(run.startedAt)}</span>
                              <span style={nxAgentsMetaCellStyle}>{formatDate(run.finishedAt)}</span>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
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
