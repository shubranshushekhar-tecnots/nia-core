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
  //
  // "truncate" and "replace" are carved out when used as function calls
  // (immediately followed by "("): MySQL's TRUNCATE(x, digits) is a real,
  // harmless numeric function (packages/schemas's math-fn SQL emission
  // relies on it) unrelated to the destructive TRUNCATE TABLE statement;
  // MySQL's REPLACE(str, from, to) (Phase 8b-2 batch 3: found live via
  // agreement-testing — packages/schemas's substitute()/split() text-fn SQL
  // emission relies on it) is a read-only string function unrelated to the
  // mutating REPLACE INTO statement. Neither destructive statement form can
  // reach this branch anyway — the leading-keyword allowlist above already
  // requires the query to start with SELECT/WITH, and the single-statement
  // check rejects any `;`-separated second statement, so a bare
  // "truncate"/"replace" appearing mid-body can only ever be an
  // identifier/function-call use, never the DDL/DML statement. The
  // `(`-follows guard keeps each carve-out narrow (a bare "truncate"/
  // "replace" with no parens still trips the blocklist) rather than
  // removing the keyword from FORBIDDEN_KEYWORDS outright.
  const CALL_CARVE_OUTS = new Set(["truncate", "replace"]);
  for (let i = 0; i < body.length; i++) {
    const t = body[i]!;
    if (t.type !== "word" || !FORBIDDEN_KEYWORDS.has(t.value.toLowerCase())) continue;
    const isCallCarveOut =
      CALL_CARVE_OUTS.has(t.value.toLowerCase()) && body[i + 1]?.type === "punct" && body[i + 1]?.value === "(";
    if (isCallCarveOut) continue;
    return { ok: false, reason: `Forbidden keyword: ${t.value}` };
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

  // Reconstruct from significant tokens only, using each token's own
  // SOURCE SPAN (sql.slice(t.start, t.end), not the (currently identical,
  // but not contractually guaranteed) t.value) and joining by SOURCE
  // ADJACENCY: no space between two tokens that were touching in the
  // original input (prev.end === t.start), a single space wherever there
  // was any gap (real whitespace, or a comment — both were filtered out
  // of `significant()` above, so a gap here just means "something sat
  // between these two tokens in the source and it wasn't itself a
  // significant token").
  //
  // This subsumes what used to be a hand-maintained MULTI_CHAR_OPERATORS
  // allowlist (`<>`, `!=`, `<=`, `>=`, `~*`, `||`, ...) that had already
  // missed two real, live-reachable operators once (Phase 8b-2 batch 6:
  // `~*`/`||` were corrupted into invalid SQL — `~ *`, `| |` — before
  // being added to the list by hand). Adjacency makes the whole class of
  // "tokenizer splits an operator the source never split" bugs
  // structurally unreachable: ANY two tokens that were adjacent in the
  // input come back out adjacent, with no per-operator allowlist to keep
  // up to date. This also naturally handles qualified identifiers
  // (`t`.`id`) and decimal literals (`3`.`14`) the same way the old
  // explicit `.`/`,` special-casing did — those tokens are adjacent in
  // real SQL, so they stay adjacent here too, with no special-casing
  // needed at all.
  //
  // Comment-stripping is the actual security invariant this whole
  // function exists to preserve, and it still holds: `significant()`
  // already dropped every comment token before `body`/`before`/`after`
  // were built, so a comment's span is never sliced out of `sql` and
  // never appears in the reconstructed text — including MySQL's
  // executable `/*! ... */` version-conditional syntax and `/*+ ... */`
  // optimizer hints (both tokenize as ordinary block comments here, and
  // this validator's own header already discloses that MySQL itself does
  // NOT treat `/*! ... */` as inert — see that disclaimer for the
  // still-open gap in the keyword *scan*). The one thing this function
  // must never regress to is slicing a contiguous range of the ORIGINAL
  // string spanning a comment (that would silently resurrect whatever
  // the comment contained, character-for-character, as live SQL sent to
  // the server) — it only ever concatenates per-significant-token spans,
  // never a single larger span that could straddle a dropped token.
  const bodyText = (tks: Token[]) =>
    tks.reduce((out, t, i) => {
      const text = sql.slice(t.start, t.end);
      if (i === 0) return text;
      const prev = tks[i - 1]!;
      return prev.end === t.start ? `${out}${text}` : `${out} ${text}`;
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
