/** Shared SVG line/area path helpers for the trend charts. A `null` value
 *  means "no data for this point" (either the day is outside the loaded
 *  window, or — for duration — the day has no succeeded, timed runs) and
 *  must never be interpolated through: each contiguous run of non-null
 *  values becomes its own path segment, so a gap in the data renders as a
 *  visible gap in the line, not a straight line drawn across it. */

export type ChartPoint = { x: number; y: number; has: boolean };

export function buildPoints(
  values: (number | null)[],
  x0: number,
  w: number,
  y0: number,
  h: number,
  max: number,
): ChartPoint[] {
  const n = values.length;
  return values.map((v, i) => ({
    x: x0 + (w * i) / Math.max(1, n - 1),
    y: v === null ? y0 + h : y0 + h - (h * v) / (max || 1),
    has: v !== null,
  }));
}

function toPath(pts: ChartPoint[]): string {
  return 'M' + pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L');
}

/** One path string per contiguous run of loaded points. Runs of a single
 *  point produce a degenerate (invisible) path on purpose — a lone data
 *  point isn't a trend and shouldn't be drawn as one; callers may render a
 *  dot for it instead if desired. */
export function lineSegments(points: ChartPoint[]): string[] {
  const segments: string[] = [];
  let current: ChartPoint[] = [];
  for (const p of points) {
    if (p.has) current.push(p);
    else if (current.length) {
      segments.push(toPath(current));
      current = [];
    }
  }
  if (current.length) segments.push(toPath(current));
  return segments;
}

export function areaSegments(points: ChartPoint[], baselineY: number): string[] {
  const segments: string[] = [];
  let current: ChartPoint[] = [];
  const flush = () => {
    const first = current[0];
    const last = current[current.length - 1];
    if (current.length > 1 && first && last) {
      segments.push(`${toPath(current)} L${last.x.toFixed(1)} ${baselineY} L${first.x.toFixed(1)} ${baselineY} Z`);
    }
    current = [];
  };
  for (const p of points) {
    if (p.has) current.push(p);
    else flush();
  }
  flush();
  return segments;
}

/** Last point of the last non-empty segment — used to anchor an end-of-line
 *  value label. Null when nothing is loaded, so callers can skip the label
 *  instead of anchoring it to a fabricated position. */
export function lastLoadedPoint(points: ChartPoint[]): ChartPoint | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (p && p.has) return p;
  }
  return null;
}

const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function formatCompactNumber(n: number): string {
  return compactNumber.format(n);
}
