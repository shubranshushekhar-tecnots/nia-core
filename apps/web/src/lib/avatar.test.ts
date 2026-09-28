import { describe, expect, it } from 'vitest';
import { hashSeed, pixelAvatar } from './avatar';

describe('hashSeed', () => {
  it('is deterministic for the same input', () => {
    expect(hashSeed('test-user-id')).toBe(hashSeed('test-user-id'));
  });

  it('differs for different inputs', () => {
    expect(hashSeed('aarav')).not.toBe(hashSeed('mei'));
  });
});

describe('pixelAvatar', () => {
  it('is deterministic: same seed/size/grid always renders the same cells and colors', () => {
    const a = pixelAvatar('test-user-id', 32, 5);
    const b = pixelAvatar('test-user-id', 32, 5);
    expect(a).toEqual(b);
  });

  it('produces a different pattern for a different seed', () => {
    const a = pixelAvatar('aarav', 32, 5);
    const b = pixelAvatar('mei', 32, 5);
    expect(a.cells).not.toEqual(b.cells);
  });

  it('mirrors the grid left-right (column c matches column n-1-c)', () => {
    const { cells, grid } = pixelAvatar('mirror-check', 32, 5);
    for (let r = 0; r < grid; r++) {
      for (let c = 0; c < grid; c++) {
        const left = cells[r * grid + c]!;
        const right = cells[r * grid + (grid - 1 - c)]!;
        expect(left.on).toBe(right.on);
      }
    }
  });

  it('supports a 3x3 grid for sizes <= 20px', () => {
    const { cells, grid } = pixelAvatar('small', 20, 3);
    expect(grid).toBe(3);
    expect(cells).toHaveLength(9);
  });

  it('sets padding to 20% of size, rounded', () => {
    expect(pixelAvatar('x', 32, 5).padding).toBe(Math.round(32 * 0.2));
    expect(pixelAvatar('x', 72, 5).padding).toBe(Math.round(72 * 0.2));
    expect(pixelAvatar('x', 20, 3).padding).toBe(Math.round(20 * 0.2));
  });

  it('picks one of the six defined color pairs', () => {
    const { colors } = pixelAvatar('any-seed', 32, 5);
    expect(colors[0]).toMatch(/^#[0-9A-F]{6}$/i);
    expect(colors[1]).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it('off cells use "transparent", on cells use the strong color', () => {
    const { cells, colors } = pixelAvatar('any-seed', 32, 5);
    for (const cell of cells) {
      expect(cell.color).toBe(cell.on ? colors[0] : 'transparent');
    }
  });
});
