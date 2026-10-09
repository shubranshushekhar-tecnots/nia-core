import type { Ref } from 'react';
import { cssVar } from './cssVar';

const HEADLINE_FONT = "'Suisse Intl', 'Helvetica Neue', Helvetica, Arial, sans-serif";

// HERO (black, matches the live site). Port of
// designs/nia-hero/index.html lines 328-335.
export default function HeroHeadline({ windowRef }: { windowRef: Ref<HTMLSpanElement> }) {
  return (
    <div className="nx-hero" style={{ opacity: 'var(--c0, 1)', pointerEvents: cssVar<'pointerEvents'>('var(--pe0, auto)'), color: '#FFFFFF' }}>
      <h1 style={{ margin: 0, fontFamily: HEADLINE_FONT, fontWeight: 300, fontSize: 'clamp(2.6rem, 7.4vw, 8rem)', lineHeight: 1, letterSpacing: '-0.04em' }}>
        Extract. Transform.
        <span style={{ color: '#6366F1' }}>Load.</span>
        <br />
        All on one{' '}
        <span
          ref={windowRef}
          id="nx-window"
          style={{
            display: 'inline-block', width: '1.75em', height: '0.74em', verticalAlign: '-0.02em',
            outline: '1px solid rgba(255,255,255,calc(0.9 * var(--win-o, 1)))', outlineOffset: 0,
          }}
        />{' '}
        canvas.
      </h1>
    </div>
  );
}
