import { describe, it, expect } from "vitest";
import { isAddMappingEntryDisabled } from "./mappingEntryGate.js";

describe("isAddMappingEntryDisabled", () => {
  it("disables while the source schema is still loading", () => {
    expect(isAddMappingEntryDisabled({ sourceFieldsLoading: true, destFieldsLoading: false })).toBe(true);
  });

  it("disables while the destination schema is still loading", () => {
    expect(isAddMappingEntryDisabled({ sourceFieldsLoading: false, destFieldsLoading: true })).toBe(true);
  });

  it("allows once both schemas have resolved", () => {
    expect(isAddMappingEntryDisabled({ sourceFieldsLoading: false, destFieldsLoading: false })).toBe(false);
  });
});
