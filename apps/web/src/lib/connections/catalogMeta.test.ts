import { describe, it, expect } from "vitest";
import { CATALOG_ORDER, CONNECTOR_CATALOG_META, catalogIndexLabel } from "./catalogMeta.js";

describe("catalogIndexLabel", () => {
  it("returns a stable two-digit label matching CATALOG_ORDER position", () => {
    expect(catalogIndexLabel("mysql")).toBe("01");
    expect(catalogIndexLabel("s3")).toBe("12");
  });

  it("returns an empty string for an id not in CATALOG_ORDER", () => {
    expect(catalogIndexLabel("not-a-connector")).toBe("");
  });
});

describe("CONNECTOR_CATALOG_META", () => {
  it("has a metadata entry for every id in CATALOG_ORDER", () => {
    for (const id of CATALOG_ORDER) {
      const meta = CONNECTOR_CATALOG_META[id];
      expect(meta).toBeDefined();
      expect(meta?.id).toBe(id);
    }
  });

  it("only marks the 4 real connectors as not comingSoon", () => {
    const live = CATALOG_ORDER.filter((id) => !CONNECTOR_CATALOG_META[id]?.comingSoon);
    expect(live.sort()).toEqual(["mongodb", "mysql", "postgres", "supabase"].sort());
  });
});
