import { parseExpression } from "cron-parser";

/**
 * v4 migration slice B2 (docs/plans/planometry-v4-migration.md §8, §10
 * (B2)): a job's `--schedule` is a plain 5-field cron string (minute
 * hour day-of-month month day-of-week — no seconds field, unlike
 * cron-parser's own default), evaluated in the connection's
 * `sourceTimeZone`. `cron-parser` is already present in the repo's
 * lockfile (a dependency of `bullmq`, used by apps/worker) and itself
 * depends on `luxon` for IANA timezone support — reused here rather
 * than adding a second cron implementation.
 */
export class InvalidCronScheduleError extends Error {}

/** Throws InvalidCronScheduleError if `expression` isn't exactly 5 whitespace-separated fields, or isn't parseable. */
export function validateCronExpression(expression: string): void {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new InvalidCronScheduleError(`cron schedule must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}: ${JSON.stringify(expression)}`);
  }
  try {
    parseExpression(expression);
  } catch (err) {
    throw new InvalidCronScheduleError(`invalid cron schedule ${JSON.stringify(expression)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Next fire time strictly after `after`, evaluated in `timeZone` (IANA name, e.g. "America/New_York"). */
export function nextOccurrence(expression: string, timeZone: string, after: Date): Date {
  const interval = parseExpression(expression, { currentDate: after, tz: timeZone });
  return interval.next().toDate();
}
