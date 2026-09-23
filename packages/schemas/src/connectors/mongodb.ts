import type { ConnectorManifest } from "../manifest.js";

/**
 * connector-mongodb's contract mirrors connector-mysql's: `config` jsonb
 * (host/port/database — SSRF-validatable, non-secret) plus a Vault-resolved
 * `user`/`password` fetched by the service itself. Reads stay
 * pipeline-only (aggregation-pipeline, enforced by @nia/guardrails's
 * validateMongoPipeline before dispatch).
 *
 * `operations` includes "read" and "insert" (Item 6.3, fix-chain plan, same
 * rationale as mysql.ts): actual write execution still dispatches via
 * dispatchWrite()/entity+upsertKeys (connector-mongodb/src/index.ts's POST
 * /write, Phase 6 Block 5 — batch bulkWrite replaceOne upserts, HMAC-checked
 * write context + grant re-check), not a per-op mongo command — but
 * `operations` is also what NodeDrawer.tsx's verb-radio (operationsForRole)
 * and mapping.ts's initialOperation resolve against once a node is placed as
 * a destination. `capabilities` already includes "etl_sink", so a mongodb
 * connection is already offered as a destination in NodesRail.tsx's palette;
 * leaving `operations` at `["read"]` left that destination node with no
 * initial operation and a verb-radio that fell back to showing "read" as a
 * destination's only (nonsensical) verb.
 */
export const mongodbManifest: ConnectorManifest = {
  id: "mongodb",
  name: "MongoDB",
  version: "0.0.1",
  category: "database",
  auth: { method: "credentials" },
  configSchema: [
    { key: "host", label: "Host", type: "text", required: true, placeholder: "cluster.example.com", secret: false },
    { key: "port", label: "Port", type: "number", required: true, placeholder: "27017", secret: false },
    { key: "database", label: "Database", type: "text", required: true, placeholder: "sandbox", secret: false },
    { key: "user", label: "Username", type: "text", required: true, placeholder: "nia_ro", secret: true },
    { key: "password", label: "Password", type: "password", required: true, secret: true },
  ],
  operations: ["read", "insert"],
  capabilities: ["queryable", "etl_source", "etl_sink"],
  service: { host: "connector-mongodb", port: 4020 },
};
