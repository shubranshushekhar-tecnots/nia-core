import type { RefObject } from 'react';
import Reveal from './Reveal';
import { whiteBtn } from './styles';

export default function CtaBand({ bandRef }: { bandRef: RefObject<HTMLElement> }) {
  return (
    <Reveal
      as="section"
      ref={bandRef}
      style={{ position: 'relative', zIndex: 1, maxWidth: 1180, margin: '0 auto', boxSizing: 'border-box', padding: '74px 24px 0', willChange: 'transform, opacity' }}
    >
      <div
        style={{
          position: 'relative',
          overflow: 'hidden',
          boxSizing: 'border-box',
          padding: '96px 32px 104px',
          borderRadius: 26,
          background: 'linear-gradient(130deg,#4F46E5,#6D28D9 60%,#0E7490)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 18,
          textAlign: 'center',
        }}
      >
        <span aria-hidden="true" style={{ position: 'absolute', inset: 0, opacity: 0.16, backgroundImage: 'radial-gradient(circle,#FFFFFF 1px,transparent 1px)', backgroundSize: '20px 20px' }} />
        <h2 style={{ position: 'relative', margin: 0, maxWidth: 620, fontSize: 'clamp(26px,3.6vw,38px)', fontWeight: 700, letterSpacing: '-.03em', color: '#FFFFFF' }}>
          Move your first million rows tonight
        </h2>
        <a href="/signup" style={whiteBtn}>Start free — no card</a>
      </div>
    </Reveal>
  );
}
