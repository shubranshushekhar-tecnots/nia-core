import type { ConnectorManifest } from "../manifest.js";

/**
 * connector-mysql's real contract (services/connector-mysql/src/pool-manager.ts):
 * getPool() composes a mysql2 pool from two sources — the connection's `config`
 * jsonb (host/port/database, passed through by Express on every dispatch) and
 * `resolveVaultSecret(vaultRef) -> { user, password }` (fetched by the service
 * itself, never by Express). Only `user`/`password` are `secret: true` here;
 * host/port/database are non-secret and live in Postgres so they can be
 * SSRF-validated at save/connect time and displayed without a Vault round trip.
 *
 * Only "read" is listed in `operations` — connector-mysql's /execute endpoint
 * runs whatever dialect-native query the worker sends, and the ETL write path
 * (Phase 6 Block 5) dispatches writes directly via dispatchWrite()/entity+
 * upsertKeys, not through the operations-radio-driven action-node mechanism
 * (same pattern as connector-supabase, which also keeps operations:["read"]
 * despite having a working /write). `capabilities` does carry "etl_sink" now
 * that connector-mysql/src/index.ts exposes POST /write (batch upsert via
 * `ON DUPLICATE KEY UPDATE`, HMAC-checked write context + grant re-check).
 */
export const mysqlManifest: ConnectorManifest = {
  id: "mysql",
  name: "MySQL",
  version: "0.0.1",
  category: "database",
  auth: { method: "credentials" },
  configSchema: [
    { key: "host", label: "Host", type: "text", required: true, placeholder: "db.example.com", secret: false },
    { key: "port", label: "Port", type: "number", required: true, placeholder: "3306", secret: false },
    { key: "database", label: "Database", type: "text", required: true, placeholder: "sandbox", secret: false },
    { key: "user", label: "Username", type: "text", required: true, placeholder: "nia_ro", secret: true },
    { key: "password", label: "Password", type: "password", required: true, secret: true },
  ],
  operations: ["read"],
  capabilities: ["queryable", "etl_source", "etl_sink"],
  service: { host: "connector-mysql", port: 4010 },
};
