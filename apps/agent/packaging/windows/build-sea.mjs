#!/usr/bin/env node
// Builds nia-agent.exe — a Windows Node.js Single Executable Application
// (SEA) for the agent. Can run on any OS (macOS/Linux/Windows): Node's SEA
// injection (postject) is pure binary patching of a target `node.exe`, it
// never executes that binary, so cross-building a Windows SEA from macOS/
// Linux is supported and is how this is actually built in this repo.
//
// Usage (from repo root, after `pnpm -r --filter @nia/extract --filter
// @nia/agent build`):
//   node apps/agent/packaging/windows/build-sea.mjs
//
// Produces apps/agent/packaging/windows/dist/nia-agent.exe
//
// Steps:
//   1. esbuild-bundle dist/index.js (+ all deps, incl. @nia/extract/mssql
//      and its pure-JS `mssql`/`tedious` driver — no native bindings, so
//      bundling works cleanly) into one CommonJS file. SEA requires a
//      single-file entry point; esbuild is the standard tool for this per
//      Node's own SEA docs.
//   2. node --experimental-sea-config to produce the SEA preparation blob.
//   3. Download the pinned Node.js Windows x64 binary from nodejs.org and
//      verify it against nodejs.org's own published SHASUMS256.txt before
//      using it — this is the executable nia-agent.exe is built from.
//   4. postject-inject the blob into a copy of that node.exe.
//
// The SEA blob also embeds the built agent UI (`apps/agent/ui/dist`, see
// Phase 2) via Node's SEA `assets` map (packaging/shared/seaAssets.mjs
// builds it) -- `staticAssets.ts`'s `loadUiAsset()` reads these back via
// `node:sea`'s `getAsset()` at runtime, so the final binary serves the
// desktop UI with no separate files to ship alongside it.
//
// Node's SEA docs are explicit that the blob and the node.exe it's injected
// into must come from the EXACT same Node build ("The version of the Node.js
// binary used to produce the blob must be the same as the one to which the
// blob will be injected" -- mismatches crash at startup with "FATAL ERROR:
// v8::ToLocalChecked Empty MaybeLocal", confirmed via nodejs/node#60327).
// Step 2 below always generates the blob with whichever `node` is currently
// running this script (`process.execPath`) -- so NODE_VERSION here MUST
// track that exact same build, not an independently-pinned constant: CI's
// `actions/setup-node@v4` with a floating `node-version: 22` resolves to
// whatever the latest 22.x release is on the day the workflow runs, which
// silently drifts away from any hardcoded version over time and reproduces
// this exact crash. Deriving it from `process.version` instead guarantees
// blob and binary always match, regardless of which Node actually runs the
// build.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildUiAssetsMap } from "../shared/seaAssets.mjs";
import { signFile } from "./sign.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.resolve(here, "../../");
const repoRoot = path.resolve(agentDir, "../../");
const distDir = path.join(here, "dist");
const uiDistDir = path.join(agentDir, "ui", "dist");

const NODE_VERSION = process.version.slice(1); // "v22.15.0" -> "22.15.0"
const NODE_ZIP_NAME = `node-v${NODE_VERSION}-win-x64.zip`;
const NODE_ZIP_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ZIP_NAME}`;
const NODE_SHASUMS_URL = `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`;

async function main() {
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  console.log("[1/4] bundling agent to a single CommonJS file with esbuild...");
  const bundlePath = path.join(distDir, "agent-bundle.cjs");
  const esbuild = await import("esbuild");
  await esbuild.build({
    entryPoints: [path.join(agentDir, "dist", "index.js")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: bundlePath,
    // Node's SEA loader requires the entry to synchronously set
    // require('node:sea') up — esbuild's CJS output does this fine, no
    // externals needed since mssql/tedious/undici are all pure JS.
  });

  console.log("[2/4] generating the SEA preparation blob...");
  const seaConfigPath = path.join(distDir, "sea-config.json");
  const blobPath = path.join(distDir, "sea-prep.blob");
  // Embeds the built agent UI (apps/agent/ui/dist) into the SEA blob,
  // keyed by forward-slash relative path -- read back at runtime by
  // staticAssets.ts's loadUiAsset() via node:sea's getAsset().
  const assets = buildUiAssetsMap(uiDistDir);
  writeFileSync(
    seaConfigPath,
    JSON.stringify(
      {
        main: bundlePath,
        output: blobPath,
        disableExperimentalSEAWarning: true,
        assets,
      },
      null,
      2,
    ),
  );
  execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], { stdio: "inherit" });

  console.log(`[3/4] downloading + verifying node v${NODE_VERSION} win-x64...`);
  const nodeZipPath = path.join(distDir, NODE_ZIP_NAME);
  await downloadFile(NODE_ZIP_URL, nodeZipPath);
  const shasums = await (await fetch(NODE_SHASUMS_URL)).text();
  const expectedLine = shasums.split("\n").find((l) => l.endsWith(NODE_ZIP_NAME));
  if (!expectedLine) throw new Error(`${NODE_ZIP_NAME} not listed in nodejs.org's SHASUMS256.txt`);
  const expectedSha = expectedLine.split(/\s+/)[0];
  const actualSha = sha256File(nodeZipPath);
  if (expectedSha !== actualSha) {
    throw new Error(`node.exe checksum mismatch: nodejs.org says ${expectedSha}, downloaded file is ${actualSha}`);
  }
  console.log(`  verified against nodejs.org/dist SHASUMS256.txt: ${actualSha}`);

  execFileSync("unzip", ["-o", "-q", nodeZipPath, `node-v${NODE_VERSION}-win-x64/node.exe`, "-d", distDir]);
  const extractedNodeExe = path.join(distDir, `node-v${NODE_VERSION}-win-x64`, "node.exe");
  const outExePath = path.join(distDir, "nia-agent.exe");
  copyFileSync(extractedNodeExe, outExePath);

  console.log("[4/4] injecting the SEA blob into the copy of node.exe...");
  const { inject } = await import("postject");
  // inject() patches outExePath in place (it takes a filename, not a
  // buffer) — this is pure binary resource injection, it never executes
  // node.exe, which is what makes cross-building a Windows SEA from
  // macOS/Linux possible.
  await inject(outExePath, "NODE_SEA_BLOB", readFileSync(blobPath), {
    sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  });

  rmSync(nodeZipPath);
  rmSync(path.join(distDir, `node-v${NODE_VERSION}-win-x64`), { recursive: true, force: true });

  await signFile(outExePath);

  const finalSha = sha256File(outExePath);
  console.log(`\nbuilt ${outExePath}`);
  console.log(`nia-agent.exe sha256: ${finalSha}`);
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
