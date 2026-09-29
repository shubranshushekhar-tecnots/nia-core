/**
 * Learning-mode Layer 2 (docs/plans/learning-mode.md) — the single,
 * hand-written source of truth for "Help with this step" panel copy.
 * Keyed by step (`HelpStepKey`, imported from appErrorMessages.ts so Layer 2
 * and Layer 3 can never drift out of key-naming sync) x connector
 * (`HelpConnectorId`, the manifest ids from connectors/registry.ts).
 *
 * Scope per step: `add-connection`/`read-only-user`/`test-connection` apply
 * to every connector (any connector can be a source and needs a login), but
 * `grant-write-access`/`confirm-access`/`revoke-access` only ever appear in
 * the UI for connectors that actually support a write operation today
 * (NodeDrawer.tsx only renders GrantAccessPanel/RevokeAccessPanel for a
 * destination node whose manifest declares a write operation). `WRITE_
 * CAPABLE_CONNECTOR_IDS` derives this from the manifests themselves (not a
 * second, hand-maintained list) so it can never drift if a connector's
 * `operations` changes — today all four connectors declare "insert" (Item
 * 6.3, fix-chain plan; see e.g. connectors/mysql.ts's header), so all four
 * have content here. `content.test.ts` asserts every (step, connector) pair
 * the real UI can reach has a section — never more, never fewer.
 *
 * Any SQL/shell statement a help section shows is never a duplicated
 * literal string: `sql` is a function that calls the exact same generator
 * function the real dialog/panel calls (`buildReadOnlyStatementText`/
 * `buildGrantStatementText`/`buildDropRoleStatementText`) — but it takes its
 * `HelpSqlValues` as a parameter rather than baking in placeholders itself.
 * This is deliberate: a real, currently-active credential must never be
 * shown next to a Copy button unless the caller actually supplied it (see
 * HelpPanel.tsx / resolveHelpSql.ts) — this file has no way to know whether
 * the value it's handed is a real generated credential or an illustrative
 * placeholder. `HELP_SQL_ILLUSTRATION_VALUES` below is the one place that
 * still defines fixed illustrative values, used only when the caller has no
 * real values to show. Because both the help copy and `content.test.ts` call
 * the identical generator function with the identical values, "the SQL shown
 * equals the generator output" holds by construction, not merely by a test
 * someone could forget to update.
 */
import { CONNECTOR_MANIFESTS } from "../connectors/registry.js";
import { WRITE_OPERATIONS } from "../manifest.js";
import { buildDropRoleStatementText, buildGrantStatementText } from "../writeGrantStatement.js";
import { buildReadOnlyStatementText } from "../readOnlyStatement.js";
import type { HelpStepKey } from "../appErrorMessages.js";

export type HelpConnectorId = "postgres" | "supabase" | "mysql" | "mongodb";

export const HELP_CONNECTOR_IDS: readonly HelpConnectorId[] = ["postgres", "supabase", "mysql", "mongodb"];

export const HELP_CONNECTOR_LABEL: Record<HelpConnectorId, string> = {
  postgres: "Postgres",
  supabase: "Supabase",
  mysql: "MySQL",
  mongodb: "MongoDB",
};

export const HELP_STEP_LABEL: Record<HelpStepKey, string> = {
  "add-connection": "Add connection",
  "read-only-user": "Read-only user",
  "test-connection": "Test connection",
  "grant-write-access": "Grant write access",
  "confirm-access": "Confirm access",
  "revoke-access": "Revoke access",
};

/**
 * Derived, not hand-maintained: a connector is write-capable here iff its
 * manifest declares at least one of manifest.ts's WRITE_OPERATIONS. Today
 * that's all four connectors (each declares "insert" — Item 6.3, fix-chain
 * plan), which is also why NodeDrawer.tsx's GrantAccessPanel/
 * RevokeAccessPanel can render for a mysql/mongodb destination node too.
 */
export const WRITE_CAPABLE_CONNECTOR_IDS: readonly HelpConnectorId[] = HELP_CONNECTOR_IDS.filter((id) => {
  const manifest = CONNECTOR_MANIFESTS[id];
  return manifest?.operations.some((op) => WRITE_OPERATIONS.includes(op)) ?? false;
});

