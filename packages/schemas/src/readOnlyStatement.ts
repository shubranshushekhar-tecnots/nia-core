/**
 * Learning-mode Layer 1 (docs/plans/learning-mode.md) — copy-ready
 * `CREATE ROLE`/`CREATE USER`/`createUser()` statement text for the
 * "Need a read-only user?" helper in AddConnectionDialog. Same pure,
 * dialect-switched string generation contract as writeGrantStatement.ts:
 * never touches a connection, Vault, or the connections table itself —
 * the generated statement is meant to be copy-pasted by the user and run
 * directly against their own database with whatever admin credential they
 * already have. Nia never runs it for them.
 *
 * Unlike the write-grant statement (scoped to a single destination
 * namespace chosen on a canvas node), a read-only credential is set up
 * before any table/schema has been picked — so this defaults to the
 * common case ("public" for Postgres/Supabase, the whole database for
 * MySQL/MongoDB) and, for Postgres/Supabase only, accepts additional
 * schemas the caller already knows about (buildReadOnlyStatementOptions.
 * extraSchemas) rather than trying to guess at every schema in the
 * database.
 */
import { mysqlAdapter } from "./ops/dialects/mysql.js";
import { postgresAdapter } from "./ops/dialects/postgres.js";

export type ReadOnlyStatementDialect = "postgres" | "mysql" | "mongodb";

function dialectForConnector(connectorId: string): ReadOnlyStatementDialect | undefined {
  if (connectorId === "supabase") return "postgres";
  if (connectorId === "postgres") return "postgres";
  if (connectorId === "mysql") return "mysql";
  if (connectorId === "mongodb") return "mongodb";
  return undefined;
}

/** Single-quoted SQL string literal, doubling embedded `'` — used for password literals only (never interpolated as an identifier). Mirrors writeGrantStatement.ts's quoteLiteral. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// roleUser/rolePassword are always Nia-generated (never a value the caller
// typed freely) — restricting them to a fixed character set up front means
// we never have to trust a single dialect's literal-escaping rules to be
// airtight. This matters in particular for MySQL, where backslash is a
// string-literal escape character by default: doubling `'` alone (as
// quoteLiteral does) is NOT sufficient to make an arbitrary string safe to
// interpolate into a MySQL string literal, because a trailing `\` can
// "eat" the closing quote regardless of quote-doubling. Validating the
// character set here removes the need to reason about that per dialect.
const ROLE_USER_PATTERN = /^[A-Za-z0-9_]+$/;
const ROLE_PASSWORD_PATTERN = /^[A-Za-z0-9]+$/;

export type BuildReadOnlyStatementOptions = {
  /**
   * Additional Postgres/Supabase schemas beyond "public" to grant USAGE +
   * SELECT (+ matching ALTER DEFAULT PRIVILEGES) on. Ignored for mysql
   * (already database-wide) and mongodb (already database-wide).
   */
  extraSchemas?: string[];
};

/**
 * Returns null when the connector has no known SQL/shell dialect yet (same
 * contract as buildGrantStatementText) — callers should fall back to a
 * plain "ask your database admin" message rather than render nothing
 * silently.
 */
