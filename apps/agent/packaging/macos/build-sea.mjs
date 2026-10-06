#!/usr/bin/env node
// Builds nia-agent — a macOS Node.js Single Executable Application (SEA)
// for the agent, Apple Silicon (arm64) only in this slice. Same esbuild +
// --experimental-sea-config + postject approach as
// packaging/windows/build-sea.mjs, with two macOS-specific differences:
//   - postject needs `--macho-segment-name NODE_SEA` on Mach-O binaries
//     (Node's SEA docs; the Windows PE build needs no such flag).
//   - injecting into the binary invalidates Apple's code signature, so the
//     binary must be re-signed afterwards. This script applies an ad-hoc
//     signature (`codesign --sign -`), which lets it run on this machine
//     but is NOT a Developer ID signature — Gatekeeper will still warn on
//     another Mac. See docs/pilot/install-guide.md's macOS section.
//
// Unlike the Windows build, postject's binary patching still only works
// cross-platform for the *injection* step, but `codesign` itself only
// exists on macOS — so, unlike the Windows SEA, this script only runs on
// a macOS host (checked below).
//
// Usage (from repo root, after `pnpm -r --filter @nia/extract --filter
// @nia/agent build`):
//   node apps/agent/packaging/macos/build-sea.mjs
//
// Produces apps/agent/packaging/macos/dist/nia-agent (arm64, ad-hoc signed)
//
// Pinned to the same Node version as the Windows build (22.15.0) for a
// reproducible, verifiable build across all three platform targets.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, rmSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.resolve(here, "../../");
const distDir = path.join(here, "dist");

const NODE_VERSION = "22.15.0";
const NODE_TAR_NAME = `node-v${NODE_VERSION}-darwin-arm64.tar.gz`;
const NODE_TAR_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TAR_NAME}`;
const NODE_SHASUMS_URL = `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`;

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("macOS SEA build must run on macOS (codesign is not available cross-platform)");
  }

  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  console.log("[1/5] bundling agent to a single CommonJS file with esbuild...");
  const bundlePath = path.join(distDir, "agent-bundle.cjs");
  const esbuild = await import("esbuild");
  await esbuild.build({
    entryPoints: [path.join(agentDir, "dist", "index.js")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: bundlePath,
  });

  console.log("[2/5] generating the SEA preparation blob...");
  const seaConfigPath = path.join(distDir, "sea-config.json");
  const blobPath = path.join(distDir, "sea-prep.blob");
  writeFileSync(
    seaConfigPath,
    JSON.stringify(
      {
        main: bundlePath,
        output: blobPath,
        disableExperimentalSEAWarning: true,
      },
      null,
      2,
    ),
  );
  execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], { stdio: "inherit" });

  console.log(`[3/5] downloading + verifying node v${NODE_VERSION} darwin-arm64...`);
  const nodeTarPath = path.join(distDir, NODE_TAR_NAME);
  await downloadFile(NODE_TAR_URL, nodeTarPath);
  const shasums = await (await fetch(NODE_SHASUMS_URL)).text();
  const expectedLine = shasums.split("\n").find((l) => l.endsWith(NODE_TAR_NAME));
  if (!expectedLine) throw new Error(`${NODE_TAR_NAME} not listed in nodejs.org's SHASUMS256.txt`);
  const expectedSha = expectedLine.split(/\s+/)[0];
  const actualSha = sha256File(nodeTarPath);
  if (expectedSha !== actualSha) {
    throw new Error(`node binary checksum mismatch: nodejs.org says ${expectedSha}, downloaded file is ${actualSha}`);
  }
  console.log(`  verified against nodejs.org/dist SHASUMS256.txt: ${actualSha}`);

  execFileSync("tar", ["-xzf", nodeTarPath, "-C", distDir, `node-v${NODE_VERSION}-darwin-arm64/bin/node`]);
  const extractedNode = path.join(distDir, `node-v${NODE_VERSION}-darwin-arm64`, "bin", "node");
  const outExePath = path.join(distDir, "nia-agent");
  copyFileSync(extractedNode, outExePath);
  chmodSync(outExePath, 0o755);

  console.log("[4/5] injecting the SEA blob into the copy of node...");
  // Remove the signature first — Node's SEA docs call this out as required
  // on macOS before injection (an existing signature blocks the write).
  execFileSync("codesign", ["--remove-signature", outExePath]);
  const { inject } = await import("postject");
  await inject(outExePath, "NODE_SEA_BLOB", readFileSync(blobPath), {
    sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    machoSegmentName: "NODE_SEA",
  });

  console.log("[5/5] applying an ad-hoc code signature...");
  // Ad-hoc (no identity, `-s -`) — lets the binary run on this machine.
  // This is NOT Developer ID signing; see docs/pilot/install-guide.md.
  execFileSync("codesign", ["--sign", "-", "--force", outExePath]);

  rmSync(nodeTarPath);
  rmSync(path.join(distDir, `node-v${NODE_VERSION}-darwin-arm64`), { recursive: true, force: true });

  const finalSha = sha256File(outExePath);
  console.log(`\nbuilt ${outExePath}`);
  console.log(`nia-agent sha256: ${finalSha}`);
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