/** Which connectors each step's UI can actually show help for. */
export const HELP_STEP_CONNECTORS: Record<HelpStepKey, readonly HelpConnectorId[]> = {
  "add-connection": HELP_CONNECTOR_IDS,
  "read-only-user": HELP_CONNECTOR_IDS,
  "test-connection": HELP_CONNECTOR_IDS,
  "grant-write-access": WRITE_CAPABLE_CONNECTOR_IDS,
  "confirm-access": WRITE_CAPABLE_CONNECTOR_IDS,
  "revoke-access": WRITE_CAPABLE_CONNECTOR_IDS,
};

/**
 * Same illustrative values across every connector's example SQL — obviously
 * placeholders (never the connection's real generated username/password),
 * and identical to what content.test.ts passes to the generators directly.
 */
export const HELP_SQL_PLACEHOLDERS = {
  database: "your_database",
  namespace: "public",
  readOnlyUser: "nia_ro_user",
  writeRoleUser: "nia_write_user",
  password: "REPLACEWITHGENERATEDPASSWORD",
} as const;

/**
 * Shared shape for every `HelpSection.sql` call — a superset of what any one
 * generator needs (e.g. `buildDropRoleStatementText` only uses `roleUser`),
 * so every step's `sql` has one consistent signature.
 */
export type HelpSqlValues = {
  database: string;
  namespace: string;
  roleUser: string;
  rolePassword: string;
};

/**
 * Fixed illustrative values (never a real generated credential) for the
 * steps that show SQL, used only when a caller has no real values to pass
 * `HelpSection.sql` — see resolveHelpSql.ts (apps/web) for how illustration
 * vs. real mode is chosen and why illustration mode never shows a Copy
 * button.
 */
export const HELP_SQL_ILLUSTRATION_VALUES: Partial<Record<HelpStepKey, HelpSqlValues>> = {
  "read-only-user": {
    database: HELP_SQL_PLACEHOLDERS.database,
    namespace: HELP_SQL_PLACEHOLDERS.namespace,
    roleUser: HELP_SQL_PLACEHOLDERS.readOnlyUser,
    rolePassword: HELP_SQL_PLACEHOLDERS.password,
  },
  "grant-write-access": {
    database: HELP_SQL_PLACEHOLDERS.database,
    namespace: HELP_SQL_PLACEHOLDERS.namespace,
    roleUser: HELP_SQL_PLACEHOLDERS.writeRoleUser,
    rolePassword: HELP_SQL_PLACEHOLDERS.password,
  },
  "revoke-access": {
    database: HELP_SQL_PLACEHOLDERS.database,
    namespace: HELP_SQL_PLACEHOLDERS.namespace,
    roleUser: HELP_SQL_PLACEHOLDERS.writeRoleUser,
    rolePassword: HELP_SQL_PLACEHOLDERS.password,
  },
};

export type HelpProblem = { problem: string; fix: string };

export type HelpSection = {
  what: string;
  why: string;
  how: string[];
  problems: HelpProblem[];
  /**
   * Only set for steps that show a copy-paste statement (read-only-user,
   * grant-write-access, revoke-access). Calling this is calling the same
   * generator the real dialog/panel calls — see file header. Takes explicit
   * values rather than baking any in, so this file can never accidentally
   * offer a Copy button backed by a shared placeholder.
   */
  sql?: (values: HelpSqlValues) => string | null;
};

type HelpContentTable = Record<HelpStepKey, Partial<Record<HelpConnectorId, HelpSection>>>;

