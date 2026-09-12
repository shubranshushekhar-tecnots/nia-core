// Relative-time + duration formatting for the dashboard. No dayjs — these
// are small, fixed formats (run timestamps, run durations) that don't need
// a full date library.

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 60 * 60 * 24 * 365],
  ['month', 60 * 60 * 24 * 30],
  ['week', 60 * 60 * 24 * 7],
  ['day', 60 * 60 * 24],
  ['hour', 60 * 60],
  ['minute', 60],
];

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "3 hours ago", "just now", etc. */
export function relativeTime(iso: string): string {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 45) return 'just now';

  for (const [unit, secondsInUnit] of UNITS) {
    if (seconds >= secondsInUnit) {
      return rtf.format(-Math.round(seconds / secondsInUnit), unit);
    }
  }
  return rtf.format(-Math.round(seconds), 'second');
}

/** 1240 -> "1.2s", 45000 -> "45s", 125000 -> "2m 5s" */
export function formatDuration(ms: number | null): string {
  if (ms == null) return '\u2014';
  if (ms < 1000) return `${ms}ms`;

  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** "Good morning" / "Good afternoon" / "Good evening" from the server clock. */
export function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
