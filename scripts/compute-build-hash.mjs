#!/usr/bin/env node
// Computes a deterministic content hash over one or more source
// directories/files. Used at two points that must never drift apart:
// (1) each connector Dockerfile (services/connector-*/Dockerfile) bakes
// the hash of its own image's source into a BUILD_HASH file at build
// time; (2) apps/api's connectorFreshness check (src/lib/
// connectorFreshness.ts) recomputes the same hash from the live working
// tree at startup and compares it to what the running connector's
// /health reports. A mismatch means the container is running an image
// built from different source than what's on disk right now — see
// docs/decisions.md's "stale connector image" entry for the incident
// this exists to catch. Both call sites must pass the exact same set of
// paths (the Dockerfile's COPY list) or this will report false staleness.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function collectFiles(root) {
  const st = statSync(root);
  if (st.isFile()) return [root];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: compute-build-hash.mjs <dir-or-file> [...]");
  process.exit(1);
}

const files = roots.flatMap(collectFiles).sort();
const hash = createHash("sha256");
for (const file of files) {
  // Path + a null separator before AND after the content: guards against
  // two different (path, content) pairs concatenating into the same byte
  // stream (e.g. a file split differently) hashing equal by accident.
  hash.update(relative(".", file));
  hash.update("\0");
  hash.update(readFileSync(file));
  hash.update("\0");
}
console.log(hash.digest("hex"));
