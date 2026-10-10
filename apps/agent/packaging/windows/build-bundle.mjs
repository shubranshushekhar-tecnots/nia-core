#!/usr/bin/env node
// Assembles the full Windows install bundle: the agent SEA executable
// (built by build-sea.mjs), a pinned + checksum-verified WinSW binary,
// the WinSW service descriptor, WinSW's MIT license, and install/
// uninstall PowerShell scripts — zipped into one file GMS IT copies to
// the target Windows host and runs install.ps1 from. No downloads happen
// on the target host; everything is fetched and verified here, at build
// time, on the build machine.
//
// Usage (from repo root, after `pnpm -r --filter @nia/extract --filter
// @nia/agent build`):
//   node apps/agent/packaging/windows/build-sea.mjs
//   node apps/agent/packaging/windows/build-bundle.mjs
//
// --unsigned-test-build (passed by build-release.mjs's --release
// --allow-unsigned gate, never by a dev directly) stages an
// UNSIGNED-TEST-BUILD.txt marker that nia-agent-updater.ps1 checks for to
// skip its own Authenticode publisher-pinning check on this build's
// self-updates.
//
// Produces apps/agent/packaging/windows/dist/nia-core-agent-windows-<version>.zip
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, rmSync, cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getExpectedPublisherSubject } from "./sign.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.resolve(here, "../../");
const distDir = path.join(here, "dist");
const unsignedTestBuild = process.argv.slice(2).includes("--unsigned-test-build");

// Pinned WinSW release. The x64 binary's SHA-256 below was verified by
// directly downloading this exact asset from this exact URL and running
// `shasum -a 256` on it — not copied from a third party — before being
// hard-coded here. Re-verify and update both together if the pin ever
// changes.
const WINSW_VERSION = "2.12.0";
const WINSW_EXE_URL = `https://github.com/winsw/winsw/releases/download/v${WINSW_VERSION}/WinSW-x64.exe`;
const WINSW_EXE_SHA256 = "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da";
const WINSW_LICENSE_URL = `https://raw.githubusercontent.com/winsw/winsw/v${WINSW_VERSION}/LICENSE.txt`;

async function main() {
  const version = JSON.parse(readFileSync(path.join(agentDir, "package.json"), "utf8")).version;
  const seaExePath = path.join(distDir, "nia-agent.exe");
  if (!existsSync(seaExePath)) {
    throw new Error(`${seaExePath} not found — run build-sea.mjs first`);
  }

  const stageDir = path.join(distDir, "stage");
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  console.log("[1/3] downloading + verifying WinSW...");
  const winswPath = path.join(stageDir, "nia-agent-service.exe");
  await downloadFile(WINSW_EXE_URL, winswPath);
  const actualSha = sha256File(winswPath);
  if (actualSha !== WINSW_EXE_SHA256) {
    throw new Error(`WinSW checksum mismatch: expected ${WINSW_EXE_SHA256}, got ${actualSha}`);
  }
  console.log(`  verified WinSW-x64.exe v${WINSW_VERSION}: ${actualSha}`);
  writeFileSync(path.join(stageDir, "LICENSE-WinSW.txt"), await (await fetch(WINSW_LICENSE_URL)).text());

  console.log("[2/3] staging agent executable, service config, and scripts...");
  copyFileSync(seaExePath, path.join(stageDir, "nia-agent.exe"));
  copyFileSync(path.join(here, "nia-agent-service.xml"), path.join(stageDir, "nia-agent-service.xml"));
  copyFileSync(path.join(here, "install.ps1"), path.join(stageDir, "install.ps1"));
  copyFileSync(path.join(here, "uninstall.ps1"), path.join(stageDir, "uninstall.ps1"));
  // Same external-updater staging as build-installer.mjs -- install.ps1's
  // step e) registers the "NiaAgentUpdater" Scheduled Task pointing at
  // this folder, so a zip-bundle install needs it just as much as an NSIS
  // install does.
  cpSync(path.join(here, "updater"), path.join(stageDir, "updater"), { recursive: true });
  const expectedPublisherSubject = getExpectedPublisherSubject();
  if (expectedPublisherSubject) {
    writeFileSync(
      path.join(stageDir, "expected-publisher.json"),
      JSON.stringify({ subject: expectedPublisherSubject }, null, 2),
    );
  }
  if (unsignedTestBuild) {
    writeFileSync(
      path.join(stageDir, "UNSIGNED-TEST-BUILD.txt"),
      `This build was produced with --release --allow-unsigned and is NOT signed.\nDo not distribute. Built ${new Date().toISOString()}.\n`,
    );
  }
  writeFileSync(
    path.join(stageDir, "VERSION.txt"),
    `Nia Core Agent ${version}\nWinSW ${WINSW_VERSION}\nBuilt ${new Date().toISOString()}\n`,
  );

  console.log("[3/3] zipping bundle...");
  const zipName = `nia-core-agent-windows-${version}.zip`;
  const zipPath = path.join(distDir, zipName);
  rmSync(zipPath, { force: true });
  execFileSync("zip", ["-r", "-q", zipPath, "."], { cwd: stageDir });
  rmSync(stageDir, { recursive: true, force: true });

  console.log(`\nbuilt ${zipPath}`);
  console.log(`sha256: ${sha256File(zipPath)}`);
}

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to download ${url}: ${res.status}`);
  writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
