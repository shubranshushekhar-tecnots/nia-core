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
export type FriendlyConnectionError = { summary: string; details: string };

const RULES: { test: RegExp; summary: string }[] = [
  {
    test: /self[- ]signed certificate|certificate/i,
    summary: "Certificate error — the server's TLS certificate could not be verified.",
  },
  {
    test: /\bssl\b|tls alert/i,
    summary: "TLS handshake failed — check the connection's TLS/SSL setting.",
  },
  {
    test: /enotfound|eai_again/i,
    summary: "Host not found — check the hostname for typos.",
  },
  {
    test: /etimedout|econnrefused/i,
    summary: "Connection timed out or was refused — check the host, port, and firewall/network access.",
  },
  {
    test: /password authentication failed|access denied/i,
    summary: "Authentication failed — check the username and password.",
  },
  {
    test: /permission denied|privilege/i,
    summary: "Missing privileges — this credential doesn't have permission for this action.",
  },
];

export function friendlyConnectionError(raw: string): FriendlyConnectionError {
  const rule = RULES.find((r) => r.test.test(raw));
  return { summary: rule?.summary ?? "Connection failed.", details: raw };
}
