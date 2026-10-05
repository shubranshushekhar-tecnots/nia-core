import { isIP } from "node:net";
import { promises as dns, type LookupAddress } from "node:dns";
import { AppError } from "./appError.js";

/**
 * Slice R1, requirement 3 — shared HTTPS-only + private/loopback/
 * link-local guard for any connector manifest field that holds a
 * caller-controlled destination address (today: planometry-table's and
 * https-endpoint's `address` field). Runs once, at createConnection time
 * (see connections.ts) — not re-checked on every dispatch, since the
 * stored config is never user-editable outside that same validated path
 * (updateConnection's edit flow reuses createConnection's manifest-level
 * field split but for these two manifests never changes `address` without
 * going through this same check — see splitFieldsForEdit's generic
 * validation call site).
 *
 * `resolve` is injectable so a test can point this at a local stub server
 * without needing a real DNS-resolvable, non-private hostname — the real
 * production resolver is node:dns's own `lookup`, wired as the default.
 */
export type AddressResolver = (hostname: string) => Promise<LookupAddress[]>;

async function defaultResolve(hostname: string): Promise<LookupAddress[]> {
  return dns.lookup(hostname, { all: true });
}

function ipToParts(ip: string): number[] | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return parts;
}

/** IPv4 private/loopback/link-local ranges: 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ipToParts(ip);
  if (!parts) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** IPv6 loopback (::1), link-local (fe80::/10), and unique-local (fc00::/7). */
function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("fe80:") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  return false;
}

function isPrivateAddress(ip: string): boolean {
  return isIP(ip) === 4 ? isPrivateIPv4(ip) : isIP(ip) === 6 ? isPrivateIPv6(ip) : false;
}

/**
 * Throws AppError(400, "UNSAFE_ADDRESS", ...) if `address` is not an HTTPS
 * URL, or resolves (directly as a literal IP, or via DNS) to a private,
 * loopback, or link-local address. Pass `resolve` to override DNS
 * resolution in tests.
 */
export async function assertAddressSafe(address: string, resolve: AddressResolver = defaultResolve): Promise<void> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new AppError(400, "UNSAFE_ADDRESS", `"${address}" is not a valid URL.`);
  }
  if (url.protocol !== "https:") {
    throw new AppError(400, "UNSAFE_ADDRESS", `Address must use https:// (got "${url.protocol}").`);
  }

  const hostname = url.hostname;
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new AppError(400, "UNSAFE_ADDRESS", `Address must not resolve to a private, loopback, or link-local address.`);
    }
    return;
  }

  let resolved: LookupAddress[];
  try {
    resolved = await resolve(hostname);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(400, "UNSAFE_ADDRESS", `Could not resolve address "${hostname}": ${message}`);
  }
  if (resolved.some((entry) => isPrivateAddress(entry.address))) {
    throw new AppError(400, "UNSAFE_ADDRESS", `Address must not resolve to a private, loopback, or link-local address.`);
  }
}
