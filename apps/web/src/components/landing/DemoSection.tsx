import type { RefObject } from 'react';
import WatchRunSection from './watch-run/WatchRunSection';

// Outer <section> is kept byte-identical to the previous static mock's
// wrapper: LandingPage.tsx's scroll handler imperatively mutates
// `stage.style.transform` / `borderTopLeftRadius/Right` on this exact node
// (via stageRef) for the hero-to-stage parallax handoff — do not change
// id/ref/these base styles without re-checking that effect.
export default function DemoSection({ stageRef }: { stageRef: RefObject<HTMLElement> }) {
  return (
    <section
      id="product"
      ref={stageRef}
      style={{
        position: 'relative',
        zIndex: 2,
        maxWidth: 1260,
        margin: '-44px auto 0',
        boxSizing: 'border-box',
        padding: '88px 24px 8px',
        background: 'var(--bg)',
        borderRadius: '36px 36px 0 0',
        boxShadow: '0 -30px 60px -34px rgba(79,70,229,.35)',
        willChange: 'transform, opacity',
      }}
    >
      <WatchRunSection />
    </section>
  );
}
