export interface ParsedServerAddress {
  host: string;
  /** Set only for a "HOST\INSTANCE" address -- resolved via SQL Browser (UDP 1434), never alongside `port`. */
  instanceName?: string;
  /** Set only for a "HOST,PORT" address. Unset for a plain host or a named instance -- the caller decides the port question/default in those cases. */
  port?: number;
}

/**
 * Parses what a user types (or passes to `connection add --host`) for a
 * SQL Server address, same three forms SSMS's own "Server name" field
 * accepts:
 *   - "HOST\INSTANCE" -> named instance, no port (SQL Browser resolves it)
 *   - "HOST,PORT"      -> explicit port
 *   - "HOST"           -> plain host, port decided elsewhere
 * A malformed instance/port half (empty, or a non-numeric port) falls
 * back to treating the whole string as a plain host rather than
 * guessing, so the next step's usual port question still applies.
 */
export function parseServerAddress(input: string): ParsedServerAddress {
  const trimmed = input.trim();

  const backslash = trimmed.indexOf("\\");
  if (backslash !== -1) {
    const host = trimmed.slice(0, backslash).trim();
    const instanceName = trimmed.slice(backslash + 1).trim();
    if (host && instanceName) return { host, instanceName };
  }

  const comma = trimmed.indexOf(",");
  if (comma !== -1) {
    const host = trimmed.slice(0, comma).trim();
    const portText = trimmed.slice(comma + 1).trim();
    const port = Number(portText);
    if (host && portText && Number.isInteger(port) && port > 0 && port <= 65535) {
      return { host, port };
    }
  }

  return { host: trimmed };
}
