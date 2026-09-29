/**
 * Learning-mode Layer 2 — decides what SQL/shell text (if any) HelpPanel
 * shows for a given step x connector, and whether it's ever allowed to show
 * a Copy button.
 *
 * Pure, non-React logic (no DOM) so it can be unit-tested directly under
 * apps/web/vitest.config.ts's `src/lib/**` scope, without needing jsdom or a
 * component renderer.
 *
 * Rule (review feedback on Step 3): a Copy button must never appear next to
 * SQL built from shared placeholders. `shouldShowCopyButton` returns true
 * only for `mode: "real"`, and `"real"` mode only ever occurs when the
 * caller explicitly passed real `HelpSqlValues` — illustration mode always
 * uses `HELP_SQL_ILLUSTRATION_VALUES` (placeholders) and can never reach
 * `"real"`. This holds by construction, not by a convention callers could
 * forget.
 */
import { getHelpSection, HELP_SQL_ILLUSTRATION_VALUES, type HelpSqlValues } from '@nia/schemas';
import type { HelpStepKey } from '@nia/schemas';

export type ResolvedHelpSql =
  | { mode: 'none' }
  | { mode: 'unavailable' }
  | { mode: 'invalid'; message: string }
  | { mode: 'illustration'; text: string }
  | { mode: 'real'; text: string };

type SqlFn = (values: HelpSqlValues) => string | null;

function callSql(sql: SqlFn, values: HelpSqlValues): { text: string } | { error: string } | { unavailable: true } {
  try {
    const text = sql(values);
    if (text === null) return { unavailable: true };
    return { text };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * `values` is the caller's real, currently-active credential/namespace
 * values (from the calling screen — e.g. a just-generated read-only user).
 * Pass `undefined` when no real values exist yet (e.g. the dialog hasn't
 * generated a credential), which falls back to illustration mode.
 */
export function resolveHelpSql(
  step: HelpStepKey,
  connectorId: string,
  values: HelpSqlValues | undefined,
): ResolvedHelpSql {
  const section = getHelpSection(step, connectorId);
  if (!section?.sql) return { mode: 'none' };

  if (values) {
    const result = callSql(section.sql, values);
    if ('unavailable' in result) return { mode: 'unavailable' };
    if ('error' in result) return { mode: 'invalid', message: result.error };
    return { mode: 'real', text: result.text };
  }

  const illustration = HELP_SQL_ILLUSTRATION_VALUES[step];
  if (!illustration) return { mode: 'none' };
  const result = callSql(section.sql, illustration);
  if ('unavailable' in result) return { mode: 'unavailable' };
  if ('error' in result) return { mode: 'invalid', message: result.error };
  return { mode: 'illustration', text: result.text };
}

/** True only for `"real"` mode — see file header for why this is by construction, not convention. */
export function shouldShowCopyButton(resolved: ResolvedHelpSql): boolean {
  return resolved.mode === 'real';
}
