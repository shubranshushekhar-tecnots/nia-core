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
 * Only `supabase` (Postgres) is an actual etl_sink today (see
 * connectors/supabase.ts's header comment) — mysql/mongodb stay
 * etl_source-only, read-only connectors. Statement text is still generated
 * for all three dialects here so the UI's copy is correct the day a
 * connector's `operations` grows write verbs, without this file needing a
 * second pass — see docs/decisions.md's Block 4->5 correction entry.
 */

export type WriteGrantStatementDialect = "postgres" | "mysql" | "mongodb";

function dialectForConnector(connectorId: string): WriteGrantStatementDialect | undefined {
  if (connectorId === "supabase") return "postgres";
  if (connectorId === "mysql") return "mysql";
  if (connectorId === "mongodb") return "mongodb";
  return undefined;
}

/**
 * Quotes a Postgres identifier by doubling embedded `"` — namespace/role
 * names here are either server-generated (`roleUser`) or came back from a
 * real schema introspection (`namespace`), never raw user free-text, but
 * this is cheap insurance against either containing a `"`.
 */
function quotePgIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function quoteMysqlIdent(ident: string): string {
  return `\`${ident.replace(/`/g, "``")}\``;
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
    const role = quotePgIdent(roleUser);
    const schema = quotePgIdent(namespace);
    return [
      `-- Run against the target database with an admin/owner credential.`,
      `CREATE ROLE ${role} WITH LOGIN PASSWORD ${quoteLiteral(rolePassword)};`,
      `GRANT USAGE ON SCHEMA ${schema} TO ${role};`,
      `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ${schema} TO ${role};`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE ON TABLES TO ${role};`,
    ].join("\n");
  }

  if (dialect === "mysql") {
    const role = quoteMysqlIdent(roleUser);
    const db = quoteMysqlIdent(namespace);
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
