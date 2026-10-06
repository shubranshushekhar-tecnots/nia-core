#!/usr/bin/env node
// Builds NiaCoreAgent-Setup-<version>.exe — a real Windows installer (NSIS)
// wrapping the same agent SEA executable + pinned WinSW binary the zip
// bundle (build-bundle.mjs) ships, so IT staff who prefer a double-click
// installer over the zip+install.ps1 workflow get one. Requires `makensis`
// (brew install makensis on macOS/Linux; NSIS cross-compiles a Windows .exe
// without needing Windows, same as build-sea.mjs's SEA cross-build).
//
// Usage (from repo root, after `pnpm -r --filter @nia/extract --filter
// @nia/agent build`):
//   node apps/agent/packaging/windows/build-sea.mjs
//   node apps/agent/packaging/windows/build-installer.mjs
//
// Produces apps/agent/packaging/windows/dist/NiaCoreAgent-Setup-<version>.exe
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.resolve(here, "../../");
const distDir = path.join(here, "dist");

// Same pin as build-bundle.mjs, intentionally duplicated here rather than
// imported so this build script has no dependency on that one — see its
// own comment for how this checksum was obtained.
const WINSW_VERSION = "2.12.0";
const WINSW_EXE_URL = `https://github.com/winsw/winsw/releases/download/v${WINSW_VERSION}/WinSW-x64.exe`;
const WINSW_EXE_SHA256 = "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da";
const WINSW_LICENSE_URL = `https://raw.githubusercontent.com/winsw/winsw/v${WINSW_VERSION}/LICENSE.txt`;

async function main() {
  assertMakensisAvailable();

  const version = JSON.parse(readFileSync(path.join(agentDir, "package.json"), "utf8")).version;
  const seaExePath = path.join(distDir, "nia-agent.exe");
  if (!existsSync(seaExePath)) {
    throw new Error(`${seaExePath} not found — run build-sea.mjs first`);
  }

  const stageDir = path.join(distDir, "installer-stage");
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
  writeFileSync(
    path.join(stageDir, "VERSION.txt"),
    `Nia Core Agent ${version}\nWinSW ${WINSW_VERSION}\nBuilt ${new Date().toISOString()}\n`,
  );

  console.log("[3/3] running makensis...");
  const outExeName = `NiaCoreAgent-Setup-${version}.exe`;
  const outExePath = path.join(distDir, outExeName);
  rmSync(outExePath, { force: true });
  execFileSync("makensis", [`-DSTAGE_DIR=${stageDir}`, `-DVERSION=${version}`, path.join(here, "installer.nsi")], {
    cwd: here,
    stdio: "inherit",
  });
  rmSync(stageDir, { recursive: true, force: true });

  if (!existsSync(outExePath)) {
    throw new Error(`makensis reported success but ${outExePath} wasn't produced — check installer.nsi's OutFile path`);
  }
  const sizeBytes = statSync(outExePath).size;
  console.log(`\nbuilt ${outExePath}`);
  console.log(`size: ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`);
  console.log(`sha256: ${sha256File(outExePath)}`);
}

function assertMakensisAvailable() {
  try {
    execFileSync("makensis", ["-VERSION"], { stdio: "ignore" });
  } catch {
    console.log("makensis not found — attempting to install via Homebrew...");
    try {
      execFileSync("brew", ["install", "makensis"], { stdio: "inherit" });
    } catch (err) {
      throw new Error(
        `makensis is required to build the Windows installer and could not be installed automatically (${err instanceof Error ? err.message : err}). Install NSIS yourself (e.g. \`brew install makensis\`) and re-run this script.`,
      );
    }
  }
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
