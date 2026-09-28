/**
 * Layer 3, second half (docs/plans/learning-mode.md) — `connectionErrorMessages.ts`
 * only covers raw connector/driver text. The other class of error a user hits
 * in the connection/grant flow is Nia's own `AppError` codes (apps/api/src
 * throwing structured, Nia-authored errors like NOT_INSTALLED or
 * HANDLE_EXHAUSTED) — those need a plain message + a concrete fix line + a
 * pointer to the matching Help panel step (Layer 2's `help/content.ts`,
 * keyed the same way — see `HelpStepKey` below), not driver-text pattern
 * matching.
 *
 * `APP_ERROR_MESSAGES` is the single source of truth: it's typed as
 * `Record<KnownAppErrorCode, AppErrorEntry>`, so adding a new code to
 * `KNOWN_APP_ERROR_CODES` without adding a matching entry here is a
 * TypeScript compile error, not a silently-missing message — no separate
 * "todo: wire this up" step to forget. `appErrorMessages.test.ts` also
 * iterates the list at runtime as a second safety net (catching, e.g., an
 * empty fix string that would satisfy the type but not a real user).
 */
import { friendlyConnectionError } from "./connectionErrorMessages.js";

/**
 * Mirrors the step names docs/plans/learning-mode.md's Layer 2 draws the
 * Help panel content for ("add connection (per connector), read-only user,
 * test connection, grant write access, confirm access, revoke access") —
 * Step 3's `help/content.ts` should import this type rather than redeclare
 * it, so the two layers can never drift out of key-naming sync.
 */
export type HelpStepKey =
  | "add-connection"
  | "read-only-user"
  | "test-connection"
  | "grant-write-access"
  | "confirm-access"
  | "revoke-access";

export type FriendlyAppError = {
  summary: string;
  fix?: string;
  helpStepKey?: HelpStepKey;
  details: string;
};

export const KNOWN_APP_ERROR_CODES = [
  "NOT_INSTALLED",
  "MISSING_FIELD",
  "NAME_TAKEN",
  "HANDLE_EXHAUSTED",
  "CREATE_FAILED",
  "CONFIRM_FAILED",
  "REVOKE_FAILED",
  "INTROSPECT_FAILED",
] as const;

export type KnownAppErrorCode = (typeof KNOWN_APP_ERROR_CODES)[number];

type AppErrorEntry = { fix: string; helpStepKey: HelpStepKey } & (
  | { message: string }
  // The raw AppError message is already specific/user-facing enough
  // (e.g. NAME_TAKEN's `A connection named "X" already exists.`) —
  // show it as-is instead of replacing it with a less specific summary.
  | { passthrough: true }
  // Unlike every other code here, this code's message is NOT
  // Nia-authored plain text: apps/api/src/services/connections.ts's
  // getConnectionSchema sets INTROSPECT_FAILED's message to the
  // connector service's raw introspection error verbatim
  // (`result.error.message`) — route it through friendlyConnectionError's
  // driver-text pattern matching instead of a fixed summary.
  | { delegatesToConnectorError: true }
);

const APP_ERROR_MESSAGES: Record<KnownAppErrorCode, AppErrorEntry> = {
  // apps/api/src/services/connections.ts:201 (createConnection)
  NOT_INSTALLED: {
    message: "This connector isn't installed yet.",
    fix: "Install the connector first, then create the connection.",
    helpStepKey: "add-connection",
  },
  // apps/api/src/services/connections.ts:141, :171 (create/updateConnection)
  MISSING_FIELD: {
    message: "A required field is missing.",
    fix: "Fill in every required field — check for one left blank.",
    helpStepKey: "add-connection",
  },
  // apps/api/src/services/connections.ts:237, :423 (create/updateConnection)
  NAME_TAKEN: {
    passthrough: true,
    fix: "Choose a different name for this connection.",
    helpStepKey: "add-connection",
  },
  // apps/api/src/services/connections.ts:242 (createConnection)
  HANDLE_EXHAUSTED: {
    message: "Couldn't generate a unique identifier for this connection.",
    fix: "Try a different display name.",
    helpStepKey: "add-connection",
  },
  // apps/api/src/services/connections.ts:227 (createConnection) AND
  // apps/api/src/services/grants.ts:104/109 (createWriteGrant) share this
  // code — both are generic "something broke on our end" wrappers around
  // an unexpected DB/RPC error, so one summary covers both. Callers on the
  // write-grant path should pass `helpStepKeyOverride: "grant-write-access"`
  // to friendlyAppError, since the default below assumes the more common
  // connection-creation case.
  CREATE_FAILED: {
    message: "Couldn't create this — something went wrong on our end.",
    fix: "Try again. If it keeps happening, contact support.",
    helpStepKey: "add-connection",
  },
  // apps/api/src/services/grants.ts:181/186 (confirmWriteGrant)
  CONFIRM_FAILED: {
    message: "Couldn't confirm this write grant.",
    fix: "The grant may already be confirmed or revoked — refresh its status before retrying.",
    helpStepKey: "confirm-access",
  },
  // apps/api/src/services/grants.ts:203/208 (revokeWriteGrant)
  REVOKE_FAILED: {
    message: "Couldn't revoke this write grant.",
    fix: "The grant may already be revoked — refresh its status before retrying.",
    helpStepKey: "revoke-access",
  },
  // apps/api/src/services/connections.ts:591 (getConnectionSchema)
  INTROSPECT_FAILED: {
    delegatesToConnectorError: true,
    fix: "Check the credentials and permissions this connection uses, then refresh again.",
    helpStepKey: "test-connection",
  },
};

/**
 * `helpStepKeyOverride` lets a call site correct the default help step for
 * codes shared across more than one operation (see CREATE_FAILED above).
 * An unrecognized code falls back to showing the raw message as both
 * `summary` and `details` with no `fix`/`helpStepKey` — never hidden, just
 * not (yet) mapped to a friendlier one.
 */
export function friendlyAppError(code: string, rawMessage: string, helpStepKeyOverride?: HelpStepKey): FriendlyAppError {
  const entry = APP_ERROR_MESSAGES[code as KnownAppErrorCode];
  if (!entry) return { summary: rawMessage, details: rawMessage };

  const helpStepKey = helpStepKeyOverride ?? entry.helpStepKey;

  if ("delegatesToConnectorError" in entry) {
    const { summary, details } = friendlyConnectionError(rawMessage);
    return { summary, fix: entry.fix, helpStepKey, details };
  }

  const summary = "passthrough" in entry ? rawMessage : entry.message;
  return { summary, fix: entry.fix, helpStepKey, details: rawMessage };
}
