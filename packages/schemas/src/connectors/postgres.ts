import type { ConnectorManifest } from "../manifest.js";

/**
 * Sibling of supabase.ts, same service, different kind. connector-supabase's
 * pool-manager.ts already builds pools from generic {host,port,database,ssl}
 * config + a Vault-resolved {user,password} — nothing Supabase-specific, so
 * this manifest reuses that exact service rather than needing its own.
 *
 * Why a separate manifest instead of just using "supabase" for plain
 * Postgres too: connector_id is stored on connections/connector_installs
 * (supabase/migrations/0007_connectors.sql) and read by the audit log —
 * "supabase" vs "postgres" as distinct connector_id values lets the UI and
 * audit trail tell "a real hosted Supabase project" apart from "some other
 * Postgres database" after the fact, even though both dispatch through the
 * same connector-supabase:4030 service today.
 *
 * configSchema/operations/capabilities intentionally mirror supabase.ts
 * exactly (see that file's header comment for the write-path rationale) —
 * this connector has no behavior of its own beyond the label.
 */
export const postgresManifest: ConnectorManifest = {
  id: "postgres",
  name: "PostgreSQL",
  version: "0.0.1",
  category: "database",
  auth: { method: "credentials" },
  configSchema: [
    { key: "host", label: "Host", type: "text", required: true, placeholder: "db.internal", secret: false },
    { key: "port", label: "Port", type: "number", required: true, placeholder: "5432", secret: false },
    { key: "database", label: "Database", type: "text", required: true, placeholder: "postgres", secret: false },
    { key: "ssl", label: "Use TLS", type: "boolean", required: false, secret: false },
    { key: "user", label: "Username", type: "text", required: true, placeholder: "nia_ro", secret: true },
    { key: "password", label: "Password", type: "password", required: true, secret: true },
  ],
  operations: ["read", "insert"],
  capabilities: ["queryable", "etl_source", "etl_sink"],
  service: { host: "connector-supabase", port: 4030 },
};
