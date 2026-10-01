/** SQL Server bracket-quotes an identifier by doubling any `]` inside it — same escaping shape as `@nia/schemas`'s backtick/doublequote quoting for mysql/postgres (see sqlShared.ts), written fresh here per the Phase 1 reuse-map note. */
export function quoteIdent(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}

/**
 * Catalog table names are schema-qualified (e.g. "dbo.vw_salesdata",
 * see introspect.ts), so quoting the whole name as one bracketed
 * identifier would be wrong (`[dbo.vw_salesdata]` looks for a single
 * object literally named "dbo.vw_salesdata"). Splits on the first `.`
 * and quotes each part separately.
 */
export function quoteQualifiedName(name: string): string {
  const dot = name.indexOf(".");
  if (dot === -1) return quoteIdent(name);
  return `${quoteIdent(name.slice(0, dot))}.${quoteIdent(name.slice(dot + 1))}`;
}
