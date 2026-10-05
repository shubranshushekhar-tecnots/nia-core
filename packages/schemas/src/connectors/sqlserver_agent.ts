import type { ConnectorManifest } from "../manifest.js";

/**
 * Slice C1 — "Local database (via agent)". Unlike every other manifest,
 * this one has no credentials of its own at all: `agentId` and
 * `agentConnectionId` are non-secret pointers into platform_agents /
 * agent_reported_connections, resolved and re-verified by the bridge's
 * internal listener on every /test or /introspect call (never trusted
 * as-is from this config payload — see services/agent-bridge/src/
 * internalApp.ts's resolveAgentConnection()). Both fields are `type:
 * "select"` with no static `options` here — apps/web renders a dedicated
 * picker (agent dropdown, then that agent's reported-connections dropdown)
 * instead of ConnectionForm.tsx's generic inputType() renderer.
 *
 * service.{host,port} point at the bridge's *internal* listener (never the
 * public 4040 one apps/agent's CLI pairs/checks in against) — reachable
 * container-to-container in Docker regardless of docker-compose.yml's
 * `ports:` publishing (that only gates host access), and reachable at
 * localhost in the e2e/dev-process topology where agent-bridge binds
 * directly to the host. connectorDispatch.ts's existing CONNECTOR_DEV_HOST
 * override already covers "same port, different host" for local dev —
 * no separate env var needed.
 */
export const sqlserverAgentManifest: ConnectorManifest = {
  // Hyphen, not underscore — connector_installs.connector_id has a DB check
  // constraint (0007_connectors.sql) of `^[a-z0-9-]+$`, which forbids
  // underscores. Every other manifest id is a single word so this never
  // surfaced until Slice C1's own "Access" integration test actually tried
  // to insert a connector_installs row for this connector.
  id: "sqlserver-agent",
  name: "Local database (via agent)",
  version: "0.0.1",
  category: "database",
  auth: { method: "credentials" },
  configSchema: [
    { key: "agentId", label: "Agent", type: "select", required: true, secret: false },
    { key: "agentConnectionId", label: "Local connection", type: "select", required: true, secret: false },
  ],
  operations: ["read"],
  capabilities: ["queryable"],
  service: { host: "agent-bridge", port: 4041 },
};
