// Dialect-parameterized read-only SQL guardrail.
//
// !!! SECURITY BOUNDARY DISCLAIMER !!!
// This is defense in depth, NOT the security boundary — and today the real
// boundary is weaker than that framing implies. The intended boundary is
// that every connector-service DB session runs as a read-only DB role
// (see the connector's pool-manager / Vault-resolved credentials), so a
// forbidden statement can't do damage even if it reaches the server. But
// nothing in ConnectorConfig/CredentialRef (packages/schemas/src/
// contract.ts) currently requires or verifies that the resolved DB user is
// actually read-only at connect time — it's presently just an operational
// convention (whoever provisions the credential is trusted to have made it
// read-only), not something this codebase enforces or checks.
// That gap matters here concretely: this validator has a known bypass for
// MySQL's `/*! ... */` version-conditional comment syntax (see
// sql/validator.test.ts's `it.fails`) — MySQL EXECUTES the contents of
// `/*! ... */` as real SQL, it is not a comment server-side, even though
// this tokenizer treats it as inert. A forbidden keyword (DROP/DELETE/etc.)
// hidden this way is silently let through by this validator today. Without
// a verified read-only role backing every session, that bypass is a real
// path to a mutating statement reaching the DB, not just a cosmetic gap.
// TODO: ConnectorConfig (or a per-connector-kind extension of it) should
// require/verify a read-only role at Connect time (e.g. reject connect if
// the resolved DB user has write privileges), so the role is an enforced
// property of the credential rather than an assumption. Not implemented
// here — this is a config-schema/connect-flow change, out of scope for
// this validator.
// Do not extend this validator's role beyond "defense in depth" without
// first replacing the hand-rolled tokenizer with a real grammar-aware
// parser (e.g. libpg_query for Postgres).

import type { DialectConfig } from "./dialect.js";
import { tokenize, type Token } from "./tokenizer.js";

const FORBIDDEN_KEYWORDS = new Set([
  "insert", "update", "delete", "drop", "alter", "create", "truncate",
  "grant", "revoke", "call", "exec", "execute", "merge", "replace",
  "load", "into", "lock", "unlock", "set", "use", "attach", "detach",
  "vacuum", "reindex", "copy", "do",
]);

const ALLOWED_LEADING_KEYWORDS = new Set(["select", "with"]);

export type SqlValidatorOptions = {
  /** Hard cap injected/enforced on the result row count. */
  maxRows: number;
};

const DEFAULT_OPTIONS: SqlValidatorOptions = { maxRows: 1000 };

export type SqlValidationResult =
  | { ok: true; sanitizedQuery: string }
  | { ok: false; reason: string };

function significant(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.type !== "whitespace" && t.type !== "comment");
}

export function validateReadOnlySql(
  sql: string,
  dialect: DialectConfig,
  options: SqlValidatorOptions = DEFAULT_OPTIONS,
): SqlValidationResult {
  let tokens: Token[];
  try {
    tokens = tokenize(sql, dialect);
  } catch (err) {
    return { ok: false, reason: `Unparseable query: ${(err as Error).message}` };
  }

  const sig = significant(tokens);
  if (sig.length === 0) {
    return { ok: false, reason: "Empty query" };
  }

  // Single statement only: at most one top-level `;`, and only as the
  // very last significant token.
  const semicolons = sig.filter((t) => t.type === "punct" && t.value === ";");
  if (semicolons.length > 1) {
    return { ok: false, reason: "Multiple statements are not allowed" };
  }
  if (semicolons.length === 1 && sig[sig.length - 1] !== semicolons[0]) {
    return { ok: false, reason: "Multiple statements are not allowed" };
  }

  const body = semicolons.length === 1 ? sig.slice(0, -1) : sig;
  if (body.length === 0) {
    return { ok: false, reason: "Empty query" };
  }

  // Allowlist: must start with SELECT or WITH.
  const first = body[0]!;
  if (first.type !== "word" || !ALLOWED_LEADING_KEYWORDS.has(first.value.toLowerCase())) {
    return { ok: false, reason: "Only SELECT/WITH statements are allowed" };
  }

  // Blocklist scan: no forbidden keyword may appear as a real (non-string,
  // non-comment, non-quoted-identifier) word token anywhere in the query.
  for (const t of body) {
    if (t.type === "word" && FORBIDDEN_KEYWORDS.has(t.value.toLowerCase())) {
      return { ok: false, reason: `Forbidden keyword: ${t.value}` };
    }
  }

  // LIMIT enforcement: find a top-level (paren-depth 0) LIMIT keyword and
  // cap its value; inject one if absent.
  let depth = 0;
  let limitIdx = -1;
  for (let idx = 0; idx < body.length; idx++) {
    const t = body[idx]!;
    if (t.type === "punct" && t.value === "(") depth++;
    else if (t.type === "punct" && t.value === ")") depth--;
    else if (depth === 0 && t.type === "word" && t.value.toLowerCase() === "limit") {
      limitIdx = idx;
    }
  }

  // Naively joining every token with a single space breaks reconstruction
  // wherever the tokenizer split something that isn't actually
  // space-separated in real SQL: qualified identifiers (`t` `.` `id` must
  // become `t.id`, not `t . id`) and decimal numeric literals (`3` `.`
  // `14` must become `3.14`, not `3 . 14`, which is a different, invalid
  // token sequence to the server).
  const bodyText = (tks: Token[]) =>
    tks.reduce((out, t, i) => {
      if (i === 0) return t.value;
      const prev = tks[i - 1]!;
      const noSpace = t.value === "." || prev.value === "." || t.value === "," || t.value === ";";
      return noSpace ? `${out}${t.value}` : `${out} ${t.value}`;
    }, "");

  if (limitIdx === -1) {
    return { ok: true, sanitizedQuery: `${bodyText(body)} LIMIT ${options.maxRows}` };
  }

  const valueToken = body[limitIdx + 1];
  const requested = valueToken?.type === "word" ? Number.parseInt(valueToken.value, 10) : NaN;
  if (Number.isNaN(requested) || requested > options.maxRows) {
    const before = body.slice(0, limitIdx + 1);
    const after = body.slice(limitIdx + 2);
    return {
      ok: true,
      sanitizedQuery: `${bodyText(before)} ${options.maxRows} ${bodyText(after)}`.trim(),
    };
  }

  return { ok: true, sanitizedQuery: bodyText(body) };
}
