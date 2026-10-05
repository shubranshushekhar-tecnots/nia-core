import { Agent, ProxyAgent, request, type Dispatcher } from "undici";
import { resolveProxyUrl } from "../planometry/network.js";
import { defaultHomeDir } from "../config/paths.js";
import { loadConfig, saveConfig } from "../config/store.js";
import type { LinkConfig } from "../config/types.js";
import { loadOrCreateMasterKey } from "../secrets/keyfile.js";
import { LocalSecretStore } from "../secrets/store.js";
import { clearLinkState } from "../ops/linkState.js";

/** `--url` was not HTTPS and was not localhost (B.12: "HTTPS only (http is allowed for localhost)"). */
export class InvalidPlatformUrlError extends Error {
  constructor(url: string) {
    super(`${url} must be HTTPS (http is only allowed for localhost)`);
    this.name = "InvalidPlatformUrlError";
  }
}

/** `--code` was not in the `<pairingCodeId>.<code>` shape the agent-bridge's `/pair` route expects. */
export class InvalidPairingCodeError extends Error {
  constructor() {
    super("pairing code must be in the form <pairingCodeId>.<code>");
    this.name = "InvalidPairingCodeError";
  }
}

/** The bridge's `/pair` route rejected the code (not found, locked, used, expired, incorrect). */
export class PairingRejectedError extends Error {}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/** HTTPS only, except localhost may use plain HTTP (B.12) — same rule enforced here as will later gate every check-in, since HttpAgentTransport is given this exact URL. */
function assertValidPlatformUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new InvalidPlatformUrlError(rawUrl);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost(url.hostname))) {
    throw new InvalidPlatformUrlError(rawUrl);
  }
  return url;
}

/** The bridge's `/pair` route takes `{pairingCodeId, code}` (services/agent-bridge/src/app.ts) — the CLI's single `--code` flag carries both, dot-separated. */
function parseCompositeCode(code: string): { pairingCodeId: string; code: string } {
  const dotIndex = code.indexOf(".");
  if (dotIndex <= 0 || dotIndex === code.length - 1) throw new InvalidPairingCodeError();
  return { pairingCodeId: code.slice(0, dotIndex), code: code.slice(dotIndex + 1) };
}

function buildDispatcher(url: string, caBundlePem?: string): Dispatcher {
  const proxyUrl = resolveProxyUrl(url);
  const requestTls = caBundlePem ? { ca: caBundlePem } : undefined;
  return proxyUrl ? new ProxyAgent({ uri: proxyUrl, requestTls }) : new Agent({ connect: requestTls });
}

export interface PairInput {
  code: string;
  url: string;
  /** PEM contents for a custom CA bundle — same escape hatch as link/transport.ts's HttpAgentTransport. */
  caBundlePem?: string;
}

export interface PairResult {
  agentId: string;
}

/**
 * `nia-agent pair --code <code> --url <platform>` (B.12). Calls
 * `${url}/agent-api/pair`; on success, the agent key goes only into the
 * local encrypted secret store (never into agent.config.json — same
 * convention as ConnectionEntry.agentKeyRef/credentialRef), and
 * `{platformUrl, agentId, agentKeyRef}` goes into config.link.
 */
export async function pair(input: PairInput, dir = defaultHomeDir()): Promise<PairResult> {
  const url = assertValidPlatformUrl(input.url);
  const { pairingCodeId, code } = parseCompositeCode(input.code);

  const pairUrl = `${input.url.replace(/\/$/, "")}/agent-api/pair`;
  const dispatcher = buildDispatcher(pairUrl, input.caBundlePem);
  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request(pairUrl, {
      method: "POST",
      dispatcher,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingCodeId, code }),
    });
  } finally {
    await dispatcher.close();
  }

  const text = await res.body.text();
  if (res.statusCode >= 300) {
    let message = `platform returned ${res.statusCode}`;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch {
      // ignore — keep the generic status-code message
    }
    throw new PairingRejectedError(message);
  }

  const body = JSON.parse(text) as { agentId: string; agentKey: string };

  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  const agentKeyRef = secrets.put({ agentKey: body.agentKey });

  const link: LinkConfig = { platformUrl: url.toString().replace(/\/$/, ""), agentId: body.agentId, agentKeyRef };
  const config = loadConfig(dir);
  saveConfig({ ...config, link }, dir);
  clearLinkState(dir);

  return { agentId: body.agentId };
}

/** `nia-agent unpair`: removes the key from the secret store and the link from config.json. Local jobs are untouched — connections/jobs are never read or modified here. */
export function unpair(dir = defaultHomeDir()): boolean {
  const config = loadConfig(dir);
  if (!config.link) return false;

  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  secrets.delete(config.link.agentKeyRef);

  const { link: _link, ...rest } = config;
  saveConfig(rest, dir);
  clearLinkState(dir);
  return true;
}
