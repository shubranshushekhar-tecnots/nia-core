import { describe, expect, it } from "vitest";
import { KNOWN_APP_ERROR_CODES } from "../appErrorMessages.js";
import { friendlyAppError, type HelpStepKey } from "../appErrorMessages.js";
import { buildDropRoleStatementText, buildGrantStatementText } from "../writeGrantStatement.js";
import { buildReadOnlyStatementText } from "../readOnlyStatement.js";
import {
  getHelpSection,
  HELP_CONTENT,
  HELP_SQL_ILLUSTRATION_VALUES,
  HELP_STEP_CONNECTORS,
  WRITE_CAPABLE_CONNECTOR_IDS,
  type HelpSqlValues,
} from "./content.js";

// All six step names the plan's Layer 2 names ("add connection (per
// connector), read-only user, test connection, grant write access, confirm
// access, revoke access") — used to assert HELP_STEP_CONNECTORS itself
// covers every step, not just that whatever it lists has content.
const ALL_HELP_STEPS: HelpStepKey[] = [
  "add-connection",
  "read-only-user",
  "test-connection",
  "grant-write-access",
  "confirm-access",
  "revoke-access",
];

describe("HELP_STEP_CONNECTORS", () => {
  it("covers every step", () => {
    for (const step of ALL_HELP_STEPS) {
      expect(HELP_STEP_CONNECTORS[step]).toBeDefined();
      expect(HELP_STEP_CONNECTORS[step].length).toBeGreaterThan(0);
    }
  });

  it("derives write-capable connectors from the manifests (today: all four declare insert)", () => {
    expect([...WRITE_CAPABLE_CONNECTOR_IDS].sort()).toEqual(["mongodb", "mysql", "postgres", "supabase"]);
  });
});

