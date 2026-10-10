#!/usr/bin/env node
// Authenticode-signs a Windows PE file (nia-agent.exe, the staged Electron
// shell's Nia Agent.exe, or the final NiaCoreAgent-Setup-<version>.exe
// installer) using whichever signing credentials are configured in the
// environment. Called from build-sea.mjs, build-installer.mjs (and, for the
// Electron shell, build-release.mjs), never a standalone script.
//
// Two signing modes, resolved at call time purely from env vars -- no mode
// flag needed by callers:
//
//   1. Azure Trusted Signing (preferred -- no local cert/key material,
//      Microsoft's own documented successor to "Azure Code Signing"):
//        AZURE_TRUSTED_SIGNING_ENDPOINT        e.g. https://wus2.codesigning.azure.net
//        AZURE_TRUSTED_SIGNING_ACCOUNT         the Trusted Signing account name
//        AZURE_TRUSTED_SIGNING_CERT_PROFILE    the certificate profile name
//      plus standard service-principal auth for the Azure SDK's
//      DefaultAzureCredential chain: AZURE_TENANT_ID, AZURE_CLIENT_ID,
//      AZURE_CLIENT_SECRET.
//      Implemented via Microsoft's own cross-platform "Sign CLI"
//      (github.com/dotnet/sign, a dotnet tool -- works on macOS/Linux too,
//      unlike signtool.exe/AzureSignTool which need Windows + Win SDK
//      signtool.exe), specifically its `sign code artifact-signing`
//      subcommand (the current replacement for the now-deprecated
//      `trusted-signing` subcommand). Flags confirmed against dotnet/sign's
//      own docs/artifact-signing-integration.md (`-ase`/`-asa`/`-ascp`) plus
//      Microsoft's azure/trusted-signing-action GitHub Action reference
//      (timestamp defaults). Exact flag names should be re-confirmed with
//      `sign code artifact-signing --help` once real credentials exist --
//      this repo's sandbox has no Azure Trusted Signing account to test
//      against (see RELEASE.md's verification notes).
//
//   2. Classic .pfx certificate (fallback, e.g. a self-purchased EV/OV cert
//      not yet migrated to Trusted Signing):
//        WINDOWS_CERT_PFX_BASE64      base64-encoded .pfx file contents
//        WINDOWS_CERT_PASSWORD        the .pfx's export password
//        WINDOWS_CERT_TIMESTAMP_URL   optional, RFC3161 TSA (default: DigiCert's)
//      Implemented via `osslsigncode` (OpenSSL-based Authenticode signing,
//      cross-platform -- real Microsoft `signtool.exe` only runs on
//      Windows, and this toolchain cross-builds Windows artifacts from
//      macOS/Linux, same reasoning as build-sea.mjs's SEA cross-build).
//
//   Neither set -> no-op, logs a clear "unsigned" warning and returns. This
//   is today's behavior for every dev build and is unchanged by this file.
//
//   WINDOWS_CERT_SUBJECT (optional, either mode): the signing
//   certificate's Authenticode Subject string, e.g. "CN=Nia Core, Inc.".
//   Not a credential -- just pins which publisher the external updater
//   (packaging/windows/updater/nia-agent-updater.ps1) should require a
//   downloaded update to be signed by. See getExpectedPublisherSubject().
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, renameSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Cached across calls within a single build-release.mjs run (and across
// local dev invocations) so "sign 3 files in one build" only pays the
// `dotnet tool install` cost once. Not shared across CI runs -- each CI job
// starts clean, which is fine, it's a ~few-second install.
const dotnetSignToolDir = path.join(here, "dist", ".dotnet-sign-tool");

const DEFAULT_AZURE_TIMESTAMP_URL = "http://timestamp.acs.microsoft.com";
const DEFAULT_PFX_TIMESTAMP_URL = "http://timestamp.digicert.com";

function hasAzureTrustedSigningCreds() {
  return Boolean(process.env.AZURE_TRUSTED_SIGNING_ENDPOINT && process.env.AZURE_TRUSTED_SIGNING_ACCOUNT && process.env.AZURE_TRUSTED_SIGNING_CERT_PROFILE);
}

function hasPfxCreds() {
  return Boolean(process.env.WINDOWS_CERT_PFX_BASE64 && process.env.WINDOWS_CERT_PASSWORD);
}

/** Resolved once per process, not per file, so a caller signing several files in one run doesn't print the "unsigned" warning (or probe for tools) more than once. */
let resolvedMode;

function resolveMode() {
  if (resolvedMode) return resolvedMode;
  if (hasAzureTrustedSigningCreds()) {
    resolvedMode = "azure-trusted-signing";
  } else if (hasPfxCreds()) {
    resolvedMode = "pfx";
  } else {
    resolvedMode = "none";
    console.warn(
      "[sign.mjs] unsigned (no signing credentials configured) -- set AZURE_TRUSTED_SIGNING_ENDPOINT/ACCOUNT/CERT_PROFILE or WINDOWS_CERT_PFX_BASE64/WINDOWS_CERT_PASSWORD to sign Windows binaries. See RELEASE.md.",
    );
  }
  return resolvedMode;
}

/**
 * Signs `filePath` in place. Safe to call on an unconfigured environment
 * (no-op + warning, already logged once by resolveMode()). Throws if
 * credentials ARE configured but the actual signing step fails -- a
 * misconfigured cert should be a hard build failure, not a silent skip.
 */
export async function signFile(filePath) {
  const mode = resolveMode();
  if (mode === "none") return;

  console.log(`[sign.mjs] signing ${path.basename(filePath)} (${mode})...`);
  if (mode === "azure-trusted-signing") {
    signWithAzureTrustedSigning(filePath);
  } else {
    signWithPfx(filePath);
  }
  console.log(`[sign.mjs] signed ${path.basename(filePath)}`);
}

/** Exposed so build-release.mjs's `--release` gate can tell "unsigned" apart from "signing was attempted". */
export function getSigningMode() {
  return resolveMode();
}

/**
 * The Authenticode certificate's expected Subject string (e.g. `CN=Nia
 * Core, Inc., O=Nia Core, Inc., ...`), read straight from
 * `WINDOWS_CERT_SUBJECT` (set alongside whichever signing-mode creds are
 * configured -- this is metadata about the cert, not a credential, so it
 * has its own var rather than being derived from the signing secrets).
 * Staged into the installed app as `expected-publisher.json` by
 * build-installer.mjs/build-bundle.mjs so the external updater
 * (packaging/windows/updater/nia-agent-updater.ps1) can independently
 * verify a downloaded update was signed by the same publisher, not just
 * signed by *someone*. Returns null when unset (e.g. an unsigned dev
 * build) -- callers must treat that as "cannot pin a publisher", not
 * silently skip the check without logging it.
 */
export function getExpectedPublisherSubject() {
  return process.env.WINDOWS_CERT_SUBJECT ?? null;
}

function signWithAzureTrustedSigning(filePath) {
  ensureDotnetSignToolInstalled();
  const signExe = path.join(dotnetSignToolDir, process.platform === "win32" ? "sign.exe" : "sign");
  const timestampUrl = process.env.AZURE_TRUSTED_SIGNING_TIMESTAMP_URL ?? DEFAULT_AZURE_TIMESTAMP_URL;
  execFileSync(
    signExe,
    [
      "code",
      "artifact-signing",
      "-ase",
      process.env.AZURE_TRUSTED_SIGNING_ENDPOINT,
      "-asa",
      process.env.AZURE_TRUSTED_SIGNING_ACCOUNT,
      "-ascp",
      process.env.AZURE_TRUSTED_SIGNING_CERT_PROFILE,
      "--file-digest",
      "sha256",
      "--timestamp-url",
      timestampUrl,
      "--timestamp-digest",
      "sha256",
      filePath,
    ],
    { stdio: "inherit" },
  );
}

function ensureDotnetSignToolInstalled() {
  const signExe = path.join(dotnetSignToolDir, process.platform === "win32" ? "sign.exe" : "sign");
  if (existsSync(signExe)) return;
  console.log("[sign.mjs] installing dotnet 'sign' CLI (github.com/dotnet/sign) for Azure Trusted Signing...");
  assertDotnetAvailable();
  mkdirSync(dotnetSignToolDir, { recursive: true });
  execFileSync("dotnet", ["tool", "install", "--tool-path", dotnetSignToolDir, "--prerelease", "sign"], { stdio: "inherit" });
}

function assertDotnetAvailable() {
  try {
    execFileSync("dotnet", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "the .NET SDK ('dotnet') is required to sign with Azure Trusted Signing (it hosts Microsoft's cross-platform 'sign' CLI, github.com/dotnet/sign). Install it (e.g. `brew install dotnet`) and re-run.",
    );
  }
}

function signWithPfx(filePath) {
  assertOsslsigncodeAvailable();
  const pfxDir = mkdtempSync(path.join(tmpdir(), "nia-agent-sign-pfx-"));
  const pfxPath = path.join(pfxDir, "cert.pfx");
  const signedPath = `${filePath}.signed`;
  try {
    writeFileSync(pfxPath, Buffer.from(process.env.WINDOWS_CERT_PFX_BASE64, "base64"));
    const timestampUrl = process.env.WINDOWS_CERT_TIMESTAMP_URL ?? DEFAULT_PFX_TIMESTAMP_URL;
    execFileSync(
      "osslsigncode",
      [
        "sign",
        "-pkcs12",
        pfxPath,
        "-pass",
        process.env.WINDOWS_CERT_PASSWORD,
        "-h",
        "sha256",
        "-ts",
        timestampUrl,
        "-in",
        filePath,
        "-out",
        signedPath,
      ],
      { stdio: "inherit" },
    );
    // osslsigncode can only write to a different path than -in -- swap it
    // back into place so callers can keep treating signFile() as in-place.
    renameSync(signedPath, filePath);
    chmodSync(filePath, 0o755);
  } finally {
    rmSync(pfxDir, { recursive: true, force: true });
    rmSync(signedPath, { force: true });
  }
}

function assertOsslsigncodeAvailable() {
  try {
    execFileSync("osslsigncode", ["--version"], { stdio: "ignore" });
  } catch {
    console.log("osslsigncode not found -- attempting to install via Homebrew...");
    try {
      execFileSync("brew", ["install", "osslsigncode"], { stdio: "inherit" });
    } catch (err) {
      throw new Error(
        `osslsigncode is required to sign with a classic .pfx certificate and could not be installed automatically (${err instanceof Error ? err.message : err}). Install it yourself (e.g. \`brew install osslsigncode\`) and re-run.`,
      );
    }
  }
}
