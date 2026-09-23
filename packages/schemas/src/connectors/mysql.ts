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
 * `operations` includes "read" and "insert" (Item 6.3, fix-chain plan): the
 * actual write execution still dispatches via dispatchWrite()/entity+
 * upsertKeys (connector-mysql/src/index.ts's POST /write, batch upsert via
 * `ON DUPLICATE KEY UPDATE`, HMAC-checked write context + grant re-check),
 * not through a per-op SQL statement — but the operations array is also what
 * NodeDrawer.tsx's verb-radio (operationsForRole) and mapping.ts's
 * initialOperation resolve against once a node is placed as a destination.
 * `capabilities` already includes "etl_sink" (Phase 6 Block 5), so a mysql
 * connection is already offered as a destination in NodesRail.tsx's palette;
 * leaving `operations` at `["read"]` left that destination node with no
 * initial operation and a verb-radio that fell back to showing "read" as a
 * destination's only (nonsensical) verb. Matches connector-supabase's/
 * connector-postgres's `operations: ["read", "insert"]` shape — an earlier
 * version of this comment claimed parity with connector-supabase keeping
 * `operations: ["read"]`, which was stale/inaccurate even before this change.
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
  operations: ["read", "insert"],
  capabilities: ["queryable", "etl_source", "etl_sink"],
  service: { host: "connector-mysql", port: 4010 },
};
