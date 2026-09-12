// Per-database-dialect lexing rules for the SQL guardrail validator
// (see validator.ts for the shared logic these rules plug into).
//
// Phase 1 filled in MYSQL_DIALECT. Phase 2 adds POSTGRES_DIALECT, covering
// the two lexing features MySQL never needed: dollar-quoted strings
// ($$...$$ / $tag$...$tag$, handled in tokenizer.ts's dollar-quote branch,
// gated on supportsDollarQuoting) and nested block comments (already
// generic in tokenizer.ts's block-comment loop via nestedBlockComments;
// MySQL just never set it to true). Known, disclosed gap: Postgres's E''
// escape-string syntax (backslash escapes only inside an `E'...'`-prefixed
// literal, vs. plain `'...'` where standard_conforming_strings makes
// backslash a literal character) is NOT modeled — POSTGRES_DIALECT sets
// backslashEscapesInStrings: false (correct for the common, default-config
// case), but a query using `E'...'` with backslash escapes will be
// tokenized as if the backslash were literal, which can misplace the
// string's closing quote. Fixing this needs the tokenizer to recognize the
// `E` prefix immediately before a `'` and switch escaping mode for that one
// string, which isn't implemented here — same "hand-rolled tokenizer, not
// a real grammar-aware parser" caveat as validator.ts's module header.

/**
 * A line-comment start rule. `requiresTrailingWhitespace: true` means the
 * prefix only starts a comment when followed by whitespace/a control
 * character (or end of input) — e.g. MySQL's `--`, which is NOT a comment
 * marker when immediately followed by another character (`--x` is not a
 * comment; `-- x`, `--\n`, `--\t` are). `false` means the prefix always
 * starts a comment regardless of what follows (e.g. MySQL's `#`).
 */
export type LineCommentRule = { prefix: string; requiresTrailingWhitespace: boolean };

export type DialectConfig = {
  /** Human-readable id, matches the connector manifest id. */
  id: string;
  /** Characters that open/close a quoted identifier, e.g. backtick for MySQL, `"` for Postgres. */
  identifierQuote: string;
  /** Characters that can open a string literal (checked in order). */
  stringQuoteChars: string[];
  /** How a doubled quote char inside a string of that same quote char is treated (SQL-standard escaping, e.g. '' inside ''). */
  allowDoubledQuoteEscape: boolean;
  /** Whether a backslash inside a string literal escapes the next character (MySQL default; Postgres only with E'' unless overridden). */
  backslashEscapesInStrings: boolean;
  /** Line comment start rules, e.g. `--` (whitespace-gated) and `#` for MySQL, `--` (whitespace-gated) for Postgres. */
  lineCommentStarts: LineCommentRule[];
  /** Block comment delimiters. */
  blockCommentStart: string;
  blockCommentEnd: string;
  /** Whether block comments can nest (Postgres: yes; MySQL: no). */
  nestedBlockComments: boolean;
  /** Whether dollar-quoted strings ($$...$$ / $tag$...$tag$) are supported (Postgres only). */
  supportsDollarQuoting: boolean;
};

// MySQL: backtick identifiers, backslash-escaped strings, '' doubling also
// allowed, '#' (always) and '--' (whitespace-gated, MySQL's actual rule —
// see LineCommentRule) line comments, non-nested /* */ block comments, no
// dollar-quoting.
export const MYSQL_DIALECT: DialectConfig = {
  id: "mysql",
  identifierQuote: "`",
  stringQuoteChars: ["'", '"'],
  allowDoubledQuoteEscape: true,
  backslashEscapesInStrings: true,
  lineCommentStarts: [
    { prefix: "--", requiresTrailingWhitespace: true },
    { prefix: "#", requiresTrailingWhitespace: false },
  ],
  blockCommentStart: "/*",
  blockCommentEnd: "*/",
  nestedBlockComments: false,
  supportsDollarQuoting: false,
};

// Postgres: double-quote identifiers (unlike MySQL's backtick), single-quote
// -only string literals (unlike MySQL, Postgres never treats `"` as a
// string delimiter — it's exclusively identifier quoting), '' doubling to
// escape a quote (SQL-standard, always available) but NO backslash escaping
// by default (standard_conforming_strings=on since PG9.1 — see this file's
// header for the disclosed E'' gap), '--' line comments that ALWAYS start a
// comment regardless of what follows (simpler than MySQL's whitespace-gated
// rule — no '#' comment syntax exists in Postgres), NESTED /* */ block
// comments (MySQL's don't nest), and dollar-quoting support.
export const POSTGRES_DIALECT: DialectConfig = {
  id: "postgres",
  identifierQuote: '"',
  stringQuoteChars: ["'"],
  allowDoubledQuoteEscape: true,
  backslashEscapesInStrings: false,
  lineCommentStarts: [{ prefix: "--", requiresTrailingWhitespace: false }],
  blockCommentStart: "/*",
  blockCommentEnd: "*/",
  nestedBlockComments: true,
  supportsDollarQuoting: true,
};
