import CronParser from "cron-parser";

/**
 * v4 migration slice B2 (docs/plans/planometry-v4-migration.md §8, §10
 * (B2)): a job's `--schedule` is a plain 5-field cron string (minute
 * hour day-of-month month day-of-week — no seconds field, unlike
 * cron-parser's own default), evaluated in the connection's
 * `sourceTimeZone`. `cron-parser` is already present in the repo's
 * lockfile (a dependency of `bullmq`, used by apps/worker) and itself
 * depends on `luxon` for IANA timezone support — reused here rather
 * than adding a second cron implementation.
 *
 * Imported as a default import, not `{ parseExpression }`: cron-parser
 * is CommonJS and assigns its exports via `CronParser.parseExpression =
 * ...; module.exports = CronParser;` — an indirection Node's ESM loader
 * (cjs-module-lexer) cannot statically detect, so a named import throws
 * `SyntaxError: The requested module 'cron-parser' does not provide an
 * export named 'parseExpression'` under `node dist/index.js` and under
 * `tsx src/index.ts` alike (discovered during Phase B close's real-run
 * verification). A default import always works for CJS interop since it
 * just binds the whole `module.exports` value.
 */
export class InvalidCronScheduleError extends Error {}

/** Throws InvalidCronScheduleError if `expression` isn't exactly 5 whitespace-separated fields, or isn't parseable. */
export function validateCronExpression(expression: string): void {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new InvalidCronScheduleError(`cron schedule must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}: ${JSON.stringify(expression)}`);
  }
  try {
    CronParser.parseExpression(expression);
  } catch (err) {
    throw new InvalidCronScheduleError(`invalid cron schedule ${JSON.stringify(expression)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Next fire time strictly after `after`, evaluated in `timeZone` (IANA name, e.g. "America/New_York"). */
export function nextOccurrence(expression: string, timeZone: string, after: Date): Date {
  const interval = CronParser.parseExpression(expression, { currentDate: after, tz: timeZone });
  return interval.next().toDate();
}
