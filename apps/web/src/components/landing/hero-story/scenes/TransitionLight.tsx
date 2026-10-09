// transition light (rack → drive, drive → fibre). Port of
// designs/nia-hero/index.html lines 314-317.
export default function TransitionLight() {
  return (
    <>
      <div
        aria-hidden="true"
        style={{
          position: 'absolute', inset: 0, zIndex: 4, pointerEvents: 'none',
          background: 'radial-gradient(circle at 50% 50%, rgba(238,242,255,1) 0%, rgba(165,180,252,0.85) 14%, rgba(129,140,248,0.4) 30%, rgba(248,250,252,0) 52%)',
          transform: 'scale(var(--bloom1-s, 0.3))', opacity: 'var(--bloom1-o, 0)',
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute', inset: 0, zIndex: 4, pointerEvents: 'none',
          background: 'radial-gradient(ellipse 46% 9% at 50% 50%, rgba(255,255,255,1) 0%, rgba(238,242,255,0.95) 35%, rgba(165,180,252,0.6) 62%, rgba(99,102,241,0.18) 82%, rgba(99,102,241,0) 100%)',
          transform: 'scale(var(--bloom-s, 0.35))', opacity: 'var(--bloom-o, 0)',
        }}
      />
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, zIndex: 5, pointerEvents: 'none', background: '#F8FAFC', opacity: 'var(--flash, 0)' }} />
    </>
  );
}
