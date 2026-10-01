import { createHash } from "node:crypto";
import type { Catalog } from "@nia/extract";

/**
 * Stable across repeated introspections of an unchanged schema — excludes
 * `generatedAt`, which always differs even when nothing else has, so it
 * must not affect whether a catalog push is considered "changed".
 */
export function computeCatalogFingerprint(catalog: Catalog): string {
  const stable = { sourceTimeZone: catalog.sourceTimeZone, tables: catalog.tables };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
