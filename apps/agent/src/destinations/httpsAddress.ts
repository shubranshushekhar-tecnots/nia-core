/**
 * Task item 2's "Address" rule: HTTPS only, except `http:` is allowed for
 * localhost (so a local test/dev receiver doesn't need a cert). Checked
 * at `job add` time (cli/jobCommands.ts) — never at run time, since an
 * already-saved job's address can't change shape underneath it.
 */
export type HttpsAddressValidation = { ok: true; url: URL } | { ok: false; error: string };

const LOCALHOST_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function validateHttpsAddress(address: string): HttpsAddressValidation {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { ok: false, error: `"${address}" is not a valid URL` };
  }
  if (url.protocol === "https:") return { ok: true, url };
  if (url.protocol === "http:" && LOCALHOST_NAMES.has(url.hostname)) return { ok: true, url };
  return { ok: false, error: `destination address must use https (http is only allowed for localhost), got ${JSON.stringify(address)}` };
}
