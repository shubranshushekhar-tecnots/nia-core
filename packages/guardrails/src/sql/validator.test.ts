import { describe, expect, it } from "vitest";
import { MYSQL_DIALECT, POSTGRES_DIALECT } from "./dialect.js";
import { validateReadOnlySql } from "./validator.js";

describe("validateReadOnlySql (mysql dialect)", () => {
  it("allows a plain SELECT and injects a LIMIT", () => {
    const result = validateReadOnlySql("SELECT * FROM users", MYSQL_DIALECT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sanitizedQuery).toContain("LIMIT 1000");
  });

  it("allows WITH (CTE) statements", () => {
    const result = validateReadOnlySql(
      "WITH t AS (SELECT id FROM users) SELECT * FROM t",
      MYSQL_DIALECT,
    );
    expect(result.ok).toBe(true);
  });

  it("caps an oversized LIMIT", () => {
    const result = validateReadOnlySql("SELECT * FROM users LIMIT 999999", MYSQL_DIALECT, {
      maxRows: 500,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sanitizedQuery).toContain("LIMIT 500");
  });

  it("leaves an in-bounds LIMIT untouched", () => {
    const result = validateReadOnlySql("SELECT * FROM users LIMIT 10", MYSQL_DIALECT, {
      maxRows: 500,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sanitizedQuery).toContain("LIMIT 10");
  });

  it("preserves qualified identifiers (table.column) in the reconstructed query", () => {
    const result = validateReadOnlySql("SELECT u.id FROM users u", MYSQL_DIALECT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sanitizedQuery).toContain("u.id");
  });

  it("preserves decimal numeric literals in the reconstructed query", () => {
    const result = validateReadOnlySql("SELECT * FROM users WHERE score > 3.14", MYSQL_DIALECT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sanitizedQuery).toContain("3.14");
  });

  it("rejects non-SELECT statements", () => {
    expect(validateReadOnlySql("DELETE FROM users", MYSQL_DIALECT).ok).toBe(false);
    expect(validateReadOnlySql("DROP TABLE users", MYSQL_DIALECT).ok).toBe(false);
    expect(validateReadOnlySql("UPDATE users SET x = 1", MYSQL_DIALECT).ok).toBe(false);
  });

  it("rejects multiple statements", () => {
    const result = validateReadOnlySql("SELECT 1; DROP TABLE users;", MYSQL_DIALECT);
    expect(result.ok).toBe(false);
  });

  it("allows a single trailing semicolon", () => {
    const result = validateReadOnlySql("SELECT * FROM users;", MYSQL_DIALECT);
    expect(result.ok).toBe(true);
  });

  it("does not get fooled by forbidden keywords inside string literals", () => {
    const result = validateReadOnlySql(
      "SELECT * FROM users WHERE name = 'DROP TABLE users'",
      MYSQL_DIALECT,
    );
    expect(result.ok).toBe(true);
  });

  it("does not get fooled by forbidden keywords inside comments", () => {
    const result = validateReadOnlySql(
      "SELECT * FROM users -- DROP TABLE users\n",
      MYSQL_DIALECT,
    );
    expect(result.ok).toBe(true);
  });

  it("treats `--` followed by a newline (no space) as a comment start, per MySQL's real rule", () => {
    const result = validateReadOnlySql(
      "SELECT * FROM users --\nDROP TABLE users",
      MYSQL_DIALECT,
    );
    // The `--\n` starts an (empty) comment — only the two `--` chars are
    // swallowed, since the comment ends at the very next char (the `\n`
    // itself, per the tokenizer's own line-comment rule). So "DROP TABLE
    // users" is NOT inside the comment; it re-tokenizes as ordinary word
    // tokens and trips the forbidden-keyword blocklist (there's no `;`
    // anywhere in this input, so the "multiple statements" check never
    // even runs). Rejected for "Forbidden keyword: DROP", not multiple
    // statements — this test only confirms `--` was correctly recognized
    // as a comment start (rather than misread as literal `-` tokens).
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("Forbidden keyword: DROP");
  });

  it("treats `--` followed by a tab (no space) as a comment start, per MySQL's real rule", () => {
    const result = validateReadOnlySql(
      "SELECT * FROM users --\tDROP TABLE users",
      MYSQL_DIALECT,
    );
    expect(result.ok).toBe(true);
  });

  it("does NOT treat `--` immediately followed by a non-whitespace character as a comment", () => {
    // MySQL: `--x` is not a comment marker at all — it tokenizes as two
    // `-` punctuation chars followed by `x`, which is not valid SQL here.
    const result = validateReadOnlySql("SELECT * FROM users --DROP TABLE users", MYSQL_DIALECT);
    expect(result.ok).toBe(false);
  });

  it("does not get fooled by forbidden keywords inside quoted identifiers", () => {
    const result = validateReadOnlySql("SELECT * FROM `drop`", MYSQL_DIALECT);
    expect(result.ok).toBe(true);
  });

  it("rejects unterminated string literals", () => {
    const result = validateReadOnlySql("SELECT * FROM users WHERE name = 'abc", MYSQL_DIALECT);
    expect(result.ok).toBe(false);
  });

  it("rejects empty queries", () => {
    expect(validateReadOnlySql("", MYSQL_DIALECT).ok).toBe(false);
    expect(validateReadOnlySql("   ", MYSQL_DIALECT).ok).toBe(false);
    expect(validateReadOnlySql("-- just a comment", MYSQL_DIALECT).ok).toBe(false);
  });

  // --- Known-unhandled edge cases -------------------------------------
  // These document real gaps in the tokenizer's string-based approach.
  // They are intentionally left failing (`.fails`) rather than fixed here
  // (a real fix requires a grammar-aware parser, out of scope for this
  // pass) — but see validator.ts's module header: this is NOT a low-
  // severity/cosmetic gap. Nothing in the current config schema requires
  // or verifies a read-only DB role at connect time, so today the
  // "defense in depth" framing overstates what actually backs this
  // validator — the real boundary is operational convention. Until a
  // read-only role is an enforced, verified property of every connection
  // (see the TODO in validator.ts), a bypass found here is a real path to
  // a mutating statement reaching the DB, not just a theoretical one.

  it.fails(
    "MySQL executable version comments (/*! ... */) are mistaken for inert comments — REAL BYPASS, not just a tokenizer nicety",
    () => {
      // MySQL EXECUTES the contents of /*! ... */ (optionally version-gated,
      // e.g. /*!50000 ... */) as real SQL — it is NOT a comment from the
      // server's perspective, even though every naive tokenizer (including
      // ours, since blockCommentStart is just "/*") treats it as one. A
      // forbidden keyword hidden this way is silently let through today,
      // and since nothing currently enforces a read-only role at connect
      // time (see validator.ts's module header + TODO), that keyword can
      // actually execute against the DB — this is a live bypass, not a
      // hypothetical edge case.
      const result = validateReadOnlySql(
        "SELECT * FROM users /*!50000 ,(SELECT 1 FROM (SELECT DROP TABLE users) x) */",
        MYSQL_DIALECT,
      );
      expect(result.ok).toBe(false);
    },
  );
});

describe("validateReadOnlySql (postgres dialect)", () => {
  it("allows a plain SELECT and injects a LIMIT", () => {
    const result = validateReadOnlySql("SELECT * FROM users", POSTGRES_DIALECT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sanitizedQuery).toContain("LIMIT 1000");
  });

  it("does not treat a double-quoted identifier's contents as a string literal", () => {
    // Postgres: `"` is exclusively identifier quoting, never a string
    // delimiter — a forbidden keyword inside one must still be inert.
    const result = validateReadOnlySql('SELECT * FROM "drop"', POSTGRES_DIALECT);
    expect(result.ok).toBe(true);
  });

  it("always treats `--` as a comment start regardless of what follows (no whitespace gate, unlike MySQL)", () => {
    const result = validateReadOnlySql("SELECT * FROM users --DROP TABLE users", POSTGRES_DIALECT);
    expect(result.ok).toBe(true);
  });

  // --- Dollar-quoting ($$...$$ / $tag$...$tag$) -------------------------
  // MySQL never had to handle this; do not assume the shared tokenizer
  // already does — these tests exercise the new dollar-quote branch added
  // to tokenizer.ts specifically for POSTGRES_DIALECT.

  it("treats an untagged dollar-quoted string ($$...$$) as inert string body, not live SQL", () => {
    const result = validateReadOnlySql(
      "SELECT $$anything; DROP TABLE users; -- can go in here$$ AS note FROM users",
      POSTGRES_DIALECT,
    );
    expect(result.ok).toBe(true);
  });

  it("treats a tagged dollar-quoted string ($tag$...$tag$) as inert string body", () => {
    const result = validateReadOnlySql(
      "SELECT $tag$DROP TABLE users$tag$ AS note FROM users",
      POSTGRES_DIALECT,
    );
    expect(result.ok).toBe(true);
  });

  it("does not let an unrelated $ (e.g. a $1 parameter placeholder) get mistaken for a dollar-quote", () => {
    const result = validateReadOnlySql("SELECT * FROM users WHERE id = $1", POSTGRES_DIALECT);
    expect(result.ok).toBe(true);
  });

  it("rejects an unterminated dollar-quoted string as unparseable", () => {
    const result = validateReadOnlySql("SELECT $$unterminated FROM users", POSTGRES_DIALECT);
    expect(result.ok).toBe(false);
  });

  it("does not let a mismatched tag close an open dollar-quote (a different tag is just text inside the string)", () => {
    // $foo$ ... $bar$ ... $foo$ — the body is scanned for the *matching*
    // closing tag; an unrelated $bar$ inside it doesn't end the string.
    const result = validateReadOnlySql(
      "SELECT $foo$has a $bar$ inside it; DROP TABLE users$foo$ AS note FROM users",
      POSTGRES_DIALECT,
    );
    expect(result.ok).toBe(true);
  });

  // --- Nested block comments --------------------------------------------
  // Postgres nests /* */; MySQL does not. tokenizer.ts's block-comment loop
  // is already generic over `nestedBlockComments`, but this is untested
  // against POSTGRES_DIALECT until now.

  it("keeps a forbidden keyword between the inner and outer closes inert, proving nesting depth is tracked (not just the first */)", () => {
    // /* outer opens depth 1, /* inner opens depth 2, the FIRST `*/` only
    // closes the inner comment (depth back to 1) — "DROP TABLE users" is
    // still inside the still-open outer comment, and only the SECOND `*/`
    // closes it. If nesting were NOT honored (MySQL's behavior), the first
    // `*/` would end the whole comment there, un-hiding "DROP TABLE users"
    // as live SQL and this query would be rejected instead.
    const result = validateReadOnlySql(
      "SELECT * /* outer /* inner */ DROP TABLE users */ FROM users",
      POSTGRES_DIALECT,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an unterminated nested block comment", () => {
    const result = validateReadOnlySql(
      "SELECT * /* outer /* inner */ still not closed FROM users",
      POSTGRES_DIALECT,
    );
    expect(result.ok).toBe(false);
  });
});
