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

  it("UNKNOWN_CONNECTOR and ALREADY_INSTALLED pass their already-specific install-path messages through as the summary", () => {
    const unknown = friendlyAppError("UNKNOWN_CONNECTOR", 'No manifest for connector "not-a-real-connector".');
    expect(unknown.summary).toBe('No manifest for connector "not-a-real-connector".');
    expect(unknown.fix).toContain("Pick a connector");

    const already = friendlyAppError("ALREADY_INSTALLED", '"mysql" is already installed.');
    expect(already.summary).toBe('"mysql" is already installed.');
    expect(already.fix).toContain("already installed");
  });

  it("INSTALL_FAILED and UNINSTALL_FAILED map to their own fixed 'something went wrong' messages", () => {
    expect(friendlyAppError("INSTALL_FAILED", "insert or update on table violates constraint").summary).toBe(
      "Couldn't install this connector — something went wrong on our end.",
    );
    expect(friendlyAppError("UNINSTALL_FAILED", "some db error").summary).toBe(
      "Couldn't uninstall this connector — something went wrong on our end.",
    );
  });

  it("NOT_FOUND passes its already-specific 'X not found' message through as the summary for any of its call sites", () => {
    expect(friendlyAppError("NOT_FOUND", "Connector install not found.").summary).toBe("Connector install not found.");
    expect(friendlyAppError("NOT_FOUND", "Connection not found.").summary).toBe("Connection not found.");
  });

  it("CONNECTOR_IN_USE passes its connection-count message through — it has no structured workflow details to name", () => {
    const raw = 'Cannot uninstall "mysql" while 2 connection(s) still use it.';
    const result = friendlyAppError("CONNECTOR_IN_USE", raw);
    expect(result.summary).toBe(raw);
    expect(result.fix).toContain("connections");
  });

  it("IN_USE names the affected workflows from the AppError's details when provided", () => {
    const withDetails = friendlyAppError("IN_USE", "This connection is used by other workflows.", undefined, {
      workflows: [
        { id: "w1", name: "ETL kill-resume smoke", nodeCount: 2, cleanPlanCount: 0 },
        { id: "w2", name: "Nightly sync", nodeCount: 1, cleanPlanCount: 1 },
      ],
    });
    expect(withDetails.summary).toBe("This connection is used by other workflows.");
    expect(withDetails.fix).toBe("Used by: ETL kill-resume smoke, Nightly sync. Remove it from those workflows first, or confirm the delete anyway.");
    expect(withDetails.helpStepKey).toBe("add-connection");
  });

  it("IN_USE falls back to a generic fix line when no workflow details are provided", () => {
    const withoutDetails = friendlyAppError("IN_USE", "This connection is used by other workflows.");
    expect(withoutDetails.fix).toBe("Remove it from any workflows that use it first, or confirm the delete anyway.");
  });

  it("DELETE_FAILED maps to its own fixed 'something went wrong' message", () => {
    expect(friendlyAppError("DELETE_FAILED", "foreign key constraint violation").summary).toBe(
      "Couldn't delete this — something went wrong on our end.",
    );
  });
});
