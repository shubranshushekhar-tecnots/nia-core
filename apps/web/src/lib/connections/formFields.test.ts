import { describe, it, expect } from "vitest";
import type { ConfigField } from "@nia/schemas";
import { autoCompleteFor } from "./formFields.js";

function field(overrides: Partial<ConfigField>): ConfigField {
  return { key: "x", label: "X", type: "text", required: true, secret: false, ...overrides };
}

describe("autoCompleteFor", () => {
  it("marks password fields new-password, so the browser never suggests a saved login for a fresh connection", () => {
    expect(autoCompleteFor(field({ key: "password", type: "password" }))).toBe("new-password");
  });

  it("turns off autocomplete on the username field, for the same reason", () => {
    expect(autoCompleteFor(field({ key: "user", type: "text" }))).toBe("off");
  });

  it("leaves non-credential fields (host, port, database) unset", () => {
    expect(autoCompleteFor(field({ key: "host", type: "text" }))).toBeUndefined();
  });
});
