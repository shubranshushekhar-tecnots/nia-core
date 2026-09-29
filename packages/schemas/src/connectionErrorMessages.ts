/**
 * Item 5 (fix-chain plan): raw driver/connector error text flowed straight
 * to the UI everywhere a connection test/dispatch could fail (web's
 * `apiErrorMessage()`, connector `/test` endpoints returning `e.message`
 * raw) — a real user has no way to act on `ENOTFOUND db.typo.example.com`
 * or `password authentication failed for user "nia_ro"` without already
 * knowing what those mean. This is a pure pattern-match over the raw
 * message into a short, actionable `summary`, with the original `raw` text
 * always preserved in `details` (never dropped — surfaced behind a
 * "Show details" toggle at each call site) so nothing is silently hidden
 * for someone who does want the raw driver text.
 *
 * Matching is case-insensitive substring/regex matching over common
 * driver/connector error text (pg, mysql2, mongodb, node's own DNS/socket
 * errors) — not exhaustive, just the categories seen in this codebase's own
 * manual E2E testing. Order matters: more specific checks (certificate)
 * come before more general ones (generic SSL/TLS) since a certificate error
 * message can also happen to contain "SSL".
 */
export type FriendlyConnectionError = { summary: string; fix?: string; details: string };

const RULES: { test: RegExp; summary: string; fix: string }[] = [
  {
    test: /self[- ]signed certificate|certificate/i,
    summary: "Certificate error — the server's TLS certificate could not be verified.",
    fix: "Check that the server's certificate is valid and trusted, or that the connection's SSL/TLS mode matches what the server expects.",
  },
  {
    test: /\bssl\b|tls alert/i,
    summary: "TLS handshake failed — check the connection's TLS/SSL setting.",
    fix: "Try switching the connection's SSL/TLS mode (e.g. require/prefer/disable) to match what the server expects.",
  },
  {
    test: /enotfound|eai_again/i,
    summary: "Host not found — check the hostname for typos.",
    fix: "Double-check the host for typos, and that it resolves from where this runs.",
  },
  {
    test: /etimedout|econnrefused|econnreset/i,
    summary: "Connection timed out or was refused — check the host, port, and firewall/network access.",
    fix: "Check the host and port are correct, and that this database allows inbound connections from Nia (firewall/security group/allowlist).",
  },
  {
    // Supabase's Supavisor pooler rejects a bare (unqualified) role name with
    // this text — the fix is a different username, not a different
    // password, so this needs its own summary rather than falling into the
    // generic "Authentication failed" bucket below. Covers both the wire
    // error Supavisor itself returns ("(ENOIDENTIFIER) no tenant identifier
    // provided (external_id or sni_hostname required)", plus its older
    // "Tenant or user not found" phrasing) and the client-side guard thrown
    // by services/connector-supabase/src/poolerUsername.ts's
    // resolvePoolerUsername when it has no project ref to qualify the
    // username with before even attempting to connect.
    test: /tenant or user not found|no tenant identifier|no project ref could be determined/i,
    summary: 'Wrong pooler username — Supabase pooler connections need the qualified "role.project-ref" username, not just the role name.',
    fix: 'Use the pooler connection string\'s username, formatted "<role>.<project-ref>", not just the role name.',
  },
  {
    test: /unknown database|er_bad_db_error/i,
    summary: "Database not found — check the database name for typos.",
    fix: "Double-check the database name for typos.",
  },
  {
    test: /password authentication failed|access denied|authentication failed|bad auth/i,
    summary: "Authentication failed — check the username and password.",
    fix: "Double-check the username and password — a copy-paste error or stale/rotated credential is the most common cause.",
  },
  {
    // Postgres/Supabase-specific: this fires on INSERT/UPDATE/DELETE, not a
    // missing GRANT, so it needs a distinct summary from the generic
    // "Missing privileges" one below (re-running a GRANT won't fix it — an
    // RLS policy needs to be added/adjusted instead).
    test: /row-level security policy/i,
    summary: "Blocked by a Row-Level Security policy — this role doesn't have a policy allowing this action.",
    fix: "Add or adjust a Row-Level Security policy on this table to allow this role to perform this action.",
  },
  {
    test: /permission denied|privilege/i,
    summary: "Missing privileges — this credential doesn't have permission for this action.",
    fix: "Grant this credential the missing privilege (e.g. SELECT/INSERT/UPDATE) on the affected table/schema.",
  },
];

export function friendlyConnectionError(raw: string): FriendlyConnectionError {
  const rule = RULES.find((r) => r.test.test(raw));
  if (!rule) return { summary: "Connection failed.", details: raw };
  return { summary: rule.summary, fix: rule.fix, details: raw };
}
