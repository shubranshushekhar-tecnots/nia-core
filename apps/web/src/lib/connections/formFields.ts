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
