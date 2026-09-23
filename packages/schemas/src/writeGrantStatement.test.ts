import { describe, expect, it } from "vitest";
import { buildGrantStatementText } from "./writeGrantStatement.js";

// New-table staged case: the generated DDL must cover CREATE on the
// destination schema/database (for a new table) plus Nia's own internal
// "nia" schema/database (for staging/quarantine) — without ever granting a
// database-wide (postgres) or global (mysql) CREATE privilege. See
// docs/decisions.md's "Staging/quarantine writes in nia inherit the
// destination grant for that run" entry.
describe("buildGrantStatementText — new-table staged case", () => {
  it("postgres: creates nia via CREATE SCHEMA IF NOT EXISTS, scopes CREATE to the destination schema and nia only, never GRANT CREATE ON DATABASE", () => {
    const sql = buildGrantStatementText("supabase", "sales", "nia_write_role", "s3cret");
    expect(sql).not.toBeNull();
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "nia";');
    expect(sql).toContain('GRANT USAGE, CREATE ON SCHEMA "nia" TO "nia_write_role";');
    expect(sql).toContain('GRANT USAGE, CREATE ON SCHEMA "sales" TO "nia_write_role";');
    expect(sql).not.toMatch(/GRANT\s+CREATE\s+ON\s+DATABASE/i);
  });

  it("mysql: scopes CREATE to the destination db plus a dedicated `nia`.* grant, never a global *.* grant", () => {
    const sql = buildGrantStatementText("mysql", "sales", "nia_write_role", "s3cret");
    expect(sql).not.toBeNull();
    expect(sql).toContain("GRANT SELECT, INSERT, UPDATE, CREATE ON `sales`.* TO `nia_write_role`@'%';");
    expect(sql).toContain("GRANT CREATE, DROP ON `nia`.* TO `nia_write_role`@'%';");
    expect(sql).not.toMatch(/ON\s+\*\.\*/);
  });
});
