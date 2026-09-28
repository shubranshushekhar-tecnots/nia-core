import { describe, expect, it } from "vitest";
import {
  buildReadOnlyStatementText,
  extractProjectRefFromUsername,
  suggestReadOnlyUsername,
} from "./readOnlyStatement.js";

describe("buildReadOnlyStatementText — basic per-dialect shape", () => {
  it("postgres: CREATE ROLE + read-only session default + CONNECT + public schema grants", () => {
    const sql = buildReadOnlyStatementText("postgres", "sales", "nia_ro_role", "s3cret");
    expect(sql).not.toBeNull();
    expect(sql).toContain(`CREATE ROLE "nia_ro_role" WITH LOGIN PASSWORD 's3cret';`);
    expect(sql).toContain(`ALTER ROLE "nia_ro_role" SET default_transaction_read_only = on;`);
    expect(sql).toContain(`GRANT CONNECT ON DATABASE "sales" TO "nia_ro_role";`);
    expect(sql).toContain(`GRANT USAGE ON SCHEMA "public" TO "nia_ro_role";`);
    expect(sql).toContain(`GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "nia_ro_role";`);
    expect(sql).toContain(`ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT SELECT ON TABLES TO "nia_ro_role";`);
  });

  it("supabase resolves to the same postgres dialect as postgres", () => {
    const sql = buildReadOnlyStatementText("supabase", "sales", "nia_ro_role", "s3cret");
    expect(sql).toContain(`CREATE ROLE "nia_ro_role" WITH LOGIN PASSWORD 's3cret';`);
  });

  it("postgres: extraSchemas adds additional USAGE/SELECT/DEFAULT PRIVILEGES blocks, on top of public", () => {
    const sql = buildReadOnlyStatementText("postgres", "sales", "nia_ro_role", "s3cret", {
      extraSchemas: ["analytics", "reporting"],
    });
    expect(sql).not.toBeNull();
    for (const schema of ["public", "analytics", "reporting"]) {
      expect(sql).toContain(`GRANT USAGE ON SCHEMA "${schema}" TO "nia_ro_role";`);
      expect(sql).toContain(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "nia_ro_role";`);
      expect(sql).toContain(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT SELECT ON TABLES TO "nia_ro_role";`);
    }
  });

  it("mysql: CREATE USER + database-scoped SELECT, no FLUSH PRIVILEGES, keeps '%' host with a restrict-IP note", () => {
    const sql = buildReadOnlyStatementText("mysql", "sales", "nia_ro_role", "s3cret");
    expect(sql).not.toBeNull();
    expect(sql).toContain(`CREATE USER \`nia_ro_role\`@'%' IDENTIFIED BY 's3cret';`);
    expect(sql).toContain("GRANT SELECT ON `sales`.* TO `nia_ro_role`@'%';");
    expect(sql).not.toMatch(/FLUSH\s+PRIVILEGES/i);
    expect(sql).toMatch(/restrict it here/i);
  });

  it("mongodb: createUser with the built-in read role, plus an Atlas-specific guidance comment", () => {
    const sql = buildReadOnlyStatementText("mongodb", "sales", "nia_ro_role", "s3cret");
    expect(sql).not.toBeNull();
    expect(sql).toMatch(/Using MongoDB Atlas\?/i);
    expect(sql).toContain(`db.getSiblingDB("sales").createUser({`);
    expect(sql).toContain(`user: "nia_ro_role",`);
    expect(sql).toContain(`pwd: "s3cret",`);
    expect(sql).toContain(`roles: [{ role: "read", db: "sales" }],`);
  });

  it("returns null for an unknown connector", () => {
    expect(buildReadOnlyStatementText("not_a_real_connector", "sales", "nia_ro_role", "s3cret")).toBeNull();
  });
});

// Injection safety (docs/plans/learning-mode.md, SQL step 1, amendment #1).
// database/schema names come from the user's own existing database and
// aren't restricted to a fixed character set, so every one of them must be
// escaped per dialect wherever it's interpolated into an actual statement,
// and never interpolated raw into a comment (a `--`/`//` comment only runs
// to the next line break, so an unescaped CR/LF there could let subsequent
// hostile text run as a real statement). roleUser/rolePassword are always
// Nia-generated, so those are validated by character set instead (see
// "roleUser/rolePassword are validated..." below) rather than relying on
// escaping to make them safe.
describe("buildReadOnlyStatementText — hostile database/schema identifiers", () => {
  it("postgres: embedded double quotes in a database name are doubled/escaped, not left as a raw breakout character", () => {
    const sql = buildReadOnlyStatementText("postgres", 'sales"; DROP TABLE users; --', "nia_ro_role", "s3cret");
    expect(sql).not.toBeNull();
    expect(sql).toContain(`"sales""; DROP TABLE users; --"`);
  });

  it("postgres: hostile extraSchemas entries are individually escaped in every generated line", () => {
    const sql = buildReadOnlyStatementText("postgres", "sales", "nia_ro_role", "s3cret", {
      extraSchemas: [`evil"; DROP SCHEMA public CASCADE; --`],
    });
    expect(sql).not.toBeNull();
    expect(sql).toContain(`GRANT USAGE ON SCHEMA "evil""; DROP SCHEMA public CASCADE; --" TO "nia_ro_role";`);
  });

  it("mysql: embedded backticks in a database name are doubled, not left as a raw breakout character", () => {
    const sql = buildReadOnlyStatementText("mysql", "sales`; DROP TABLE users; --", "nia_ro_role", "s3cret");
    expect(sql).not.toBeNull();
    expect(sql).toContain("`sales``; DROP TABLE users; --`");
  });

  it("mongodb: hostile database values go through JSON.stringify, so quotes/newlines/backslashes stay inert string content", () => {
    const hostileDb = 'sales"); db.dropDatabase(); //';
    const sql = buildReadOnlyStatementText("mongodb", hostileDb, "nia_ro_role", "s3cret");
    expect(sql).not.toBeNull();
    expect(sql).toContain(`db.getSiblingDB(${JSON.stringify(hostileDb)}).createUser({`);
    expect(sql).toContain(`roles: [{ role: "read", db: ${JSON.stringify(hostileDb)} }],`);
  });
});

