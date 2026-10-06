/**
 * `nia-agent setup`'s pairing step accepts either the full pairing command
 * shown on the Agents page (e.g. `nia-agent pair --code pc1.secret123
 * --url https://app.example.com`, with or without the leading `nia-agent
 * pair`) or just the bare code. Kept as a pure function, separate from the
 * interactive wizard, so it's testable without any I/O.
 */
export interface ParsedPairingInput {
  code: string;
  url?: string;
}

export function parsePairingInput(raw: string): ParsedPairingInput | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const code = extractFlagValue(trimmed, "code");
  const url = extractFlagValue(trimmed, "url");
  if (code) return { code, url };

  // No `--code` flag found — only accept as a bare code if it's a single
  // whitespace-free token containing the `<pairingCodeId>.<code>` dot
  // (pairing.ts's own parseCompositeCode enforces the exact shape; this
  // just avoids treating an unrelated sentence as a code).
  if (!/\s/.test(trimmed) && trimmed.includes(".")) return { code: trimmed };
  return undefined;
}

function extractFlagValue(text: string, flag: string): string | undefined {
  const match = text.match(new RegExp(`--${flag}[ =]("([^"]*)"|'([^']*)'|(\\S+))`));
  if (!match) return undefined;
  return match[2] ?? match[3] ?? match[4];
}
