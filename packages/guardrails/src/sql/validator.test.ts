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

  // --- Multi-char operator reconstruction ------------------------------
  // Regression coverage for a real bug: bodyText() naively joined every
  // token pair with a single space except a hand-maintained allowlist of
  // known multi-char operator pairs, so any operator the tokenizer split
  // into two adjacent punct tokens (e.g. `<` `>`) but which WASN'T yet in
  // that allowlist came back out as `< >` — different text than what was
  // validated, and often a syntax error at the server (this allowlist
  // approach had already missed `~*`/`||` once — see the "does not
  // over-fire" test below and docs/decisions.md's batch 6 entry).
  // bodyText() now reconstructs from each token's own SOURCE SPAN, joined
  // by SOURCE ADJACENCY (no allowlist at all) — these assert the
  // reconstruction text directly, not just pass/fail, since that's the
  // part that actually broke.
  it.each([
    ["<>", "SELECT * FROM users WHERE status <> 'x'", "status <> 'x'"],
    ["!=", "SELECT * FROM users WHERE status != 'x'", "status != 'x'"],
    ["<=", "SELECT * FROM users WHERE age <= 5", "age <= 5"],
    [">=", "SELECT * FROM users WHERE age >= 5", "age >= 5"],
    ["->", "SELECT * FROM users WHERE data->'x' = '1'", "data->'x'"],
    ["->>", "SELECT * FROM users WHERE data->>'x' = '1'", "data->>'x'"],
  ])("reconstructs the %s operator with no inserted space", (_op, sql, expectedFragment) => {
    const result = validateReadOnlySql(sql, MYSQL_DIALECT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sanitizedQuery).toContain(expectedFragment);
  });

  it("reconstructs a HAVING clause's <> operator correctly (the exact shape that surfaced this bug)", () => {
    const result = validateReadOnlySql(
      "SELECT `cohort`, MAX(`salary`) AS `max_salary` FROM `sandbox`.`t` GROUP BY `cohort` HAVING (`cohort` <> ?)",
      MYSQL_DIALECT,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Adjacency reconstructs the closing `?)` exactly as written (no
      // inserted space) — only the operator pair itself is asserted here.
      expect(result.sanitizedQuery).toContain("`cohort` <> ?)");
      expect(result.sanitizedQuery).not.toContain("< >");
    }
  });

  it("does not over-fire on unrelated adjacent punct pairs (e.g. a `)` right after a `>` comparison)", () => {
    // Guards against the fix being too eager in the other direction: `>`
    // followed by `)` must NOT be treated as some kind of two-char
    // operator. Under source adjacency, `1` and `)` were touching in the
    // original input (no space), so the byte-faithful reconstruction is
    // `1)` — this superseded the pre-adjacency algorithm's old default of
    // unconditionally inserting a space between every token pair not on
    // an explicit allowlist (which used to force `1 )` here even though
    // the source never had that space).
    const result = validateReadOnlySql("SELECT * FROM users WHERE (id > 1)", MYSQL_DIALECT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sanitizedQuery).toContain("id > 1)");
      expect(result.sanitizedQuery).not.toContain("1 )");
    }
  });

  it("rejects non-SELECT statements", () => {
    expect(validateReadOnlySql("DELETE FROM users", MYSQL_DIALECT).ok).toBe(false);
    expect(validateReadOnlySql("DROP TABLE users", MYSQL_DIALECT).ok).toBe(false);
    expect(validateReadOnlySql("UPDATE users SET x = 1", MYSQL_DIALECT).ok).toBe(false);
  });

  it("allows TRUNCATE(x, digits) as a function call but still rejects bare TRUNCATE (e.g. TRUNCATE TABLE)", () => {
    // Phase 8b-2 batch 1 regression: TRUNCATE is in FORBIDDEN_KEYWORDS to
    // block the destructive TRUNCATE TABLE statement, but mysql's
    // TRUNCATE(x, digits) numeric function (used by trunc()/quotient()'s
    // SQL emission in packages/schemas) shares the same keyword. The
    // function-call form (word immediately followed by "(") is now
    // carved out; a bare "truncate" with no parens still trips the
    // blocklist.
    const call = validateReadOnlySql("SELECT TRUNCATE(price, 2) AS p FROM orders", MYSQL_DIALECT);
    expect(call.ok).toBe(true);

    const bare = validateReadOnlySql("SELECT truncate FROM orders", MYSQL_DIALECT);
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.reason).toBe("Forbidden keyword: truncate");
  });

  it("TRUNCATE carve-out: still rejects every near-miss where the next significant token after TRUNCATE isn't '('", () => {
    // The carve-out's whole safety argument rests on "next significant
    // token is literally '(' ". These deliberately stay inside a valid
    // single SELECT/WITH-leading statement (a bare leading "TRUNCATE ..."
    // would just trip the earlier "must start with SELECT/WITH" check
    // instead, never reaching the carve-out logic at all — not a useful
    // test of the carve-out itself) so each case actually exercises the
    // blocklist scan's carve-out boundary, not an unrelated earlier check.
    const mustReject = [
      "SELECT truncate FROM orders", // bare identifier, no parens anywhere
      "SELECT TrUnCaTe FROM orders", // mixed case, no parens
      "SELECT truncate  FROM orders", // extra whitespace before the next token (still not "(")
      "SELECT truncate\nFROM orders", // newline before the next token
      "SELECT truncate -- comment\n FROM orders", // comment before the next token
      "SELECT truncate", // nothing at all follows it
      "SELECT truncate;", // only the trailing statement terminator follows it
    ];
    for (const sql of mustReject) {
      const result = validateReadOnlySql(sql, MYSQL_DIALECT);
      expect(result.ok, `expected rejection for: ${sql}`).toBe(false);
      if (!result.ok) {
        const originalCasing = sql.match(/truncate/i)![0];
        expect(result.reason).toBe(`Forbidden keyword: ${originalCasing}`);
      }
    }
  });

  it("TRUNCATE carve-out: a genuine TRUNCATE TABLE statement is still rejected (via the earlier leading-keyword check, not the blocklist)", () => {
    // Documents WHY a real TRUNCATE TABLE statement can never reach the
    // carve-out at all: it fails the "must start with SELECT/WITH" check
    // first, since TRUNCATE would have to be body[0]. Kept as its own
    // case (distinct reason string) so this isn't conflated with the
    // blocklist-scan cases above.
    const result = validateReadOnlySql("TRUNCATE TABLE users", MYSQL_DIALECT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("Only SELECT/WITH statements are allowed");
  });

  it("TRUNCATE carve-out: still allows the call form even with whitespace/newline/comment/case variation before the paren", () => {
    // These all resolve to the same "next significant token is '(' "
    // shape the carve-out checks for — whitespace/comments are already
    // stripped before this check runs (significant() filters both), so
    // none of these should be newly rejected by the carve-out's own
    // narrowness.
    const mustAllow = [
      "SELECT TRUNCATE(price, 2) AS p FROM orders",
      "SELECT TRUNCATE (price, 2) AS p FROM orders", // space before paren
      "SELECT TRUNCATE\n(price, 2) AS p FROM orders", // newline before paren
      "SELECT TRUNCATE/* digits */(price, 2) AS p FROM orders", // comment before paren
      "SELECT TrUnCaTe(price, 2) AS p FROM orders", // mixed case
    ];
    for (const sql of mustAllow) {
      const result = validateReadOnlySql(sql, MYSQL_DIALECT);
      expect(result.ok, `expected pass for: ${sql}`).toBe(true);
    }
  });

  it("allows REPLACE(str, from, to) as a function call but still rejects bare REPLACE (e.g. REPLACE INTO)", () => {
    // Phase 8b-2 batch 3 regression: REPLACE is in FORBIDDEN_KEYWORDS to
    // block the mutating REPLACE INTO statement, but mysql's
    // REPLACE(str, from, to) string function (used by substitute()/split()'s
    // SQL emission in packages/schemas) shares the same keyword. The
    // function-call form (word immediately followed by "(") is carved out
    // the same way TRUNCATE's is above; a bare "replace" with no parens
    // still trips the blocklist.
    const call = validateReadOnlySql("SELECT REPLACE(name, 'a', 'b') AS n FROM orders", MYSQL_DIALECT);
    expect(call.ok).toBe(true);

    const bare = validateReadOnlySql("SELECT replace FROM orders", MYSQL_DIALECT);
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.reason).toBe("Forbidden keyword: replace");
  });

  it("REPLACE carve-out: a genuine REPLACE INTO statement is still rejected (via the earlier leading-keyword check, not the blocklist)", () => {
    // Mirrors the TRUNCATE TABLE case above: REPLACE INTO can never reach
    // the carve-out at all, since REPLACE would have to be body[0], which
    // fails the "must start with SELECT/WITH" check first.
    const result = validateReadOnlySql("REPLACE INTO users (id) VALUES (1)", MYSQL_DIALECT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("Only SELECT/WITH statements are allowed");
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

  // --- Adjacency gap rule -------------------------------------------
  // A stripped comment must still leave a GAP behind — two significant
  // tokens that were only adjacent because a comment sat between them in
  // the source must NOT be joined with no space, or a completely
  // different (and dangerous) token could fall out the other side: `-` a
  // dropped comment `-1` must reconstruct as `- -1` (two tokens: unary
  // minus, then `-1`), never `--1` (which would itself start a MySQL
  // line comment on the *next* pass over the output — turning "the rest
  // of the line" into stripped-again text no validator ever re-checks).
  it("preserves the gap left by a stripped comment so two adjacent `-` tokens never collapse into `--`", () => {
    const result = validateReadOnlySql(
      "SELECT * FROM users WHERE id = -/**/-1",
      MYSQL_DIALECT,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sanitizedQuery).toContain("- -1");
      expect(result.sanitizedQuery).not.toContain("--1");
    }
  });

  // --- Executable/hint comment stripping (reconstruction fidelity) ----
  // Distinct from the disclosed keyword-scan bypass below: these assert
  // the narrower, already-true guarantee that bodyText() itself never
  // leaks a comment's characters into the reconstructed text, regardless
  // of what the comment contains or what the server would do with it.
  it("strips a MySQL version-conditional comment from the reconstructed text (even though nothing forbidden sits outside it here)", () => {
    const result = validateReadOnlySql(
      "/*!50000 DROP TABLE x */ SELECT 1",
      MYSQL_DIALECT,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sanitizedQuery).not.toContain("/*!");
      expect(result.sanitizedQuery).not.toContain("DROP");
    }
  });

  it("rejects a query that is nothing but a version-conditional comment (zero significant tokens left)", () => {
    const result = validateReadOnlySql("/*! SELECT 1 */", MYSQL_DIALECT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("Empty query");
  });

  it("strips a MySQL optimizer hint (/*+ ... */) from the reconstructed text", () => {
    const result = validateReadOnlySql("/*+ hint */ SELECT 1", MYSQL_DIALECT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sanitizedQuery).not.toContain("/*+");
  });

  it("reconstructs a string literal containing comment-like text byte-identical", () => {
    const result = validateReadOnlySql(
      "SELECT * FROM users WHERE name = 'a /* b */ c'",
      MYSQL_DIALECT,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sanitizedQuery).toContain("'a /* b */ c'");
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

  // --- Multi-char operator reconstruction (same bug, postgres dialect) --
  it.each([
    ["<>", 'SELECT * FROM users WHERE status <> \'x\'', "status <> 'x'"],
    ["!=", 'SELECT * FROM users WHERE status != \'x\'', "status != 'x'"],
    ["<=", "SELECT * FROM users WHERE age <= 5", "age <= 5"],
    [">=", "SELECT * FROM users WHERE age >= 5", "age >= 5"],
    // Phase 8b-2 batch 6: found live via agreementCases.ts — sqlShared.ts's
    // compileCleanFnSql emits `~*` for regex_match(..., true) and `||` for
    // regex_extract(..., 0)'s outer-paren-wrap; both were being torn into
    // `~ *` / `| |` by this reconstruction before MULTI_CHAR_OPERATORS
    // included them, which is a genuine Postgres syntax error, not just a
    // cosmetic reformat. See docs/decisions.md's batch 6 entry.
    ["~*", "SELECT * FROM users WHERE name ~* '^A'", "name ~* '^A'"],
    ["||", "SELECT * FROM users WHERE name = 'x' || 'y'", "'x' || 'y'"],
    // `::` is postgres-specific cast syntax (invalid in MySQL), so it's
    // only exercised here, not in the mysql it.each above.
    ["::", "SELECT * FROM users WHERE id::text = '1'", "id::text"],
  ])("reconstructs the %s operator with no inserted space", (_op, sql, expectedFragment) => {
    const result = validateReadOnlySql(sql, POSTGRES_DIALECT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sanitizedQuery).toContain(expectedFragment);
  });

  it("reconstructs multiple multi-char operators in one WHERE clause correctly (the exact shape that surfaced this bug)", () => {
    const result = validateReadOnlySql(
      'SELECT "cohort" FROM "public"."t" WHERE ("age" >= $1 AND "age" <= $2 AND "x" != $3)',
      POSTGRES_DIALECT,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sanitizedQuery).toContain('"age" >= $1');
      expect(result.sanitizedQuery).toContain('"age" <= $2');
      expect(result.sanitizedQuery).toContain('"x" != $3');
      expect(result.sanitizedQuery).not.toContain("> =");
      expect(result.sanitizedQuery).not.toContain("< =");
      expect(result.sanitizedQuery).not.toContain("! =");
    }
  });

  it("reconstructs a case-insensitive regex_match's ~* and a regex_extract's || in one WHERE clause correctly (batch 6 regression guard)", () => {
    const result = validateReadOnlySql(
      'SELECT * FROM "t" WHERE (("name" ~* $1)) AND (substring("text" from (\'(\' || $2 || \')\')) = $3)',
      POSTGRES_DIALECT,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sanitizedQuery).toContain('"name" ~* $1');
      expect(result.sanitizedQuery).toContain("'(' || $2 || ')'");
      expect(result.sanitizedQuery).not.toContain("~ *");
      expect(result.sanitizedQuery).not.toContain("| |");
    }
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

  it("same nested-comment input diverges safely by dialect: postgres nests it all away, mysql closes early and then rejects the leftover text", () => {
    // The exact shape from the bodyText redesign: /* outer /* inner */
    // still-comment */ SELECT 1 — postgres tracks nesting depth (the
    // outer comment doesn't close until the SECOND */, so the whole span
    // through "still-comment */" is one inert comment and only "SELECT 1"
    // remains as real SQL). MySQL doesn't nest: the FIRST */ (right after
    // "inner ") closes the entire comment, leaving " still-comment */
    // SELECT 1" to be tokenized as ordinary SQL — "still" is not a
    // SELECT/WITH keyword, so the leading-keyword allowlist rejects the
    // whole query outright. Either way, nothing unsafe ever reaches a
    // `sanitizedQuery`: postgres's is clean, mysql simply never produces
    // one (ok: false).
    const sql = "/* outer /* inner */ still-comment */ SELECT 1";

    const pg = validateReadOnlySql(sql, POSTGRES_DIALECT);
    expect(pg.ok).toBe(true);
    if (pg.ok) {
      expect(pg.sanitizedQuery).not.toContain("/*");
      expect(pg.sanitizedQuery).not.toContain("still-comment");
    }

    const mysql = validateReadOnlySql(sql, MYSQL_DIALECT);
    expect(mysql.ok).toBe(false);
    if (!mysql.ok) expect(mysql.reason).toBe("Only SELECT/WITH statements are allowed");
  });
});
