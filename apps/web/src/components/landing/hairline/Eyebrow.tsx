import type { CSSProperties, ReactNode } from 'react';
import { eyebrowStyle } from './styles';

// The brand's rail voice: 11px uppercase/500/0.16em tracking. Uppercase is
// set here in CSS (textTransform), never typed into the copy string.
// `tone="inverted"` is for use on a dark ground (CtaBand), per the brief's
// "inverted ground ... #8e9096 for the eyebrow" token row.
export default function Eyebrow({
  children,
  tone = 'default',
  style,
}: {
  children: ReactNode;
  tone?: 'default' | 'inverted';
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        ...eyebrowStyle,
        ...(tone === 'inverted' ? { color: 'var(--hl-ink-4)' } : null),
        ...style,
      }}
    >
      {children}
    </span>
  );
}
