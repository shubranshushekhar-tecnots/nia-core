import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = readFileSync(path.join(here, "install.ps1"), "utf8");

describe("packaging/windows/install.ps1", () => {
  // Regression test: on a real Windows host, `$acl.AddAccessRule($rule)` /
  // `Set-Acl` on the data directory fails with "Some or all identity
  // references could not be translated" when it runs before the
  // "NT SERVICE\nia-agent" virtual service account has been registered
  // with the SCM — which only happens once `& $ServiceExe install` has
  // run. The ACL block (and the "logs" subdirectory created right after
  // it, so it inherits the locked-down ACL) must always come after the
  // service install line.
  it("sets the data-dir ACL after `& $ServiceExe install`, never before", () => {
    const installIndex = script.indexOf("& $ServiceExe install");
    const aclIndex = script.indexOf("Set-Acl $DataDir $acl");
    expect(installIndex).toBeGreaterThan(-1);
    expect(aclIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeLessThan(aclIndex);
  });
});
