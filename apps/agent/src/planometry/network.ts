/**
 * `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` resolution (docs/plans/
 * planometry-integration.md Phase 2 §6) — a pure function so the
 * decision logic is testable without a real proxy server; `client.ts`
 * uses the result to pick an undici `ProxyAgent` vs a plain `Agent`.
 */
export interface ProxyEnv {
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
  NO_PROXY?: string;
  http_proxy?: string;
  https_proxy?: string;
  no_proxy?: string;
  [key: string]: string | undefined;
}

export function resolveProxyUrl(targetUrl: string, env: ProxyEnv = process.env as ProxyEnv): string | undefined {
  const target = new URL(targetUrl);
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  if (noProxy && matchesNoProxy(target.hostname, noProxy)) return undefined;

  const proxy = target.protocol === "https:" ? (env.HTTPS_PROXY ?? env.https_proxy) : (env.HTTP_PROXY ?? env.http_proxy);
  return proxy || undefined;
}

function matchesNoProxy(hostname: string, noProxy: string): boolean {
  return noProxy
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") return true;
      const pattern = entry.startsWith(".") ? entry.slice(1) : entry;
      return hostname === pattern || hostname.endsWith(`.${pattern}`);
    });
}
