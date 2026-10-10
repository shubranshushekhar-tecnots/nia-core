#!/usr/bin/env node
// Developer-ID-signs and notarizes a macOS binary (nia-agent, the SEA
// executable built by build-sea.mjs) or app bundle (Nia Core Agent.app, the
// Electron shell staged by build-bundle.mjs) using whichever Apple
// credentials are configured in the environment. Called from those two
// build scripts, never a standalone script.
//
// Requires a real macOS host -- codesign/notarytool/stapler have no
// cross-platform equivalent (same constraint build-sea.mjs's own ad-hoc
// `codesign --sign -` step already lives under).
//
// Two independent env-var groups -- signing can run without notarization
// (a Developer-ID-signed-but-not-notarized build still launches, Gatekeeper
// just does a slower online check instead of reading a stapled ticket),
// but notarization never runs without signing (Apple requires a Developer
// ID signature before a notarization submission is even accepted):
//
//   Signing:
//     APPLE_DEVELOPER_ID_APPLICATION   codesign identity string, e.g.
//                                      "Developer ID Application: Nia Core, Inc. (TEAMID)"
//     APPLE_TEAM_ID                    10-char Apple Developer Team ID
//
//   Notarization (also requires the above):
//     APPLE_NOTARIZATION_API_KEY_ID           App Store Connect API key ID
//     APPLE_NOTARIZATION_API_KEY_ISSUER_ID    App Store Connect API key issuer UUID
//     APPLE_NOTARIZATION_API_KEY_P8_BASE64    base64-encoded .p8 private key file
//
//   Neither signing group set -> no-op, logs a clear "unsigned" warning
//   (today's ad-hoc-only behavior, unchanged). Signing set but not
//   notarization -> signs, logs a softer "not notarized" warning.
//
// Auth is the modern App Store Connect API key flow -- notarytool's
// documented replacement for app-specific passwords, confirmed against
// Apple's own `notarytool` man page: `xcrun notarytool submit <path> --key
// <p8-file> --key-id <id> --issuer <issuer> --wait`. Never combine
// --key/--key-id/--issuer with --apple-id/--team-id -- Apple's docs call
// out mixing API-key and Apple-ID auth flags as an error.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entitlementsPath = path.join(here, "entitlements.plist");

function hasSigningCreds() {
  return Boolean(process.env.APPLE_DEVELOPER_ID_APPLICATION && process.env.APPLE_TEAM_ID);
}

function hasNotarizationCreds() {
  return Boolean(
    process.env.APPLE_NOTARIZATION_API_KEY_ID &&
      process.env.APPLE_NOTARIZATION_API_KEY_ISSUER_ID &&
      process.env.APPLE_NOTARIZATION_API_KEY_P8_BASE64,
  );
}

let warnedUnsigned = false;
function warnUnsignedOnce() {
  if (warnedUnsigned) return;
  warnedUnsigned = true;
  console.warn(
    "[sign.mjs] unsigned (no Developer ID credentials configured) -- set APPLE_DEVELOPER_ID_APPLICATION/APPLE_TEAM_ID (+ APPLE_NOTARIZATION_API_KEY_ID/_ISSUER_ID/_P8_BASE64 to also notarize) to produce a Gatekeeper-clean build. See RELEASE.md.",
  );
}

/**
 * Developer-ID-signs `filePath` in place with the hardened runtime and this
 * package's entitlements.plist (JIT / unsigned-executable-memory / disabled
 * library validation -- required by both the Node SEA binary and Electron's
 * own V8, which otherwise crash on launch under the hardened runtime).
 *
 * No-ops (leaves whatever ad-hoc signature the caller already applied, e.g.
 * build-sea.mjs's own `codesign --sign -`) when signing creds aren't
 * configured. Returns true iff a real Developer ID signature was applied.
 */
