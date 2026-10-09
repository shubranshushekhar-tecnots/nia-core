type Word = { step: string; word: string; inVar: string; outVar: string };

const WORDS: Word[] = [
  { step: 'Step 01 / 03', word: 'Extract', inVar: 'var(--we-in, 0)', outVar: 'var(--we-o, 0)' },
  { step: 'Step 02 / 03', word: 'Transform', inVar: 'var(--wt-in, 0)', outVar: 'var(--wt-o, 0)' },
  { step: 'Step 03 / 03', word: 'Load', inVar: 'var(--wl-in, 0)', outVar: 'var(--wl-o, 0)' },
];

// STAGE WORDS — Extract. Transform. Load. Port of
// designs/nia-hero/index.html lines 337-346.
export default function StageWords() {
  return (
    <>
      {WORDS.map((w) => (
        <div
          key={w.word}
          aria-hidden="true"
          className="nx-big"
          style={{
            opacity: w.outVar,
            clipPath: `inset(-20% calc((1 - ${w.inVar}) * 100%) -20% 0)`,
            transform: `translateY(calc(-50% + (1 - ${w.outVar}) * -30px))`,
          }}
        >
          <span className="nx-mono" style={{ display: 'block', fontSize: 12, letterSpacing: '0.2em', color: '#4F46E5', marginBottom: 8 }}>
            {w.step}
          </span>
          {w.word}
          <span style={{ color: '#4F46E5' }}>.</span>
        </div>
      ))}
    </>
  );
}
