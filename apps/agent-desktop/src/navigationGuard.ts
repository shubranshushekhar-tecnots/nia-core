/**
 * The window is only ever allowed to navigate within the local agent's own
 * origin (127.0.0.1 on the port we read from port.json at startup). Anything
 * else -- the UI's "Edit on website" link, a stray external link, a
 * javascript:/file: URL -- must be denied in-window and handed to
 * shell.openExternal instead (for real http(s) targets) or just blocked.
 */
export function isAllowedNavigation(url: string, port: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  if (parsed.hostname !== "127.0.0.1") return false;
  if (Number(parsed.port) !== port) return false;
  return true;
}
