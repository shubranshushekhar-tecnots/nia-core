// Deterministic "Pixel mark" generated avatar — ported verbatim from the
// canonical algorithm in designs/Nia Core — Workflow Canvas.html's
// "Generated avatar options" board (the `pixel(seed, size, grid)` method
// on that board's Component class). Same seed always renders the same
// mirrored grid + color pair; no upload, no server round-trip, no stored
// state required.

/** FNV-1a 32-bit hash, matching the design's `hash(s)` exactly. */
export function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// [strong, soft] color pairs — strong fills "on" cells, soft is the
// circular container background. Order/values are verbatim from the design.
const HUES: [string, string][] = [
  ['#594CDF', '#EEECFD'],
  ['#2F7D6D', '#E3F2EE'],
  ['#C2562B', '#FBEAE2'],
  ['#3867D6', '#E6EDFB'],
  ['#9C3D8F', '#F6E6F3'],
  ['#0E7490', '#E0F2F6'],
];

export type AvatarCell = { on: boolean; color: string };

export type PixelAvatar = {
  /** Strong/soft color pair for this seed. */
  colors: readonly [string, string];
  /** grid × grid cells, row-major, left-right mirrored. */
  cells: AvatarCell[];
  /** Size in px the grid was generated for. */
  size: number;
  grid: number;
  /** Inner padding (20% of size), matching the design's `pad`. */
  padding: number;
};

/**
 * Builds a deterministic pixel-mark avatar for `seed`.
 * `grid` defaults to 5 (use 3 for sizes <= 20px per the design's "In use"
 * section — callers should pass `grid={size <= 20 ? 3 : 5}` explicitly,
 * this function doesn't decide that on its own so it stays a pure,
 * predictable function of its three inputs).
 */
export function pixelAvatar(seed: string, size: number, grid = 5): PixelAvatar {
  const h = hashSeed(seed);
  const pair = HUES[h % HUES.length] ?? HUES[0]!;
  const bits = h >>> 3;
  const n = grid;
  const half = Math.ceil(n / 2);
  const cells: AvatarCell[] = [];

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const cc = c < half ? c : n - 1 - c;
      const on = ((bits >> (r * half + cc)) & 1) === 1;
      cells.push({ on, color: on ? pair[0] : 'transparent' });
    }
  }

  return {
    colors: pair,
    cells,
    size,
    grid: n,
    padding: Math.round(size * 0.2),
  };
}