// Amendment review, check #1: a database/schema name containing a raw
// newline followed by injected SQL text must never produce a standalone
// executable line outside the fixed statement set, for any of the three
// dialects — in particular it must not be able to close a `--`/`//` comment
// early.
describe("buildReadOnlyStatementText — no comment-line breakout from a hostile database/schema name", () => {
  it("postgres: a raw newline + injected SQL in an extraSchemas entry cannot close the DEFAULT PRIVILEGES comment early", () => {
    const sql = buildReadOnlyStatementText("postgres", "sales", "nia_ro_role", "s3cret", {
      extraSchemas: ["evil\nDROP TABLE x;--"],
    });
    expect(sql).not.toBeNull();
    // Before the fix, the raw newline in the schema name would end the `--`
    // comment early, leaving "DROP TABLE x;--" as its own, real, executable
    // line. It must instead stay folded into a single-line comment.
    expect(sql).not.toMatch(/^DROP TABLE x;--$/m);
    expect(sql).toMatch(/re-run for schema evil DROP TABLE x;--$/m);
  });

  it("mysql: a raw newline + injected SQL in the database name does not produce a standalone executable line (mysql never interpolates it into a comment)", () => {
    const sql = buildReadOnlyStatementText("mysql", "sales\nDROP TABLE x;--", "nia_ro_role", "s3cret");
    expect(sql).not.toBeNull();
    expect(sql).not.toMatch(/^DROP TABLE x;--$/m);
  });

  it("mongodb: a raw newline + injected code in the database name stays escaped text inside the JS comment (mongosh `//` comment, via JSON.stringify)", () => {
    const sql = buildReadOnlyStatementText("mongodb", "sales\nDROP TABLE x;--", "nia_ro_role", "s3cret");
    expect(sql).not.toBeNull();
    expect(sql).not.toMatch(/^DROP TABLE x;--$/m);
  });
});

// Amendment review, check #2: roleUser/rolePassword are always Nia-generated
// (never freely typed by a user), so instead of trusting each dialect's
// literal-escaping rules to be airtight (MySQL's backslash-as-escape-char
// behavior in particular means quote-doubling alone is not sufficient),
// buildReadOnlyStatementText validates their character set up front and
// throws on anything else.
describe("buildReadOnlyStatementText — roleUser/rolePassword are validated by character set, not escaped", () => {
  it("throws for a roleUser containing a quote/backtick/semicolon/space instead of relying on dialect escaping", () => {
    expect(() => buildReadOnlyStatementText("postgres", "sales", 'nia_ro"; GRANT ALL --', "s3cret")).toThrow();
    expect(() => buildReadOnlyStatementText("mysql", "sales", "nia_ro`; GRANT ALL --", "s3cret")).toThrow();
    expect(() => buildReadOnlyStatementText("mongodb", "sales", "nia ro", "s3cret")).toThrow();
  });

  it("throws for a rolePassword containing a quote/semicolon or a trailing backslash instead of relying on dialect escaping", () => {
    expect(() => buildReadOnlyStatementText("postgres", "sales", "nia_ro_role", "s3'; DROP TABLE users; --")).toThrow();
    // Matters most for MySQL: a trailing `\` before quoteLiteral's closing
    // `'` can "eat" the closing quote even though the `'` itself was
    // doubled, since MySQL treats `\` as a string-literal escape character.
    expect(() => buildReadOnlyStatementText("mysql", "sales", "nia_ro_role", "s3cret\\")).toThrow();
  });

  it("throws for a rolePassword containing an underscore (the password charset is stricter than the role charset)", () => {
    expect(() => buildReadOnlyStatementText("postgres", "sales", "nia_ro_role", "s3cret_1")).toThrow();
  });

  it("accepts a roleUser with underscores and an alphanumeric-only password", () => {
    expect(() => buildReadOnlyStatementText("postgres", "sales", "nia_ro_role_1", "S3cr3t123")).not.toThrow();
  });
});

describe("Supabase pooler username helpers", () => {
  it("extractProjectRefFromUsername returns the suffix after the first dot", () => {
    expect(extractProjectRefFromUsername("postgres.abcdefghijkl")).toBe("abcdefghijkl");
  });

  it("extractProjectRefFromUsername returns undefined when there's no dot", () => {
    expect(extractProjectRefFromUsername("postgres")).toBeUndefined();
  });

  it("suggestReadOnlyUsername qualifies the new role with the derived project ref", () => {
    expect(suggestReadOnlyUsername("nia_ro_role", "postgres.abcdefghijkl")).toBe("nia_ro_role.abcdefghijkl");
  });

  it("suggestReadOnlyUsername falls back to the bare role name when no pasted username was given", () => {
    expect(suggestReadOnlyUsername("nia_ro_role")).toBe("nia_ro_role");
  });

  it("suggestReadOnlyUsername falls back to the bare role name when the pasted username has no project ref", () => {
    expect(suggestReadOnlyUsername("nia_ro_role", "postgres")).toBe("nia_ro_role");
  });
});
