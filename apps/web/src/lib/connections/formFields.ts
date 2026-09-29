import type { ConfigField } from "@nia/schemas";

/**
 * AddConnectionDialog.tsx's autocomplete choice for a config field's input.
 * Extracted so the branching is unit-testable without rendering the
 * component. Bug fix context: with no autocomplete attribute at all, the
 * browser was free to suggest/autofill a *different* connection's saved
 * credentials (e.g. the Supabase admin login autofilling into a fresh Neon
 * connection form) — every connection's credentials are target-specific and
 * should never be suggested from another saved login.
 */
export function autoCompleteFor(field: ConfigField): string | undefined {
  if (field.type === "password") return "new-password";
  if (field.key === "user") return "off";
  return undefined;
}

// Per-connector example for ConnectionForm's "Paste connection URL" field —
// each connector's own URI scheme, so the example a user sees actually
// matches what they're expected to paste (applyPastedUrl only cares about
// the generic host/port/path/userinfo shape `new URL()` gives it, so a
// mongodb connector still works even though its own driver URLs also carry a
// srv-style variant). Extracted so the mapping is unit-testable without
// rendering the component.
const URL_PASTE_PLACEHOLDER: Record<string, string> = {
  postgres: "postgres://user:pass@host:5432/db?sslmode=require",
  supabase: "postgres://user:pass@host:5432/db?sslmode=require",
  mysql: "mysql://user:pass@host:3306/db",
  mongodb: "mongodb://user:pass@host:27017/db",
};
const DEFAULT_URL_PASTE_PLACEHOLDER = "postgres://user:pass@host:5432/db?sslmode=require";

export function urlPastePlaceholder(connectorId: string): string {
  return URL_PASTE_PLACEHOLDER[connectorId] ?? DEFAULT_URL_PASTE_PLACEHOLDER;
}
