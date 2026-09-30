import { initials } from '@/components/app/home/RightPanel';

/**
 * Precision Dark redesign (Step 8A item 5): square, 0-radius avatar —
 * replaces the old "pixel mark" generated pattern (lib/avatar.ts, deleted)
 * with the same initials treatment TopBar's own profile trigger already
 * uses (components/app/home/RightPanel.tsx's `initials()`). `imageUrl` is
 * accepted for forward-compat with a future uploaded-avatar feature (no
 * `avatar_url` column exists yet — see docs/decisions.md) — image avatars
 * render as a square-cropped <img>, initials avatars stay text-only.
 */
export default function Avatar({
  name,
  size,
  imageUrl,
  title,
}: {
  name: string | null;
  size: number;
  imageUrl?: string | null;
  title?: string;
}) {
  const style = {
    width: size,
    height: size,
    borderRadius: 0,
    background: 'var(--nx-raised)',
    color: 'var(--nx-ink)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none',
    overflow: 'hidden',
  } as const;

  if (imageUrl) {
    return (
      <span role="img" aria-label={title ?? 'Avatar'} title={title} style={style}>
        <img src={imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </span>
    );
  }

  const label = initials(name);
  const useCondensed = size >= 28;

  return (
    <span
      role="img"
      aria-label={title ?? 'Avatar'}
      title={title}
      style={{
        ...style,
        fontFamily: useCondensed ? 'var(--nx-font-condensed)' : 'var(--nx-font-mono)',
        fontStretch: useCondensed ? '62.5%' : undefined,
        fontWeight: useCondensed ? 700 : 500,
        textTransform: useCondensed ? 'uppercase' : undefined,
        letterSpacing: useCondensed ? '0.02em' : undefined,
        fontSize: Math.max(10, Math.round(size * 0.4)),
      }}
    >
      {label}
    </span>
  );
}
