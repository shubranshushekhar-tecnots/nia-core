'use client';

import { useState } from 'react';
import type { CSSProperties } from 'react';

const baseStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 8px',
  border: '1px solid var(--nx-line)',
  background: 'var(--nx-surface)',
  color: 'var(--nx-ink-2)',
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  cursor: 'pointer',
  flex: 'none',
};

// Small "copy" button used next to checksums and inside code blocks on the
// public downloads/docs pages — writes `text` to the clipboard and flips
// its own label to "Copied" for a beat, no toast/global state needed.
export default function CopyButton({ text, style }: { text: string; style?: CSSProperties }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — nothing more we can do.
    }
  }

  return (
    <button type="button" onClick={handleCopy} style={{ ...baseStyle, ...style }} aria-label="Copy to clipboard">
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
