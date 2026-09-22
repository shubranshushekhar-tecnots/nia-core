/**
 * Phase 6 Block 5 — copy-ready `CREATE ROLE`/`GRANT` statement text for the
 * write-grant creation UI. Pure, dialect-switched string generation only —
 * this never touches Vault, a connection, or the write_grants table itself
 * (that's apps/api/src/services/grants.ts). The generated statement is meant
 * to be copy-pasted by the user and run directly against their own database
 * with whatever admin credential they already have; Nia never runs it for
 * them (no connector today has an admin-level operation, only read/write
 * verbs scoped to a role that already exists).
 *
 * Only `supabase`/`postgres` (both Postgres, see connectors/supabase.ts's
 * header comment) are actual etl_sinks today — mysql/mongodb stay
 * etl_source-only, read-only connectors. Statement text is still generated
 * for all dialects here so the UI's copy is correct the day a connector's
 * `operations` grows write verbs, without this file needing a second pass
 * — see docs/decisions.md's Block 4->5 correction entry.
 *
 * Phase 8a: identifier quoting for postgres/mysql now delegates to
 * mysqlAdapter/postgresAdapter's quoteIdent (packages/schemas/src/ops/
 * dialects/*) instead of this file's own quotePgIdent/quoteMysqlIdent
 * duplicates — same quoting bodies, one fewer copy. quoteLiteral (DDL
 * string-literal quoting for password text) stays local: it's specific to
 * copy-paste DDL generation, not a general op-emission primitive, so it's
 * not part of SqlDialectAdapter. WriteGrantStatementDialect stays its own
 * enum (not unified with SourceDialect/manifestDialect's "mongo" naming)
 * — flagged as a possible follow-up rename in the Phase 8a plan, not
 * executed here since it touches this otherwise-unrelated, currently-
 * passing file.
 */
import { mysqlAdapter } from "./ops/dialects/mysql.js";
import { postgresAdapter } from "./ops/dialects/postgres.js";

export type WriteGrantStatementDialect = "postgres" | "mysql" | "mongodb";

function dialectForConnector(connectorId: string): WriteGrantStatementDialect | undefined {
  if (connectorId === "supabase") return "postgres";
  if (connectorId === "postgres") return "postgres";
  if (connectorId === "mysql") return "mysql";
  if (connectorId === "mongodb") return "mongodb";
  return undefined;
}

/** Single-quoted SQL string literal, doubling embedded `'` — used for password literals only (never interpolated as an identifier). */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Returns null when the connector has no known SQL/shell grant dialect yet
 * (an unrecognized connector id) — callers should fall back to a plain
 * "ask your database admin" message rather than render nothing silently.
 */
export function buildGrantStatementText(
  connectorId: string,
  namespace: string,
  roleUser: string,
  rolePassword: string,
): string | null {
  const dialect = dialectForConnector(connectorId);
  if (!dialect) return null;

  if (dialect === "postgres") {
    const role = postgresAdapter.quoteIdent(roleUser);
    const schema = postgresAdapter.quoteIdent(namespace);
    return [
      `-- Run against the target database with an admin/owner credential.`,
      `CREATE ROLE ${role} WITH LOGIN PASSWORD ${quoteLiteral(rolePassword)};`,
      `GRANT USAGE ON SCHEMA ${schema} TO ${role};`,
      `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ${schema} TO ${role};`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE ON TABLES TO ${role};`,
    ].join("\n");
  }

  if (dialect === "mysql") {
    const role = mysqlAdapter.quoteIdent(roleUser);
    const db = mysqlAdapter.quoteIdent(namespace);
    return [
      `-- Run against the target database with an admin credential.`,
      `CREATE USER ${role}@'%' IDENTIFIED BY ${quoteLiteral(rolePassword)};`,
      `GRANT SELECT, INSERT, UPDATE ON ${db}.* TO ${role}@'%';`,
      `FLUSH PRIVILEGES;`,
    ].join("\n");
  }

  // mongodb
  return [
    `// Run in mongosh, connected as an admin on the target database.`,
    `db.getSiblingDB(${JSON.stringify(namespace)}).createUser({`,
    `  user: ${JSON.stringify(roleUser)},`,
    `  pwd: ${JSON.stringify(rolePassword)},`,
    `  roles: [{ role: "readWrite", db: ${JSON.stringify(namespace)} }],`,
    `});`,
  ].join("\n");
}
