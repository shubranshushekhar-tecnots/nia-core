#!/usr/bin/env node
// Assembles the full macOS install bundle: the agent SEA executable (built
// by build-sea.mjs), the launchd plist template, and install/uninstall
// shell scripts — zipped into one file. No downloads happen here;
// build-sea.mjs already fetched and verified everything it needed.
//
// Usage (from repo root, after `pnpm -r --filter @nia/extract --filter
// @nia/agent build` and `pnpm --filter @nia/agent-desktop package`):
//   node apps/agent/packaging/macos/build-sea.mjs
//   node apps/agent/packaging/macos/build-bundle.mjs
//
// The desktop app shell (apps/agent-desktop) is required by default -- pass
// --no-desktop to build a service-only bundle for dev/testing:
//   node apps/agent/packaging/macos/build-bundle.mjs --no-desktop
//
// Produces apps/agent/packaging/macos/dist/nia-core-agent-macos-arm64-<version>.zip
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  cpSync,
  readdirSync,
  rmSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codesignBinary, notarizeAndStaple } from "./sign.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.resolve(here, "../../");
const distDir = path.join(here, "dist");

// Opt-in escape hatch for dev-only, service-only builds. Without it, a
// missing Electron build output is a hard failure (see stageAgentDesktop)
// so a real bundle can never silently ship without the desktop shell.
const noDesktop = process.argv.slice(2).includes("--no-desktop");

async function main() {
  const version = JSON.parse(readFileSync(path.join(agentDir, "package.json"), "utf8")).version;
  const seaExePath = path.join(distDir, "nia-agent");
  if (!existsSync(seaExePath)) {
    throw new Error(`${seaExePath} not found — run build-sea.mjs first`);
  }

  const stageDir = path.join(distDir, "stage");
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  console.log("[1/3] staging agent executable, plist template, and scripts...");
  copyFileSync(seaExePath, path.join(stageDir, "nia-agent"));
  chmodSync(path.join(stageDir, "nia-agent"), 0o755);
  copyFileSync(path.join(here, "nia-agent.plist.template"), path.join(stageDir, "nia-agent.plist.template"));
  copyFileSync(path.join(here, "install.sh"), path.join(stageDir, "install.sh"));
  copyFileSync(path.join(here, "uninstall.sh"), path.join(stageDir, "uninstall.sh"));
  chmodSync(path.join(stageDir, "install.sh"), 0o755);
  chmodSync(path.join(stageDir, "uninstall.sh"), 0o755);
  writeFileSync(path.join(stageDir, "VERSION.txt"), `Nia Core Agent ${version} (darwin-arm64)\nBuilt ${new Date().toISOString()}\n`);

  if (noDesktop) {
    console.log("[2/3] --no-desktop passed -- skipping the desktop app shell (service-only build)...");
  } else {
    console.log("[2/3] staging the desktop app shell (apps/agent-desktop)...");
    const notarized = await stageAgentDesktop(stageDir);
    if (notarized) {
      // install.sh checks for this sentinel (alongside "Nia Core Agent.app" in
      // the zip, not inside the bundle) to decide whether it's safe to
      // skip its own `xattr -dr com.apple.quarantine` workaround -- a
      // stapled, notarized bundle should rely on Gatekeeper/the stapled
      // ticket instead; an unsigned dev build still needs the workaround.
      writeFileSync(path.join(stageDir, ".notarized"), "");
    }
  }

  console.log("[3/3] zipping bundle...");
  const zipName = `nia-core-agent-macos-arm64-${version}.zip`;
  const zipPath = path.join(distDir, zipName);
  rmSync(zipPath, { force: true });
  // -y preserves symlinks (none here) and, more importantly, file modes
  // (the exec bits on nia-agent/install.sh/uninstall.sh) so unzip on the
  // target machine restores them without a separate chmod step.
  execFileSync("zip", ["-r", "-q", "-y", zipPath, "."], { cwd: stageDir });
  rmSync(stageDir, { recursive: true, force: true });

  console.log(`\nbuilt ${zipPath}`);
  console.log(`sha256: ${sha256File(zipPath)}`);
}

// Required by default, same reasoning as windows/build-installer.mjs's
// helper of the same name -- a real bundle must never silently ship
// without the desktop shell. Pass --no-desktop to intentionally build a
// service-only bundle (dev builds only); install.sh already only copies
// "Nia Core Agent.app" into /Applications when it's present, so a --no-desktop
// bundle is still a working, service-only install.
async function stageAgentDesktop(stageDir) {
  const desktopBuildDir = path.join(agentDir, "..", "agent-desktop", "dist-electron");
  if (!existsSync(desktopBuildDir)) {
    throw new Error(
      `apps/agent-desktop/dist-electron not found -- run \`pnpm --filter @nia/agent-desktop package\` first to include the desktop app shell, or pass --no-desktop to build a service-only bundle.`,
    );
  }
  const macDirName = readdirSync(desktopBuildDir).find((name) => /^mac/i.test(name));
  if (!macDirName) {
    throw new Error(
      `no mac-unpacked output under apps/agent-desktop/dist-electron -- run \`pnpm --filter @nia/agent-desktop package\` first, or pass --no-desktop to build a service-only bundle.`,
    );
  }
  const src = path.join(desktopBuildDir, macDirName, "Nia Core Agent.app");
  if (!existsSync(src)) {
    throw new Error(`expected ${src} -- check apps/agent-desktop/electron-builder.yml's productName`);
  }
  const dest = path.join(stageDir, "Nia Core Agent.app");
  cpSync(src, dest, { recursive: true });
  console.log(`  staged desktop app shell from ${src}`);

  // --deep: sign nested frameworks/helper processes first, then the outer
  // bundle -- the standard order for an Electron hardened-runtime app
  // bundle (a handful of distinct Mach-O binaries inside Contents/, not
  // just the one outer executable the SEA builds sign).
  const signed = codesignBinary(dest, { deep: true });
  if (!signed) return false;
  return notarizeAndStaple(dest, { isAppBundle: true });
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
