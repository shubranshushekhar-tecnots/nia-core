import fs from "node:fs";
import path from "node:path";
import { defaultHomeDir } from "../config/paths.js";

/**
 * Task item 4 / docs/plans/agent-canvas-integration.md §B.10: a local
 * list of allowed destination hosts, generic across every destination
 * type (not HTTPS-specific — a future Planometry host could be checked
 * against it too). Enforced for jobs published from the platform in a
 * later slice; jobs created with the local CLI are never checked against
 * it (hence no caller of `isDestinationHostAllowed` yet in this slice).
 */
function allowedHostsFilePath(dir: string): string {
  return path.join(dir, "allowed-destination-hosts.json");
}

function readHosts(dir: string): string[] {
  const file = allowedHostsFilePath(dir);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === "string") : [];
  } catch {
    return [];
  }
}

function writeHosts(dir: string, hosts: string[]): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(allowedHostsFilePath(dir), JSON.stringify(hosts, null, 2), { mode: 0o600 });
}

export function allowDestinationHost(host: string, dir = defaultHomeDir()): void {
  const hosts = readHosts(dir);
  if (!hosts.includes(host)) {
    hosts.push(host);
    writeHosts(dir, hosts);
  }
}

export function listAllowedDestinationHosts(dir = defaultHomeDir()): string[] {
  return readHosts(dir);
}

/** Returns true when the host was present (and removed); false when it wasn't in the list. */
export function removeAllowedDestinationHost(host: string, dir = defaultHomeDir()): boolean {
  const hosts = readHosts(dir);
  const next = hosts.filter((h) => h !== host);
  if (next.length === hosts.length) return false;
  writeHosts(dir, next);
  return true;
}

export function isDestinationHostAllowed(host: string, dir = defaultHomeDir()): boolean {
  return readHosts(dir).includes(host);
}
