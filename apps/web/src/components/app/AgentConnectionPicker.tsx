'use client';

import { useEffect, useState } from 'react';
import { listAgentConnectionsClient, listAgentsClient } from '@/lib/api/agentsClient';
import type { AgentReportedConnection, PlatformAgent } from '@/lib/agents/types';
import { nxModalErrorStyle, nxModalFieldStyle, nxModalLabelStyle } from './styles';

/**
 * Slice C1 — the `sqlserver_agent` manifest's `agentId`/`agentConnectionId`
 * fields are both `type: "select"` with no static options (packages/schemas/
 * src/connectors/sqlserver_agent.ts's doc comment): this is the dedicated
 * picker ConnectionForm.tsx/EditConnectionDialog.tsx render instead of their
 * generic `inputType()` loop for those two keys. Plain <select name="...">
 * elements so the callers' existing FormData-based submission (Server Action
 * for create, manual FormData read for edit) picks the values up unchanged.
 */
export default function AgentConnectionPicker({
  idPrefix,
  initialAgentId,
  initialAgentConnectionId,
  fieldErrors,
}: {
  idPrefix: string;
  initialAgentId?: string;
  initialAgentConnectionId?: string;
  fieldErrors?: Record<string, string[]>;
}) {
  const [agents, setAgents] = useState<PlatformAgent[]>([]);
  const [agentId, setAgentId] = useState(initialAgentId ?? '');
  const [connections, setConnections] = useState<AgentReportedConnection[]>([]);
  const [agentConnectionId, setAgentConnectionId] = useState(initialAgentConnectionId ?? '');
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [loadingConnections, setLoadingConnections] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listAgentsClient()
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .finally(() => {
        if (!cancelled) setLoadingAgents(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!agentId) {
      setConnections([]);
      return;
    }
    let cancelled = false;
    setLoadingConnections(true);
    listAgentConnectionsClient(agentId)
      .then((list) => {
        if (cancelled) return;
        setConnections(list);
        // Only keep the previously-selected local connection if it's still
        // in this agent's current report — otherwise fall back to empty so
        // the user has to pick again rather than silently submitting a
        // stale id.
        setAgentConnectionId((current) => (list.some((c) => c.localConnectionId === current) ? current : ''));
      })
      .finally(() => {
        if (!cancelled) setLoadingConnections(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  return (
    <>
      <p style={{ margin: '0 0 4px', fontSize: 12, color: 'var(--nx-ink-3)' }}>
        Needs Nia Core Agent installed on a machine that can reach the database.{' '}
        <a href="/downloads" style={{ color: 'var(--nx-ink-2)' }}>
          Download
        </a>
        .
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label htmlFor={`${idPrefix}-field-agentId`} style={nxModalLabelStyle}>
          Agent
        </label>
        <select
          id={`${idPrefix}-field-agentId`}
          name="agentId"
          required
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="nx-modal-field"
          style={nxModalFieldStyle(Boolean(fieldErrors?.agentId))}
        >
          <option value="" disabled>
            {loadingAgents ? 'Loading agents…' : 'Select an agent'}
          </option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.displayName}
              {agent.status !== 'active' ? ` (${agent.status})` : agent.online ? '' : ' (offline)'}
            </option>
          ))}
        </select>
        {fieldErrors?.agentId && <span style={nxModalErrorStyle}>{fieldErrors.agentId[0]}</span>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label htmlFor={`${idPrefix}-field-agentConnectionId`} style={nxModalLabelStyle}>
          Local connection
        </label>
        <select
          id={`${idPrefix}-field-agentConnectionId`}
          name="agentConnectionId"
          required
          disabled={!agentId}
          value={agentConnectionId}
          onChange={(e) => setAgentConnectionId(e.target.value)}
          className="nx-modal-field"
          style={nxModalFieldStyle(Boolean(fieldErrors?.agentConnectionId))}
        >
          <option value="" disabled>
            {!agentId ? 'Select an agent first' : loadingConnections ? 'Loading connections…' : 'Select a connection'}
          </option>
          {connections.map((connection) => (
            <option key={connection.localConnectionId} value={connection.localConnectionId}>
              {connection.name} ({connection.databaseName})
            </option>
          ))}
        </select>
        {fieldErrors?.agentConnectionId && <span style={nxModalErrorStyle}>{fieldErrors.agentConnectionId[0]}</span>}
      </div>
    </>
  );
}