export const HELP_CONTENT: HelpContentTable = {
  "add-connection": {
    postgres: {
      what: "Connect Nia to an existing Postgres database using a host, port, database name, and credentials.",
      why: "Nia reads (and later writes) rows through this connection, so it needs a real, reachable Postgres role — it never creates a database for you.",
      how: [
        "Enter the host and port your Postgres server listens on.",
        "Enter the database name to connect to.",
        "Enter a username and password for a role that can log in to that database.",
        "Turn on SSL if your server requires it (most managed Postgres does).",
        "Click Test to confirm Nia can reach it before saving.",
      ],
      problems: [
        { problem: "Connection times out or is refused.", fix: "Check the host and port are correct, and that this database allows inbound connections from Nia (firewall, security group, or allowlist)." },
        { problem: "Authentication failed.", fix: "Double-check the username and password — a copy-paste error or a rotated credential is the most common cause." },
        { problem: "Certificate/TLS error.", fix: "Toggle SSL to match what the server expects, or check that its certificate is valid and trusted." },
      ],
    },
    supabase: {
      what: "Connect Nia to a Supabase project's Postgres database through Supabase's connection pooler.",
      why: "Supabase fronts Postgres with a pooler (Supavisor) — most Supabase setups need the pooler connection string, not the direct database host.",
      how: [
        "From your Supabase project, copy the pooler connection string (Project Settings \u2192 Database \u2192 Connection pooling).",
        "Paste it in, or fill in host/port/database/username/password from it directly.",
        'Make sure the username is the qualified pooler form, e.g. "postgres.<project-ref>" \u2014 not just "postgres".',
        "Click Test to confirm Nia can reach it before saving.",
      ],
      problems: [
        { problem: '"Tenant or user not found" / "no tenant identifier provided".', fix: 'Use the pooler connection string\'s username, formatted "<role>.<project-ref>", not just the role name.' },
        { problem: "Authentication failed.", fix: "Double-check the username and password — a copy-paste error or a rotated credential is the most common cause." },
        { problem: "Row-Level Security blocks reads/writes later.", fix: "Expected on Supabase by default \u2014 see the Read-only user and Grant write access help for the policies each role needs." },
      ],
    },
    mysql: {
      what: "Connect Nia to an existing MySQL database using a host, port, database name, and credentials.",
      why: "Nia reads (and later writes) rows through this connection, so it needs a real, reachable MySQL user — it never creates a database for you.",
      how: [
        "Enter the host and port your MySQL server listens on.",
        "Enter the database name to connect to.",
        "Enter a username and password for a user that can log in from Nia's network.",
        "Click Test to confirm Nia can reach it before saving.",
      ],
      problems: [
        { problem: "Connection times out or is refused.", fix: "Check the host and port are correct, and that this database allows inbound connections from Nia (firewall, security group, or allowlist)." },
        { problem: "Access denied for user.", fix: "Double-check the username and password, and that the user's host is allowed to connect from where Nia runs (often '%')." },
        { problem: "Unknown database.", fix: "Double-check the database name for typos." },
      ],
    },
    mongodb: {
      what: "Connect Nia to an existing MongoDB database using a connection string (or host/port), database name, and credentials.",
      why: "Nia reads (and later writes) documents through this connection, so it needs a real, reachable MongoDB user with access to the chosen database.",
      how: [
        "Enter the connection string (or host/port) for your MongoDB deployment.",
        "Enter the database name to connect to.",
        "Enter a username and password for a user with access to that database.",
        "Click Test to confirm Nia can reach it before saving.",
      ],
      problems: [
        { problem: "Authentication failed / bad auth.", fix: "Double-check the username and password — a copy-paste error or a rotated credential is the most common cause." },
        { problem: "Host not found.", fix: "Double-check the host for typos, and that it resolves from where this runs." },
        { problem: "Connection refused (MongoDB Atlas).", fix: "Add Nia's outbound IP under Atlas \u2192 Network Access, and confirm the user exists under Atlas \u2192 Database Access." },
      ],
    },
  },

  "read-only-user": {
    postgres: {
      what: "A least-privilege Postgres role that can only SELECT from the schemas you choose — blocked from writing even by accident.",
      why: "Using a dedicated read-only role instead of your admin credential limits what a leaked or misused Nia connection could ever do.",
      how: [
        "Copy the statement below and run it against your database with an admin/owner credential.",
        "Use the generated username and password it creates when connecting this Nia connection.",
        'If you use schemas other than "public", add them so the role gets USAGE + SELECT there too.',
        "Re-run the GRANT SELECT line whenever a table is added by a different role — ALTER DEFAULT PRIVILEGES only covers tables created later by the role that ran it.",
      ],
      problems: [
        { problem: "New tables aren't visible to the read-only role.", fix: "ALTER DEFAULT PRIVILEGES only applies to tables created afterward by the same role that ran it — re-run the GRANT SELECT ON ALL TABLES line for that schema." },
        { problem: "Need another schema later.", fix: "Re-run this statement with the extra schema added — it's safe to run more than once." },
      ],
      sql: (v) => buildReadOnlyStatementText("postgres", v.database, v.roleUser, v.rolePassword),
    },
    supabase: {
      what: "A least-privilege Postgres role, qualified for Supabase's pooler, that can only SELECT from the schemas you choose.",
      why: "Same reasoning as Postgres — plus Supabase's Row-Level Security may still block reads for this role until a policy allows it.",
      how: [
        "Copy the statement below and run it in the Supabase SQL editor (or psql with an admin credential).",
        'Connect using the pooler-qualified username: "<generated-user>.<project-ref>", not just the generated user.',
        "If a table has Row-Level Security enabled, add a policy allowing this role to SELECT — the GRANT alone isn't enough.",
        "Re-run the GRANT SELECT line whenever a table is added by a different role.",
      ],
      problems: [
        { problem: "Reads return zero rows despite the GRANT.", fix: "Check for Row-Level Security on the table — add or adjust a policy allowing this role to SELECT." },
        { problem: '"Tenant or user not found" when connecting.', fix: 'Use the pooler connection string\'s username, formatted "<role>.<project-ref>", not just the role name.' },
      ],
      sql: (v) => buildReadOnlyStatementText("supabase", v.database, v.roleUser, v.rolePassword),
    },
    mysql: {
      what: "A least-privilege MySQL user that can only SELECT from the chosen database.",
      why: "Using a dedicated read-only user instead of your admin credential limits what a leaked or misused Nia connection could ever do.",
      how: [
        "Copy the statement below and run it against your database with an admin credential.",
        "Use the generated username and password it creates when connecting this Nia connection.",
        "If you know Nia's outbound IP, restrict the user's host to it instead of '%' for tighter access.",
      ],
      problems: [
        { problem: "Access denied when connecting with the new user.", fix: "Confirm the user's host ('%' or a specific IP) allows connections from where Nia runs." },
        { problem: "Unknown database when connecting.", fix: "Double-check the database name matches exactly what you ran the GRANT against." },
      ],
      sql: (v) => buildReadOnlyStatementText("mysql", v.database, v.roleUser, v.rolePassword),
    },
    mongodb: {
      what: 'A least-privilege MongoDB user with the built-in "read" role on the chosen database.',
      why: "Using a dedicated read-only user instead of your admin credential limits what a leaked or misused Nia connection could ever do.",
      how: [
        "On MongoDB Atlas, createUser from mongosh is usually disabled \u2014 instead go to Atlas \u2192 Database Access \u2192 Add New Database User and grant the built-in \"read\" role scoped to your database.",
        "Otherwise, copy the statement below and run it in mongosh, connected as an admin on the target database.",
        "Use the generated username and password when connecting this Nia connection.",
      ],
      problems: [
        { problem: '"not authorized on admin to execute command" when running createUser.', fix: "You're likely on Atlas \u2014 create the user from Atlas \u2192 Database Access instead of mongosh." },
        { problem: "Authentication failed with the new user.", fix: "Double-check the username, password, and that the user's role is scoped to the same database this connection uses." },
      ],
      sql: (v) => buildReadOnlyStatementText("mongodb", v.database, v.roleUser, v.rolePassword),
    },
  },

  "test-connection": {
    postgres: {
      what: "A live round-trip check that Nia can reach your database with the credentials you entered.",
      why: "Catches typos, network/firewall issues, and auth problems before you save the connection or build a workflow on it.",
      how: [
        "Click Test after filling in the connection fields.",
        "Wait for the result \u2014 a green check means Nia successfully connected.",
        "If it fails, read the fix line under the error, then adjust and test again.",
      ],
      problems: [
        { problem: "Connection timed out or refused.", fix: "Check the host and port, and that this database allows inbound connections from Nia." },
        { problem: "Authentication failed.", fix: "Double-check the username and password." },
        { problem: "Certificate/TLS error.", fix: "Check that the server's certificate is valid and trusted, or that the connection's SSL mode matches what the server expects." },
      ],
    },
    supabase: {
      what: "A live round-trip check that Nia can reach your Supabase project's database through the pooler.",
      why: "Catches typos, pooler-username mistakes, and auth problems before you save the connection or build a workflow on it.",
      how: [
        "Click Test after filling in the connection fields.",
        "Wait for the result \u2014 a green check means Nia successfully connected through the pooler.",
        "If it fails, read the fix line under the error, then adjust and test again.",
      ],
      problems: [
        { problem: '"Tenant or user not found" / "no tenant identifier provided".', fix: 'Use the pooler connection string\'s username, formatted "<role>.<project-ref>", not just the role name.' },
        { problem: "Authentication failed.", fix: "Double-check the username and password." },
        { problem: "Certificate/TLS error.", fix: "Check that the server's certificate is valid and trusted, or that the connection's SSL mode matches what the server expects." },
      ],
    },
    mysql: {
      what: "A live round-trip check that Nia can reach your database with the credentials you entered.",
      why: "Catches typos, network/firewall issues, and auth problems before you save the connection or build a workflow on it.",
      how: [
        "Click Test after filling in the connection fields.",
        "Wait for the result \u2014 a green check means Nia successfully connected.",
        "If it fails, read the fix line under the error, then adjust and test again.",
      ],
      problems: [
        { problem: "Connection timed out or refused.", fix: "Check the host and port, and that this database allows inbound connections from Nia." },
        { problem: "Access denied.", fix: "Double-check the username and password, and the user's allowed host ('%' or a specific IP)." },
        { problem: "Unknown database.", fix: "Double-check the database name for typos." },
      ],
    },
    mongodb: {
      what: "A live round-trip check that Nia can reach your database with the credentials you entered.",
      why: "Catches typos, network issues, and auth problems before you save the connection or build a workflow on it.",
      how: [
        "Click Test after filling in the connection fields.",
        "Wait for the result \u2014 a green check means Nia successfully connected.",
        "If it fails, read the fix line under the error, then adjust and test again.",
      ],
      problems: [
        { problem: "Authentication failed / bad auth.", fix: "Double-check the username and password." },
        { problem: "Host not found.", fix: "Double-check the host for typos, and that it resolves from where this runs." },
        { problem: "Connection refused (MongoDB Atlas).", fix: "Add Nia's outbound IP under Atlas \u2192 Network Access." },
      ],
    },
  },

  "grant-write-access": {
    postgres: {
      what: "A dedicated write role, scoped to one destination schema, that Nia uses only after you confirm it works.",
      why: "Scoping write access to a single schema (not your whole admin credential) limits blast radius if anything ever goes wrong in a run.",
      how: [
        "Copy the statement below and run it against your destination with an admin/owner credential.",
        'Come back and click "I\'ve run this \u2014 confirm access" so Nia can verify the role works.',
        'Nia also creates its own internal staging/quarantine table ("nia"."nia_quarantine") the first time \u2014 shared across every write grant on this database, not per-destination.',
      ],
      problems: [
        { problem: "Confirm fails right after running the statement.", fix: "Double-check the statement ran without error, and that you copied the exact generated username/password Nia is using to confirm." },
        { problem: "Need a different schema.", fix: "Revoke this grant and create a new one scoped to the schema you actually want." },
      ],
      sql: (v) => buildGrantStatementText("postgres", v.namespace, v.roleUser, v.rolePassword),
    },
    supabase: {
      what: "A dedicated write role, scoped to one destination schema, that Nia uses only after you confirm it works.",
      why: "Scoping write access to a single schema (not your whole admin credential) limits blast radius if anything ever goes wrong in a run.",
      how: [
        "Copy the statement below and run it in the Supabase SQL editor (or psql with an admin credential).",
        'Come back and click "I\'ve run this \u2014 confirm access" so Nia can verify the role works.',
        "The statement also creates a Row-Level Security policy allowing this role to use Nia's shared staging/quarantine table \u2014 required because Supabase enables RLS project-wide.",
      ],
      problems: [
        { problem: "Confirm fails right after running the statement.", fix: "Double-check the statement ran without error, and that you copied the exact generated username/password Nia is using to confirm." },
        { problem: '"Tenant or user not found" when confirming.', fix: 'The write credential also needs the pooler-qualified username, "<role>.<project-ref>".' },
      ],
      sql: (v) => buildGrantStatementText("supabase", v.namespace, v.roleUser, v.rolePassword),
    },
    mysql: {
      what: "A dedicated write user, scoped to one destination database, that Nia uses only after you confirm it works.",
      why: "Scoping write access to a single database (not your admin credential) limits blast radius if anything ever goes wrong in a run.",
      how: [
        "Copy the statement below and run it against your destination with an admin credential.",
        'Come back and click "I\'ve run this \u2014 confirm access" so Nia can verify the user works.',
        'Nia also creates its own internal staging/quarantine database ("nia") the first time \u2014 shared across every write grant on this server, not per-destination.',
      ],
      problems: [
        { problem: "Confirm fails right after running the statement.", fix: "Double-check the statement ran without error, and that you copied the exact generated username/password Nia is using to confirm." },
        { problem: "Need a different database.", fix: "Revoke this grant and create a new one scoped to the database you actually want." },
      ],
      sql: (v) => buildGrantStatementText("mysql", v.namespace, v.roleUser, v.rolePassword),
    },
    mongodb: {
      what: "A dedicated write user, scoped to one destination database, that Nia uses only after you confirm it works.",
      why: "Scoping write access to a single database (not your admin credential) limits blast radius if anything ever goes wrong in a run.",
      how: [
        "On MongoDB Atlas, createUser from mongosh is usually disabled \u2014 instead go to Atlas \u2192 Database Access \u2192 Add New Database User and grant the built-in \"readWrite\" role scoped to your database.",
        "Otherwise, copy the statement below and run it in mongosh, connected as an admin on the target database.",
        'Come back and click "I\'ve run this \u2014 confirm access" so Nia can verify the user works.',
      ],
      problems: [
        { problem: '"not authorized on admin to execute command" when running createUser.', fix: "You're likely on Atlas \u2014 create the user from Atlas \u2192 Database Access instead of mongosh." },
        { problem: "Confirm fails right after running the statement.", fix: "Double-check the statement ran without error, and that you copied the exact generated username/password Nia is using to confirm." },
        {
          problem: 'Staged (apply-from-staging) writes fail with "does not support staged writes".',
          fix: 'MongoDB destinations don\u2019t support staged writes yet \u2014 every connection is refused, regardless of your deployment. Set this destination\u2019s write mode to "direct" instead of the default "staged"; direct writes work for MongoDB today.',
        },
      ],
      sql: (v) => buildGrantStatementText("mongodb", v.namespace, v.roleUser, v.rolePassword),
    },
  },

  "confirm-access": {
    postgres: {
      what: "Verifies Nia can actually use the write role you just created, before marking the grant as active.",
      why: "Confirms the role exists, has the right privileges, and that Nia's write credential can log in \u2014 catching setup mistakes immediately instead of at run time.",
      how: [
        "Make sure you've already run the statement from the Grant write access step.",
        'Click "I\'ve run this \u2014 confirm access".',
        "Wait for the result \u2014 Nia test-connects with the write role and checks the grant.",
      ],
      problems: [
        { problem: "Confirm fails with a connection/auth error.", fix: "The role likely wasn't created successfully \u2014 re-check the statement ran without error against the right database." },
        { problem: "Confirm fails but the role exists.", fix: "The grant may already be confirmed or revoked \u2014 refresh its status before retrying." },
      ],
    },
    supabase: {
      what: "Verifies Nia can actually use the write role you just created, through the pooler, before marking the grant as active.",
      why: "Confirms the role exists, has the right privileges, and that Nia's write credential can log in through the pooler \u2014 catching setup mistakes immediately instead of at run time.",
      how: [
        "Make sure you've already run the statement from the Grant write access step.",
        'Click "I\'ve run this \u2014 confirm access".',
        "Wait for the result \u2014 Nia test-connects with the write role (pooler-qualified) and checks the grant.",
      ],
      problems: [
        { problem: '"Tenant or user not found" when confirming.', fix: 'The write credential needs the pooler-qualified username, "<role>.<project-ref>".' },
        { problem: "Confirm fails but the role exists.", fix: "The grant may already be confirmed or revoked \u2014 refresh its status before retrying." },
      ],
    },
    mysql: {
      what: "Verifies Nia can actually use the write user you just created, before marking the grant as active.",
      why: "Confirms the user exists, has the right privileges, and that Nia's write credential can log in \u2014 catching setup mistakes immediately instead of at run time.",
      how: [
        "Make sure you've already run the statement from the Grant write access step.",
        'Click "I\'ve run this \u2014 confirm access".',
        "Wait for the result \u2014 Nia test-connects with the write user and checks the grant.",
      ],
      problems: [
        { problem: "Confirm fails with a connection/auth error.", fix: "The user likely wasn't created successfully \u2014 re-check the statement ran without error against the right database." },
        { problem: "Confirm fails but the user exists.", fix: "The grant may already be confirmed or revoked \u2014 refresh its status before retrying." },
      ],
    },
    mongodb: {
      what: "Verifies Nia can actually use the write user you just created, before marking the grant as active.",
      why: "Confirms the user exists, has the right role, and that Nia's write credential can log in \u2014 catching setup mistakes immediately instead of at run time.",
      how: [
        "Make sure you've already created the user from the Grant write access step (mongosh or Atlas \u2192 Database Access).",
        'Click "I\'ve run this \u2014 confirm access".',
        "Wait for the result \u2014 Nia test-connects with the write user and checks the grant.",
      ],
      problems: [
        { problem: "Confirm fails with a connection/auth error.", fix: "The user likely wasn't created successfully \u2014 re-check it exists under Atlas \u2192 Database Access (or re-run createUser) for the right database." },
        { problem: "Confirm fails but the user exists.", fix: "The grant may already be confirmed or revoked \u2014 refresh its status before retrying." },
      ],
    },
  },

  "revoke-access": {
    postgres: {
      what: "Removes Nia's write role from your database \u2014 Nia can no longer write to this destination afterward.",
      why: "Revoke access once a workflow no longer needs write access, or to rotate to a fresh role.",
      how: [
        "Click Revoke in the panel.",
        "Nia marks the grant revoked immediately; the role itself still exists in your database until you drop it.",
        "Copy the statement below and run it against your database to remove the role.",
      ],
      problems: [
        { problem: "Revoke fails.", fix: "The grant may already be revoked \u2014 refresh its status before retrying." },
        { problem: "Role still shows up in your database after revoking in Nia.", fix: "Revoking in Nia only stops Nia from using it \u2014 run the DROP statement yourself to remove the role entirely." },
      ],
      sql: (v) => buildDropRoleStatementText("postgres", v.roleUser),
    },
    supabase: {
      what: "Removes Nia's write role from your database \u2014 Nia can no longer write to this destination afterward.",
      why: "Revoke access once a workflow no longer needs write access, or to rotate to a fresh role.",
      how: [
        "Click Revoke in the panel.",
        "Nia marks the grant revoked immediately; the role itself still exists in your database until you drop it.",
        "Copy the statement below and run it in the Supabase SQL editor to remove the role.",
      ],
      problems: [
        { problem: "Revoke fails.", fix: "The grant may already be revoked \u2014 refresh its status before retrying." },
        { problem: "Role still shows up in your database after revoking in Nia.", fix: "Revoking in Nia only stops Nia from using it \u2014 run the DROP statement yourself to remove the role entirely." },
      ],
      sql: (v) => buildDropRoleStatementText("supabase", v.roleUser),
    },
    mysql: {
      what: "Removes Nia's write user from your database \u2014 Nia can no longer write to this destination afterward.",
      why: "Revoke access once a workflow no longer needs write access, or to rotate to a fresh user.",
      how: [
        "Click Revoke in the panel.",
        "Nia marks the grant revoked immediately; the user itself still exists in your database until you drop it.",
        "Copy the statement below and run it against your database to remove the user.",
      ],
      problems: [
        { problem: "Revoke fails.", fix: "The grant may already be revoked \u2014 refresh its status before retrying." },
        { problem: "User still shows up in your database after revoking in Nia.", fix: "Revoking in Nia only stops Nia from using it \u2014 run the DROP statement yourself to remove the user entirely." },
      ],
      sql: (v) => buildDropRoleStatementText("mysql", v.roleUser),
    },
    mongodb: {
      what: "Removes Nia's write user from your database \u2014 Nia can no longer write to this destination afterward.",
      why: "Revoke access once a workflow no longer needs write access, or to rotate to a fresh user.",
      how: [
        "Click Revoke in the panel.",
        "Nia marks the grant revoked immediately; the user itself still exists in your database until you drop it.",
        "Copy the statement below and run it in mongosh (or remove it from Atlas \u2192 Database Access) to remove the user.",
      ],
      problems: [
        { problem: "Revoke fails.", fix: "The grant may already be revoked \u2014 refresh its status before retrying." },
        { problem: "User still shows up in your database after revoking in Nia.", fix: "Revoking in Nia only stops Nia from using it \u2014 remove it yourself (mongosh dropUser or Atlas \u2192 Database Access) to delete the user entirely." },
      ],
      sql: (v) => buildDropRoleStatementText("mongodb", v.roleUser),
    },
  },
};

export function getHelpSection(step: HelpStepKey, connectorId: string): HelpSection | undefined {
  return HELP_CONTENT[step]?.[connectorId as HelpConnectorId];
}