describe("HELP_CONTENT", () => {
  it("has a section for every step x connector the real UI can reach — no more, no fewer", () => {
    for (const step of ALL_HELP_STEPS) {
      const expectedConnectors = HELP_STEP_CONNECTORS[step];
      const actualConnectors = Object.keys(HELP_CONTENT[step] ?? {}).sort();
      expect(actualConnectors).toEqual([...expectedConnectors].sort());
    }
  });

  it("every section has non-empty what/why/how/problems", () => {
    for (const step of ALL_HELP_STEPS) {
      for (const connectorId of HELP_STEP_CONNECTORS[step]) {
        const section = getHelpSection(step, connectorId);
        expect(section, `${step} x ${connectorId} should have a section`).toBeDefined();
        expect(section!.what.length).toBeGreaterThan(0);
        expect(section!.why.length).toBeGreaterThan(0);
        expect(section!.how.length).toBeGreaterThan(0);
        expect(section!.problems.length).toBeGreaterThan(0);
        for (const p of section!.problems) {
          expect(p.problem.length).toBeGreaterThan(0);
          expect(p.fix.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("getHelpSection returns undefined for an unrecognized connector id", () => {
    expect(getHelpSection("add-connection", "sqlite")).toBeUndefined();
    expect(getHelpSection("grant-write-access", "sqlite")).toBeUndefined();
  });
});

describe("help SQL matches the generator output exactly (no duplicated SQL text)", () => {
  it("read-only-user's sql(illustration values) equals buildReadOnlyStatementText with the same values, per connector", () => {
    for (const connectorId of HELP_STEP_CONNECTORS["read-only-user"]) {
      const section = getHelpSection("read-only-user", connectorId)!;
      const values = HELP_SQL_ILLUSTRATION_VALUES["read-only-user"]!;
      const expected = buildReadOnlyStatementText(connectorId, values.database, values.roleUser, values.rolePassword);
      expect(section.sql).toBeDefined();
      expect(section.sql!(values)).toBe(expected);
    }
  });

  it("grant-write-access's sql(illustration values) equals buildGrantStatementText with the same values, per connector", () => {
    for (const connectorId of HELP_STEP_CONNECTORS["grant-write-access"]) {
      const section = getHelpSection("grant-write-access", connectorId)!;
      const values = HELP_SQL_ILLUSTRATION_VALUES["grant-write-access"]!;
      const expected = buildGrantStatementText(connectorId, values.namespace, values.roleUser, values.rolePassword);
      expect(section.sql).toBeDefined();
      expect(section.sql!(values)).toBe(expected);
    }
  });

  it("revoke-access's sql(illustration values) equals buildDropRoleStatementText with the same value, per connector", () => {
    for (const connectorId of HELP_STEP_CONNECTORS["revoke-access"]) {
      const section = getHelpSection("revoke-access", connectorId)!;
      const values = HELP_SQL_ILLUSTRATION_VALUES["revoke-access"]!;
      const expected = buildDropRoleStatementText(connectorId, values.roleUser);
      expect(section.sql).toBeDefined();
      expect(section.sql!(values)).toBe(expected);
    }
  });

  it("add-connection/test-connection/confirm-access sections have no sql (nothing to duplicate)", () => {
    for (const step of ["add-connection", "test-connection", "confirm-access"] as const) {
      for (const connectorId of HELP_STEP_CONNECTORS[step]) {
        expect(getHelpSection(step, connectorId)!.sql).toBeUndefined();
      }
    }
  });

  // Proves sql() is a pure passthrough to the generator — not a closure over
  // any baked-in placeholder — by calling it with values that differ from
  // HELP_SQL_ILLUSTRATION_VALUES and asserting the output tracks the new
  // values (not the illustration text).
  it("sql() is generic over its argument — arbitrary (non-illustration) values produce matching, non-illustration output", () => {
    const customValues: HelpSqlValues = {
      database: "custom_db",
      namespace: "custom_schema",
      roleUser: "custom_role",
      rolePassword: "CustomPassword123",
    };

    for (const connectorId of HELP_STEP_CONNECTORS["read-only-user"]) {
      const section = getHelpSection("read-only-user", connectorId)!;
      const expected = buildReadOnlyStatementText(connectorId, customValues.database, customValues.roleUser, customValues.rolePassword);
      const illustration = section.sql!(HELP_SQL_ILLUSTRATION_VALUES["read-only-user"]!);
      const custom = section.sql!(customValues);
      expect(custom).toBe(expected);
      expect(custom).not.toBe(illustration);
    }

    for (const connectorId of HELP_STEP_CONNECTORS["grant-write-access"]) {
      const section = getHelpSection("grant-write-access", connectorId)!;
      const expected = buildGrantStatementText(connectorId, customValues.namespace, customValues.roleUser, customValues.rolePassword);
      const illustration = section.sql!(HELP_SQL_ILLUSTRATION_VALUES["grant-write-access"]!);
      const custom = section.sql!(customValues);
      expect(custom).toBe(expected);
      expect(custom).not.toBe(illustration);
    }

    for (const connectorId of HELP_STEP_CONNECTORS["revoke-access"]) {
      const section = getHelpSection("revoke-access", connectorId)!;
      const expected = buildDropRoleStatementText(connectorId, customValues.roleUser);
      const illustration = section.sql!(HELP_SQL_ILLUSTRATION_VALUES["revoke-access"]!);
      const custom = section.sql!(customValues);
      expect(custom).toBe(expected);
      expect(custom).not.toBe(illustration);
    }
  });
});

// Cross-check against Layer 3: every AppError code's helpStepKey (and every
// helpStepKeyOverride used in the codebase) must point at a step that
// actually exists in HELP_STEP_CONNECTORS, so a Help-panel deep link from an
// error's fix line can never point at a step with no content table entry.
describe("every AppError helpStepKey resolves to a real help step", () => {
  it.each(KNOWN_APP_ERROR_CODES)("%s's helpStepKey is a known help step", (code) => {
    const { helpStepKey } = friendlyAppError(code, "raw message for test");
    expect(helpStepKey).toBeDefined();
    expect(ALL_HELP_STEPS).toContain(helpStepKey);
  });
});
