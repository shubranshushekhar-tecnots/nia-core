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
 * target. Item 4.1 fix: defaults ON for real hosts (a stored/omitted `ssl`
 * value no longer silently means plaintext), defaults OFF only for known
 * local/sandbox hosts (localhost/127.0.0.1/host.docker.internal/*.internal
 * — matches the mysql/mongo dev-container pattern of a plaintext scratch
 * DB), and is forced ON regardless of the stored value for hosts matching
 * a known managed-Postgres provider (`*.neon.tech`, `*.supabase.co`,
 * `*.pooler.supabase.com`) — see
 * `services/connector-supabase/src/pool-manager.ts`'s `resolveSsl`.
 *
 * `operations` includes "read" and "insert" — mysql/mongodb stay
 * read-only for now (`operations: ["read"]`), but a Postgres-family
 * destination needs a write verb to unlock: NodeDrawer.tsx's Verb radio
 * only ever offers verbs listed here, and the write verb itself stays
 * locked in the UI (and re-checked server-side by checkGrants,
 * checks.ts) until the node's connection has a confirmed write grant
 * covering the selected table's namespace — enforced by
 * @nia/guardrails's validatePostgresQuery before dispatch.
 *
 * capabilities includes "etl_sink" (Phase 5 Session 3, approved scope):
 * this declares "a supabase connection can be placed as a DESTINATION node
 * in the canvas" and nothing more — capabilities gate palette/canvas
 * placement only (NodesRail.tsx's buildEntries), never write permission.
 * Real write execution stays governed by `operations` and the
 * WRITE_OPERATIONS tripwire (checkGrants, checks.ts) plus the write-grant
 * credential's actual DB privileges — a destination node with a write verb
 * selected but no active grant covering its namespace is configuration-only.
 * mysql/mongodb stay etl_source-only for now; this is otherwise the only
 * connector with a destination shape, needed to make checkDag's
 * source->destination path requirement and checkMappings exercisable
 * end-to-end (mysql -> supabase).
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
  operations: ["read", "insert"],
  capabilities: ["queryable", "etl_source", "etl_sink"],
  service: { host: "connector-supabase", port: 4030 },
};
