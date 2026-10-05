import type { ConnectorManifest } from "../manifest.js";

/**
 * Slice R1 — "Planometry table" destination. One table = one push-URL +
 * one push key (docs/planometry/connector-guide-v4.md §1-§2), matching
 * apps/agent's own planometry/client.ts wire shape 1:1 (GET {address} ->
 * ConnectionCheckResult, GET {address}/schema -> TableSchema) — that file
 * is read here only as a reference, never imported, since apps/agent is
 * owned by a different slice of work.
 *
 * Unlike sqlserver_agent's manifest, this one's Test/Browse are answered
 * directly by apps/api calling Planometry's own HTTPS API (see
 * apps/api/src/lib/planometryClient.ts) — `service` below only matters for
 * requirement 4: the bridge's internal listener decides by connector_id
 * that /write and /execute for this type are agent-delivered, never
 * platform-dispatched.
 */
export const planometryTableManifest: ConnectorManifest = {
  id: "planometry-table",
  name: "Planometry table",
  version: "0.0.1",
  category: "bi",
  auth: { method: "credentials" },
  configSchema: [
    { key: "address", label: "Table address", type: "text", required: true, placeholder: "https://app.planometry.com/api/push/...", secret: false },
    { key: "pushKey", label: "Push key", type: "password", required: true, secret: true },
  ],
  operations: ["push_dataset"],
  // "etl_sink" only (no "etl_source") — destination-only, per NodesRail.tsx's
  // buildEntries() capability-driven role derivation.
  capabilities: ["etl_sink"],
  service: { host: "agent-bridge", port: 4041 },
};
