'use client';

import { useEffect, useState } from 'react';
import { pixelAvatar } from '@/lib/avatar';

/**
 * Deterministic "Pixel mark" avatar (see lib/avatar.ts + the "Generated
 * avatar options" design board). `seed` is normally the user id — every
 * person gets the same avatar every time, no upload needed.
 *
 * Shuffle is intentionally client-only: there's no `avatar_seed` column on
 * `profiles` (adding one would be a schema/logic change, out of scope for
 * this redesign — see docs/decisions.md), so "shuffle" just layers a
 * localStorage-persisted suffix on top of the real seed. It only survives
 * on this browser/device; a fresh session elsewhere always falls back to
 * the deterministic default.
 */
export default function Avatar({
  seed,
  size,
  shuffle = false,
  title,
}: {
  seed: string;
  size: number;
  /** Show the shuffle button (profile card only; never in the rail/topbar). */
  shuffle?: boolean;
  title?: string;
}) {
  const storageKey = `nia-avatar-shuffle:${seed}`;
  const [override, setOverride] = useState<string | null>(null);

  useEffect(() => {
    if (!shuffle) return;
    setOverride(window.localStorage.getItem(storageKey));
  }, [shuffle, storageKey]);

  const effectiveSeed = override ? `${seed}:${override}` : seed;
  const grid = size <= 20 ? 3 : 5;
  const avatar = pixelAvatar(effectiveSeed, size, grid);

  function handleShuffle() {
    const next = Math.random().toString(36).slice(2, 8);
    window.localStorage.setItem(storageKey, next);
    setOverride(next);
  }

  return (
    <span style={{ position: 'relative', display: 'inline-flex', flex: 'none' }}>
      <span
        role="img"
        aria-label={title ?? 'Avatar'}
        title={title}
        style={{
          width: avatar.size,
          height: avatar.size,
          borderRadius: avatar.size / 2,
          background: avatar.colors[1],
          boxSizing: 'border-box',
          padding: avatar.padding,
          display: 'grid',
          gridTemplateColumns: `repeat(${avatar.grid}, minmax(0, 1fr))`,
          alignContent: 'center',
          flex: 'none',
        }}
      >
        {avatar.cells.map((cell, i) => (
          <span
            key={i}
            aria-hidden
            style={{ display: 'block', aspectRatio: '1', borderRadius: 1, background: cell.color }}
          />
        ))}
      </span>
      {shuffle && (
        <button
          type="button"
          onClick={handleShuffle}
          title="Shuffle avatar"
          aria-label="Shuffle avatar"
          style={{
            position: 'absolute',
            right: -4,
            bottom: -4,
            width: 26,
            height: 26,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--surface, #FFFFFF)',
            border: '1px solid var(--line-200, #DEDEE3)',
            boxShadow: '0 1px 2px rgba(16,18,27,.12)',
            color: 'var(--ink-200, #52555C)',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          {'\u21BB'}
        </button>
      )}
    </span>
  );
}
