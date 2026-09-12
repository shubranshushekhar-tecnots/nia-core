import type { ConnectorManifest } from "../manifest.js";

/**
 * connector-supabase's contract mirrors connector-mysql's: `config` jsonb
 * (host/port/database — SSRF-validatable, non-secret) plus a Vault-resolved
 * `user`/`password` fetched by the service itself
 * (services/connector-supabase/src/pool-manager.ts). Targets direct
 * Postgres access — "supabase" as the manifest id/category framing (not
 * Supabase's REST/PostgREST API), since a hosted Supabase project's
 * database is exactly a Postgres instance reachable this way.
 *
 * `ssl` is an extra, non-secret config field beyond MySQL/MongoDB's
 * template: real hosted Supabase Postgres instances require TLS, so
 * without this the connector would be unusable against its own namesake
 * target. Off by default (matches the mysql/mongo dev-container pattern of
 * a plaintext scratch DB); users pointing at a real Supabase project set
 * it to true.
 *
 * Read-only v1, matching MySQL/MongoDB's current stance — only "read" is
 * listed in `operations`, enforced by @nia/guardrails's
 * validatePostgresQuery before dispatch. capabilities is
 * ["queryable","etl_source"] only — no "etl_sink" for a read-only connector.
 */
export const supabaseManifest: ConnectorManifest = {
  id: "supabase",
  name: "Supabase (Postgres)",
  version: "0.0.1",
  category: "database",
  auth: { method: "credentials" },
  configSchema: [
    { key: "host", label: "Host", type: "text", required: true, placeholder: "db.project.supabase.co", secret: false },
    { key: "port", label: "Port", type: "number", required: true, placeholder: "5432", secret: false },
    { key: "database", label: "Database", type: "text", required: true, placeholder: "postgres", secret: false },
    { key: "ssl", label: "Use TLS", type: "boolean", required: false, secret: false },
    { key: "user", label: "Username", type: "text", required: true, placeholder: "nia_ro", secret: true },
    { key: "password", label: "Password", type: "password", required: true, secret: true },
  ],
  operations: ["read"],
  capabilities: ["queryable", "etl_source"],
  service: { host: "connector-supabase", port: 4030 },
};
