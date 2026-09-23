import { describe, it, expect } from "vitest";
import { mysqlManifest } from "./mysql.js";
import { mongodbManifest } from "./mongodb.js";

/**
 * Item 6.3 (fix-chain plan): mysql/mongodb both already have `etl_sink` in
 * `capabilities`, so NodesRail.tsx's palette already offers them as
 * destination nodes. Once dropped as a destination, mapping.ts's
 * initialOperation and NodeDrawer.tsx's operationsForRole both resolve
 * against `operations` — without "insert" there, a destination node got no
 * initial operation and the verb-radio fell back to showing "read" (a
 * nonsensical verb for a destination). This asserts the fix.
 */
describe("connector manifests — Item 6.3 destination operations", () => {
  it("mysql/mongodb manifests include 'insert' in operations, matching their etl_sink capability", () => {
    expect(mysqlManifest.operations).toContain("insert");
    expect(mongodbManifest.operations).toContain("insert");
  });
});
