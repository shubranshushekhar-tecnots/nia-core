// Dialect-aware SQL tokenizer. Exists so the validator never mistakes
// text inside a string literal, quoted identifier, or comment for a real
// keyword/statement-separator — a naive `sql.includes(";")` or
// `sql.toUpperCase().includes("DROP")` check is trivially defeated by
// putting the dangerous text inside a comment or string.
//
// This is a lexer, not a parser: it does not build an AST or understand
// SQL grammar beyond "what kind of span is this". See validator.ts's
// module header for what security guarantee this actually buys you.

import type { DialectConfig } from "./dialect.js";

export type Token =
  | { type: "word"; value: string; start: number; end: number }
  | { type: "string"; value: string; start: number; end: number }
  | { type: "quotedIdentifier"; value: string; start: number; end: number }
  | { type: "comment"; value: string; start: number; end: number }
  | { type: "punct"; value: string; start: number; end: number }
  | { type: "whitespace"; value: string; start: number; end: number };

/**
 * Tokenize `sql` per `dialect`'s rules.
 *
 * Throws if a string, quoted identifier, or block comment is left
 * unterminated at end of input — callers must treat that as an invalid
 * (rejected) query, not silently ignore the trailing garbage.
 */
export function tokenize(sql: string, dialect: DialectConfig): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i]!;

    // Whitespace
    if (/\s/.test(ch)) {
      const start = i;
      while (i < n && /\s/.test(sql[i]!)) i++;
      tokens.push({ type: "whitespace", value: sql.slice(start, i), start, end: i });
      continue;
    }

    // Line comments
    const lineRule = dialect.lineCommentStarts.find((rule) => {
      if (!sql.startsWith(rule.prefix, i)) return false;
      if (!rule.requiresTrailingWhitespace) return true;
      const next = sql[i + rule.prefix.length];
      return next === undefined || /\s/.test(next);
    });
    if (lineRule) {
      const start = i;
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl;
      tokens.push({ type: "comment", value: sql.slice(start, i), start, end: i });
      continue;
    }

    // Block comments (nesting per dialect)
    if (sql.startsWith(dialect.blockCommentStart, i)) {
      const start = i;
      let depth = 1;
      i += dialect.blockCommentStart.length;
      while (i < n && depth > 0) {
        if (dialect.nestedBlockComments && sql.startsWith(dialect.blockCommentStart, i)) {
          depth++;
          i += dialect.blockCommentStart.length;
        } else if (sql.startsWith(dialect.blockCommentEnd, i)) {
          depth--;
          i += dialect.blockCommentEnd.length;
        } else {
          i++;
        }
      }
      if (depth > 0) {
        throw new Error("Unterminated block comment");
      }
      tokens.push({ type: "comment", value: sql.slice(start, i), start, end: i });
      continue;
    }

    // Dollar-quoted string ($$...$$ / $tag$...$tag$) — Postgres only.
    // Must run before quoted-identifier/string/word handling below: without
    // this, `$$` or `$tag$` would fall into the word branch (whose char
    // class includes `$`) and never be recognized as a string delimiter at
    // all, so its "contents" (which may contain anything, including `'`,
    // `;`, or forbidden keywords) would be scanned as if they were live SQL
    // tokens instead of inert string body.
    if (dialect.supportsDollarQuoting && ch === "$") {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const start = i;
        const bodyStart = i + tag.length;
        const closeIdx = sql.indexOf(tag, bodyStart);
        if (closeIdx === -1) {
          throw new Error("Unterminated dollar-quoted string");
        }
        const end = closeIdx + tag.length;
        tokens.push({ type: "string", value: sql.slice(start, end), start, end });
        i = end;
        continue;
      }
      // Not a dollar-quote start (e.g. a `$1` parameter placeholder) —
      // fall through to word tokenizing below, which already includes `$`
      // in its char class.
    }

    // Quoted identifier
    if (ch === dialect.identifierQuote) {
      const start = i;
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i]! === dialect.identifierQuote) {
          if (sql[i + 1] === dialect.identifierQuote) {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) {
        throw new Error("Unterminated quoted identifier");
      }
      tokens.push({ type: "quotedIdentifier", value: sql.slice(start, i), start, end: i });
      continue;
    }

    // String literals
    if (dialect.stringQuoteChars.includes(ch)) {
      const quote = ch;
      const start = i;
      i++;
      let closed = false;
      while (i < n) {
        const c = sql[i]!;
        if (dialect.backslashEscapesInStrings && c === "\\") {
          i += 2;
          continue;
        }
        if (c === quote) {
          if (dialect.allowDoubledQuoteEscape && sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) {
        throw new Error("Unterminated string literal");
      }
      tokens.push({ type: "string", value: sql.slice(start, i), start, end: i });
      continue;
    }

    // Word (keyword / identifier / number)
    if (/[A-Za-z0-9_$]/.test(ch)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_$]/.test(sql[i]!)) i++;
      tokens.push({ type: "word", value: sql.slice(start, i), start, end: i });
      continue;
    }

    // Anything else: single punctuation char (;, (, ), comma, operators, ...)
    tokens.push({ type: "punct", value: ch, start: i, end: i + 1 });
    i++;
  }

  return tokens;
}
