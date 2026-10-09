import type { CSSProperties } from 'react';

// The reference markup reads scroll-driven values via raw `var(--x, default)`
// strings on CSS properties whose TS types are narrow enums (visibility,
// pointer-events, etc.) rather than plain strings. This just tells
// TypeScript to trust the string the same way the browser does.
export function cssVar<K extends keyof CSSProperties>(value: string): CSSProperties[K] {
  return value as CSSProperties[K];
}
