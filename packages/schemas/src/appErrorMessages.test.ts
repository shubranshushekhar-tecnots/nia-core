import { describe, expect, it } from "vitest";
import { friendlyAppError, KNOWN_APP_ERROR_CODES, type HelpStepKey } from "./appErrorMessages.js";

const VALID_HELP_STEP_KEYS: HelpStepKey[] = [
  "add-connection",
  "read-only-user",
  "test-connection",
  "grant-write-access",
  "confirm-access",
  "revoke-access",
];

describe("friendlyAppError", () => {
  it("has a non-empty fix line and a valid help step key for every known AppError code — no code can ship without one", () => {
    for (const code of KNOWN_APP_ERROR_CODES) {
      const result = friendlyAppError(code, "some raw message");
      expect(result.summary, `${code} produced an empty summary`).toBeTruthy();
      expect(result.fix, `${code} is missing a fix line`).toBeTruthy();
      expect(result.helpStepKey, `${code} is missing a help step key`).toBeTruthy();
      expect(VALID_HELP_STEP_KEYS.includes(result.helpStepKey as HelpStepKey), `${code} has an unrecognized help step key "${result.helpStepKey}"`).toBe(
        true,
      );
    }
  });

  it("NOT_INSTALLED maps to a fixed plain message, keeping the raw connector-id message as details", () => {
    const result = friendlyAppError("NOT_INSTALLED", '"mysql" must be installed before connecting.');
    expect(result.summary).toBe("This connector isn't installed yet.");
    expect(result.details).toBe('"mysql" must be installed before connecting.');
    expect(result.helpStepKey).toBe("add-connection");
  });

  it("MISSING_FIELD maps to a fixed plain message", () => {
    const result = friendlyAppError("MISSING_FIELD", 'Missing required field "host".');
    expect(result.summary).toBe("A required field is missing.");
    expect(result.details).toBe('Missing required field "host".');
  });

  it("NAME_TAKEN passes the already-specific raw message through as the summary instead of replacing it", () => {
    const raw = 'A connection named "Prod MySQL" already exists.';
    const result = friendlyAppError("NAME_TAKEN", raw);
    expect(result.summary).toBe(raw);
    expect(result.details).toBe(raw);
    expect(result.fix).toContain("different name");
  });

  it("HANDLE_EXHAUSTED maps to a fixed plain message", () => {
    const result = friendlyAppError("HANDLE_EXHAUSTED", 'Could not mint a unique handle from "mysql-x" after 20 attempts.');
    expect(result.summary).toBe("Couldn't generate a unique identifier for this connection.");
  });

  it("CREATE_FAILED defaults to the add-connection help step, but a caller can override it (e.g. for write-grant creation)", () => {
    const withoutOverride = friendlyAppError("CREATE_FAILED", "duplicate key value violates unique constraint");
    expect(withoutOverride.helpStepKey).toBe("add-connection");

    const withOverride = friendlyAppError("CREATE_FAILED", "Failed to create write grant.", "grant-write-access");
    expect(withOverride.helpStepKey).toBe("grant-write-access");
    expect(withOverride.summary).toBe("Couldn't create this — something went wrong on our end.");
  });

  it("CONFIRM_FAILED and REVOKE_FAILED map to their own fixed messages and help steps", () => {
    expect(friendlyAppError("CONFIRM_FAILED", "Could not confirm this write grant.").summary).toBe("Couldn't confirm this write grant.");
    expect(friendlyAppError("CONFIRM_FAILED", "...").helpStepKey).toBe("confirm-access");
    expect(friendlyAppError("REVOKE_FAILED", "Could not revoke this write grant.").summary).toBe("Couldn't revoke this write grant.");
    expect(friendlyAppError("REVOKE_FAILED", "...").helpStepKey).toBe("revoke-access");
  });

  it("INTROSPECT_FAILED delegates to friendlyConnectionError's driver-text pattern matching instead of using a fixed message", () => {
    const result = friendlyAppError("INTROSPECT_FAILED", "connect ETIMEDOUT 10.0.0.5:5432");
    expect(result.summary).toBe("Connection timed out or was refused — check the host, port, and firewall/network access.");
    expect(result.details).toBe("connect ETIMEDOUT 10.0.0.5:5432");
    expect(result.helpStepKey).toBe("test-connection");
  });

  it("falls back to the raw message (no fix/help step) for an unrecognized code, never hiding it", () => {
    const result = friendlyAppError("SOME_FUTURE_CODE", "raw text from a code this map doesn't know about yet");
    expect(result.summary).toBe("raw text from a code this map doesn't know about yet");
    expect(result.details).toBe(result.summary);
    expect(result.fix).toBeUndefined();
    expect(result.helpStepKey).toBeUndefined();
  });
});
