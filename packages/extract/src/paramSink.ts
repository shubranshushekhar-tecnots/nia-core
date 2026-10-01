/**
 * Token-based parameter binding, independently written for this package
 * (not imported — `@nia/schemas`'s equivalent, `ops/paramSink.ts`, is
 * dialect-agnostic in principle but is an internal, unexported module of
 * a package this one deliberately has zero dependency on; see the Phase 1
 * reuse-map note in docs/plans/planometry-integration.md).
 *
 * Same proven shape: every value a filter builder wants bound gets
 * recorded here and an opaque TOKEN is embedded in the SQL text instead of
 * a real placeholder. Once the full WHERE clause text is assembled, the
 * caller resolves every token against the final physical text — with the
 * exactly-once-in-both-directions check — so binding always derives from
 * physical text order, never from JS call order.
 */
const TOKEN_CHAR = "\u0000";
const TOKEN_RE = new RegExp(`${TOKEN_CHAR}(\\d+)${TOKEN_CHAR}`, "g");

export interface ParamSink {
  /** Records `value`, returns an opaque token to embed inline in SQL text. */
  push(value: unknown): string;
}

interface ParamSinkImpl extends ParamSink {
  readonly recorded: ReadonlyMap<string, unknown>;
}

export function createParamSink(): ParamSinkImpl {
  const recorded = new Map<string, unknown>();
  let n = 0;
  return {
    recorded,
    push(value: unknown): string {
      const token = `${TOKEN_CHAR}${n}${TOKEN_CHAR}`;
      n += 1;
      recorded.set(token, value);
      return token;
    },
  };
}

/** Throws if an identifier would collide with the reserved token delimiter — the one place a non-parameterized string (a quoted identifier) is embedded as raw SQL text. */
export function assertSafeIdentifierText(name: string): void {
  if (name.includes(TOKEN_CHAR)) {
    throw new Error(`identifier ${JSON.stringify(name)} contains the reserved ParamSink token character — refusing to use it.`);
  }
}

/**
 * Resolves every recorded token against `sql`, which must be the final,
 * fully-assembled SQL text. Returns the text with every token swapped for
 * a real placeholder (via `placeholder(index)`, 1-based) plus the params
 * array built purely from left-to-right scan order of the text.
 *
 * Throws on any duplicate, forged/foreign, or orphaned token — a silent
 * mis-bind would be worse than failing loudly.
 */
export function resolveParamSink(sink: ParamSinkImpl, sql: string, placeholder: (index: number) => string): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const seen = new Set<string>();
  const resolved = sql.replace(TOKEN_RE, (match) => {
    if (seen.has(match)) {
      throw new Error(`ParamSink: token ${JSON.stringify(match)} appears more than once in emitted SQL text — refusing to bind (duplicate/forged token).`);
    }
    if (!sink.recorded.has(match)) {
      throw new Error(`ParamSink: token ${JSON.stringify(match)} found in emitted SQL text but was never recorded — refusing to bind (forged/foreign token).`);
    }
    seen.add(match);
    params.push(sink.recorded.get(match));
    return placeholder(params.length);
  });
  if (seen.size !== sink.recorded.size) {
    const orphaned = [...sink.recorded.keys()].filter((t) => !seen.has(t));
    throw new Error(`ParamSink: ${orphaned.length} recorded token(s) never appeared in the emitted SQL text — refusing to bind (orphaned token(s)).`);
  }
  return { sql: resolved, params };
}
