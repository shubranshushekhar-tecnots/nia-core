// Guardrail validation logic/allowlists must never ship to the browser.
// This scans apps/web's source tree for any import of @nia/guardrails (or
// a relative path reaching into this package) and fails the build if
// found, since @nia/guardrails is a server-only package.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_SRC = join(import.meta.dirname, "..", "..", "..", "apps", "web", "src");

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...walk(full));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe("apps/web does not import @nia/guardrails", () => {
  it("has no import referencing @nia/guardrails or packages/guardrails", () => {
    const offenders: string[] = [];
    for (const file of walk(WEB_SRC)) {
      const content = readFileSync(file, "utf8");
      if (content.includes("@nia/guardrails") || content.includes("packages/guardrails")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
