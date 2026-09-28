/** Builds an SVG path for a small KPI sparkline. Only draws through points
 *  the caller marks `loaded` — never interpolates across an unloaded gap,
 *  so a truncated data window never renders as a fabricated trend. */
export function sparklinePath(values: number[]): { line: string; area: string } | null {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values) * 0.8;
  const n = values.length;
  const span = max - min || 1;
  const pts = values.map((v, i) => [(96 * i) / (n - 1), 30 - (26 * (v - min)) / span] as const);
  const line = 'M' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L');
  const area = `${line} L96 32 L0 32 Z`;
  return { line, area };
}