export function buildReadOnlyStatementText(
  connectorId: string,
  database: string,
  roleUser: string,
  rolePassword: string,
  options: BuildReadOnlyStatementOptions = {},
): string | null {
  if (!ROLE_USER_PATTERN.test(roleUser)) {
    throw new Error(`Invalid read-only role/user name "${roleUser}": must match ${ROLE_USER_PATTERN}.`);
  }
  if (!ROLE_PASSWORD_PATTERN.test(rolePassword)) {
    throw new Error(`Invalid read-only role password: must match ${ROLE_PASSWORD_PATTERN}.`);
  }

  const dialect = dialectForConnector(connectorId);
  if (!dialect) return null;

  if (dialect === "postgres") {
    const role = postgresAdapter.quoteIdent(roleUser);
    const db = postgresAdapter.quoteIdent(database);
    const schemaNames = ["public", ...(options.extraSchemas ?? [])];
    const lines = [
      `-- Run against the target database with an admin/owner credential.`,
      `CREATE ROLE ${role} WITH LOGIN PASSWORD ${quoteLiteral(rolePassword)};`,
      `-- Belt-and-suspenders: blocks this role from writing even if a future`,
      `-- GRANT is added to it by mistake.`,
      `ALTER ROLE ${role} SET default_transaction_read_only = on;`,
      `GRANT CONNECT ON DATABASE ${db} TO ${role};`,
    ];
    for (const schemaName of schemaNames) {
      const schema = postgresAdapter.quoteIdent(schemaName);
      // A `--` comment only extends to the next line break, so a raw CR/LF
      // in a user-supplied schema name could otherwise close the comment
      // early and turn whatever follows on the "same" logical line into an
      // executable statement. Strip CR/LF before this is the only place in
      // the file where an unquoted, user-supplied value is interpolated
      // into a comment rather than through quoteIdent/quoteLiteral/JSON.stringify.
      const commentSafeSchemaName = schemaName.replace(/[\r\n]/g, " ");
      lines.push(
        `GRANT USAGE ON SCHEMA ${schema} TO ${role};`,
        `GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role};`,
        `-- Only covers tables created *after* this point by whichever role runs`,
        `-- this ALTER DEFAULT PRIVILEGES statement (this admin credential) —`,
        `-- tables created by a different role, or that already exist, need the`,
        `-- GRANT SELECT ON ALL TABLES line above re-run for schema ${commentSafeSchemaName}`,
        `-- whenever a new one shows up returning 0 rows.`,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT ON TABLES TO ${role};`,
      );
    }
    return lines.join("\n");
  }

  if (dialect === "mysql") {
    const role = mysqlAdapter.quoteIdent(roleUser);
    const db = mysqlAdapter.quoteIdent(database);
    return [
      `-- Run against the target database with an admin credential.`,
      `-- '%' allows connecting from any host — if you know Nia's outbound IP,`,
      `-- restrict it here (e.g. '203.0.113.10') instead of '%'.`,
      `CREATE USER ${role}@'%' IDENTIFIED BY ${quoteLiteral(rolePassword)};`,
      `GRANT SELECT ON ${db}.* TO ${role}@'%';`,
    ].join("\n");
  }

  // mongodb
  return [
    `// Run in mongosh, connected as an admin on the target database.`,
    `// Using MongoDB Atlas? createUser is usually disabled from mongosh there.`,
    `// Instead: Atlas -> Database Access -> Add New Database User -> built-in`,
    `// role "read" scoped to database ${JSON.stringify(database)}. Skip the`,
    `// statement below.`,
    `db.getSiblingDB(${JSON.stringify(database)}).createUser({`,
    `  user: ${JSON.stringify(roleUser)},`,
    `  pwd: ${JSON.stringify(rolePassword)},`,
    `  roles: [{ role: "read", db: ${JSON.stringify(database)} }],`,
    `});`,
  ].join("\n");
}

/**
 * A source/read username the user pastes in (either typed directly or via
 * AddConnectionDialog's "paste connection URL" convenience field) already
 * carries its Supabase pooler project ref when qualified, e.g.
 * "postgres.abcdefghijkl" — same convention as
 * services/connector-supabase/src/poolerUsername.ts's extractProjectRef,
 * duplicated here (not imported: packages/schemas doesn't depend on a
 * connector service) since it's a single trivial string operation, same
 * precedent as NodeDrawer.tsx/explainWriteGrant.ts's independent
 * randomWriteRoleUser copies.
 */
export function extractProjectRefFromUsername(pastedUsername: string): string | undefined {
  const dotIndex = pastedUsername.indexOf(".");
  return dotIndex === -1 ? undefined : pastedUsername.slice(dotIndex + 1);
}

/**
 * Suggests the username to show/prefill for a newly generated read-only
 * role: qualified as "<roleUser>.<projectRef>" when a ref could be derived
 * from a pasted connection-string username, otherwise the bare role name
 * (the caller is responsible for showing the manual pooler-qualification
 * instruction in that case — see docs/plans/learning-mode.md).
 */
export function suggestReadOnlyUsername(roleUser: string, pastedUsername?: string): string {
  if (!pastedUsername) return roleUser;
  const projectRef = extractProjectRefFromUsername(pastedUsername);
  return projectRef ? `${roleUser}.${projectRef}` : roleUser;
}