export function codesignBinary(filePath, { deep = false } = {}) {
  if (!hasSigningCreds()) {
    warnUnsignedOnce();
    return false;
  }
  assertToolAvailable("codesign");
  const args = ["--force", "--options", "runtime", "--entitlements", entitlementsPath, "--sign", process.env.APPLE_DEVELOPER_ID_APPLICATION, "--timestamp"];
  if (deep) args.push("--deep");
  args.push(filePath);
  console.log(`[sign.mjs] codesigning ${path.basename(filePath)} (Developer ID)...`);
  execFileSync("codesign", args, { stdio: "inherit" });
  console.log(`[sign.mjs] codesigned ${path.basename(filePath)}`);
  return true;
}

/**
 * Submits `filePath` (a Developer-ID-signed app bundle or standalone
 * executable) to Apple's notary service and staples the resulting ticket
 * once approved. No-ops with a warning if notarization creds aren't
 * configured (even when signing creds ARE) -- a signed-but-not-notarized
 * build still runs, just with a slower first-launch Gatekeeper check, so
 * this is a soft warning, not a hard failure. Returns true iff notarization
 * (and, for app bundles, stapling) completed.
 */
export async function notarizeAndStaple(filePath, { isAppBundle = false } = {}) {
  if (!hasSigningCreds()) return false; // already warned by codesignBinary
  if (!hasNotarizationCreds()) {
    console.warn(
      `[sign.mjs] ${path.basename(filePath)} signed but NOT notarized (no APPLE_NOTARIZATION_API_KEY_* configured) -- Gatekeeper will do a slower online check on first launch instead of using a stapled ticket. See RELEASE.md.`,
    );
    return false;
  }
  assertToolAvailable("xcrun");

  const workDir = mkdtempSync(path.join(tmpdir(), "nia-agent-notarize-"));
  const keyPath = path.join(workDir, "AuthKey.p8");
  const submissionZip = path.join(workDir, "submission.zip");
  try {
    writeFileSync(keyPath, Buffer.from(process.env.APPLE_NOTARIZATION_API_KEY_P8_BASE64, "base64"));
    // notarytool only accepts a zip/dmg/pkg submission -- zip whatever we
    // were given (an app bundle or a bare executable) into a throwaway
    // archive; stapling afterwards (app bundles only) targets the
    // original `filePath`, not this submission zip.
    execFileSync("ditto", ["-c", "-k", "--keepParent", path.basename(filePath), submissionZip], { cwd: path.dirname(filePath) });

    console.log(`[sign.mjs] submitting ${path.basename(filePath)} for notarization (this can take a few minutes)...`);
    execFileSync(
      "xcrun",
      [
        "notarytool",
        "submit",
        submissionZip,
        "--key",
        keyPath,
        "--key-id",
        process.env.APPLE_NOTARIZATION_API_KEY_ID,
        "--issuer",
        process.env.APPLE_NOTARIZATION_API_KEY_ISSUER_ID,
        "--wait",
      ],
      { stdio: "inherit" },
    );

    if (isAppBundle) {
      // Only app bundles (and installer packages/disk images) can carry a
      // stapled ticket -- a bare Mach-O executable can't be stapled at all
      // (Apple's stapler only operates on bundles/dmg/pkg). For a bare
      // executable like nia-agent, notarization still succeeded above --
      // Gatekeeper can look the record up online -- there's just nothing
      // to staple locally.
      console.log(`[sign.mjs] stapling notarization ticket to ${path.basename(filePath)}...`);
      execFileSync("xcrun", ["stapler", "staple", filePath], { stdio: "inherit" });
    } else {
      console.log(`[sign.mjs] ${path.basename(filePath)} notarized (bare executables can't be stapled -- Gatekeeper verifies it online).`);
    }
    return true;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** Exposed so build-release.mjs's `--release` gate can tell "unsigned"/"not notarized" apart from "fully signed + notarized". */
export function getSigningStatus() {
  return { signed: hasSigningCreds(), notarized: hasSigningCreds() && hasNotarizationCreds() };
}

// `which`, not `<cmd> --help`/`--version` -- codesign exits non-zero on
// both of those (it only recognizes its actual sign/verify/display
// subcommand flags), so probing via its own flags gives false negatives.
function assertToolAvailable(cmd) {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
  } catch {
    throw new Error(`\`${cmd}\` is required and is only available on a real macOS host with Xcode Command Line Tools installed.`);
  }
}
