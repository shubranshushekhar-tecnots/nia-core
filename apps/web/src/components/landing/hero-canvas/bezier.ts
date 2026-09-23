// Self-contained cubic-bezier(x1,y1,x2,y2) solver (WebKit UnitBezier
// algorithm — Newton-Raphson with a bisection fallback). No dependency:
// the brief's easing curve `cubic-bezier(.16, 1, .3, 1)` needs to be
// evaluated in JS (scroll-linked animation, not a CSS transition), and
// this is the standard, well-tested way to do that in ~25 lines.
export function makeBezierEasing(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleCurveX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleCurveY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleCurveDerivativeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  function solveCurveX(x: number, epsilon = 1e-6): number {
    let t2 = x;
    for (let i = 0; i < 8; i++) {
      const x2Err = sampleCurveX(t2) - x;
      if (Math.abs(x2Err) < epsilon) return t2;
      const d2 = sampleCurveDerivativeX(t2);
      if (Math.abs(d2) < 1e-6) break;
      t2 = t2 - x2Err / d2;
    }
    let t0 = 0;
    let t1 = 1;
    t2 = x;
    if (t2 < t0) return t0;
    if (t2 > t1) return t1;
    while (t0 < t1) {
      const x2 = sampleCurveX(t2);
      if (Math.abs(x2 - x) < epsilon) return t2;
      if (x > x2) t0 = t2;
      else t1 = t2;
      t2 = (t1 - t0) * 0.5 + t0;
    }
    return t2;
  }

  return function ease(x: number): number {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return sampleCurveY(solveCurveX(x));
  };
}

export const heroEase = makeBezierEasing(0.16, 1, 0.3, 1);

export const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
