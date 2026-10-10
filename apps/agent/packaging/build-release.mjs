#!/usr/bin/env node
// Orchestrates a full release build across both packaged platforms
// (Windows + macOS) by shelling out to each OS's existing build-sea.mjs +
// build-bundle.mjs/build-installer.mjs scripts -- this adds nothing new to
// *how* each artifact gets built (a dev can still run those scripts
// individually, exactly as before), it only adds a `--release` gate on
// top of them plus the convenience of running everything in one command.
//
// Usage (from repo root, after `pnpm -r --filter @nia/extract --filter
// @nia/agent build` and, for each platform you're building, `pnpm
// --filter @nia/agent-desktop package` run on that OS -- electron-builder
// only packages the host OS's own target, so a true cross-platform
// release needs that command run once per OS; see RELEASE.md):
//
//   node apps/agent/packaging/build-release.mjs
//     -- dev build: signs with whatever creds are configured, warns and
//        proceeds with an unsigned artifact if none are -- identical to
//        running each per-OS script directly, just doing all of them in
//        one command. This is unchanged from today's behavior.
//
//   node apps/agent/packaging/build-release.mjs --release
//     -- hard-fails (non-zero exit) if ANY required signing step for a
//        built platform was skipped (no credentials configured) -- a
//        --release build can never silently ship unsigned.
//
//   node apps/agent/packaging/build-release.mjs --release --allow-unsigned
//     -- same as --release, but doesn't fail on missing credentials;
//        instead prints a loud "TEST BUILD -- UNSIGNED" banner and drops
//        an UNSIGNED-TEST-BUILD.txt marker alongside that platform's
//        artifacts (dist/), so a deliberately-unsigned release build
//        (e.g. a pre-cert dry run) can still be produced without it ever
//        being mistaken for a real, distributable release.
//
// Other flags:
//   --no-desktop     build service-only artifacts (skip the Electron
//                    shell) -- passed straight through to the per-OS
//                    build-bundle.mjs/build-installer.mjs scripts.
//   --target=windows
//   --target=macos   build only one platform (default: both). macOS
//                    artifacts can only be built when this script itself
//                    is running on a macOS host (codesign/notarytool and
//                    postject's Mach-O injection all require it) -- this
//                    is checked below, not left to fail deep inside
//                    macos/build-sea.mjs.
//
// After the platform build(s) above, this also always re-runs
// generate-manifest.mjs so manifest.json reflects whatever's actually on
// disk (including a platform this run didn't touch, e.g. Linux -- which
// has no signing step and is built via its own separate shell script, not
// this orchestrator).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSigningMode as getWindowsSigningMode } from "./windows/sign.mjs";
import { getSigningStatus as getMacSigningStatus } from "./macos/sign.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const release = args.includes("--release");
const allowUnsigned = args.includes("--allow-unsigned");
const noDesktop = args.includes("--no-desktop");
const targetArg = args.find((a) => a.startsWith("--target="));
const target = targetArg ? targetArg.slice("--target=".length) : "all";

if (!["all", "windows", "macos"].includes(target)) {
  throw new Error(`--target must be "windows", "macos", or omitted (both) -- got "${target}"`);
}

async function main() {
  const buildWindows = target === "all" || target === "windows";
  const buildMacos = target === "all" || target === "macos";

  if (buildMacos && process.platform !== "darwin") {
    throw new Error(
      "macOS artifacts (SEA binary + app bundle signing/notarization) can only be built on a real macOS host -- pass --target=windows to build Windows-only from this host.",
    );
  }

  const bundleArgs = noDesktop ? ["--no-desktop"] : [];

  // Whether THIS Windows build will end up unsigned is already knowable
  // now, purely from env vars -- getWindowsSigningMode() doesn't need a
  // built artifact to answer. That matters because the windows updater
  // (packaging/windows/updater/nia-agent-updater.ps1) checks for
  // UNSIGNED-TEST-BUILD.txt *inside the installed app directory*, not
  // next to the build output -- so the marker has to be written by
  // build-bundle.mjs/build-installer.mjs themselves, into the same
  // stage directory they zip/wrap, before that stage directory is
  // deleted. Writing it here, after the fact, into packaging/windows/
  // dist/ (this build machine's own folder, not the shipped artifact)
  // would never actually reach a real install.
  const windowsWillBeUnsigned = release && allowUnsigned && buildWindows && getWindowsSigningMode() === "none";
  const windowsBundleArgs = windowsWillBeUnsigned ? [...bundleArgs, "--unsigned-test-build"] : bundleArgs;

  if (buildWindows) {
    console.log("\n=== Windows ===");
    run("node", [path.join(here, "windows", "build-sea.mjs")]);
    run("node", [path.join(here, "windows", "build-bundle.mjs"), ...windowsBundleArgs]);
    run("node", [path.join(here, "windows", "build-installer.mjs"), ...windowsBundleArgs]);
  }

  if (buildMacos) {
    console.log("\n=== macOS ===");
    run("node", [path.join(here, "macos", "build-sea.mjs")]);
    run("node", [path.join(here, "macos", "build-bundle.mjs"), ...bundleArgs]);
  }

  // Regenerate manifest.json off whatever's actually on disk -- it already
  // warns and skips any candidate file that isn't present (e.g. Linux,
  // which has no signing step and isn't built by this orchestrator) rather
  // than failing, so it's always safe to run here.
  console.log("\n=== manifest ===");
  run("node", [path.join(here, "generate-manifest.mjs")]);

  if (!release) {
    console.log("\ndev build complete (not a --release build -- see any signing warnings above for what, if anything, was skipped).");
    return;
  }

  console.log("\n=== release gate ===");
  const skipped = [];
  if (buildWindows && getWindowsSigningMode() === "none") skipped.push("windows");
  if (buildMacos && !getMacSigningStatus().signed) skipped.push("macos");

  if (skipped.length === 0) {
    console.log("release gate passed: every built platform was signed.");
    return;
  }

  if (!allowUnsigned) {
    throw new Error(
      `--release build but signing was skipped for: ${skipped.join(", ")} (no credentials configured -- see RELEASE.md). Pass --allow-unsigned to deliberately produce an unsigned test build instead.`,
    );
  }

  console.warn(`\n${"*".repeat(70)}\n*** TEST BUILD -- UNSIGNED (${skipped.join(", ")}) -- NOT FOR DISTRIBUTION ***\n${"*".repeat(70)}\n`);
  for (const platform of skipped) {
    const marker = path.join(here, platform, "dist", "UNSIGNED-TEST-BUILD.txt");
    writeFileSync(
      marker,
      `This ${platform} build was produced with --release --allow-unsigned and is NOT signed.\nDo not distribute. Built ${new Date().toISOString()}.\n`,
    );
  }
}

function run(cmd, cmdArgs) {
  execFileSync(cmd, cmdArgs, { stdio: "inherit", cwd: here });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
