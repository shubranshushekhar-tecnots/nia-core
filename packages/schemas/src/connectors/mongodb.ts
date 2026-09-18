import type { ConnectorManifest } from "../manifest.js";

/**
 * connector-mongodb's contract mirrors connector-mysql's: `config` jsonb
 * (host/port/database — SSRF-validatable, non-secret) plus a Vault-resolved
 * `user`/`password` fetched by the service itself. Reads stay
 * pipeline-only (aggregation-pipeline, enforced by @nia/guardrails's
 * validateMongoPipeline before dispatch) — only "read" is listed in
 * `operations`, matching MySQL's/Supabase's stance (the ETL write path
 * dispatches directly via dispatchWrite()/entity+upsertKeys, not through
 * the operations-radio action-node mechanism).
 *
 * capabilities now carries "etl_sink": connector-mongodb/src/index.ts
 * exposes POST /write (Phase 6 Block 5 — batch bulkWrite replaceOne
 * upserts, HMAC-checked write context + grant re-check, same contract as
 * the SQL dialects).
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
  operations: ["read"],
  capabilities: ["queryable", "etl_source", "etl_sink"],
  service: { host: "connector-mongodb", port: 4020 },
};
