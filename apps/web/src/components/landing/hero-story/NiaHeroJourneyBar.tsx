import { cssVar } from './cssVar';
import { CHAPTER_NAMES } from './useNiaHeroEngine';

// JOURNEY BAR — numbered list + hairline, like "What Nia Core does". Port of
// designs/nia-hero/index.html lines 416-427; HUD color mapping ported from
// renderVals() (lines 756-764): active chapter is darkest, passed chapters
// mid-grey, upcoming chapters light grey; the number dot lights up indigo
// once its chapter has been reached.
export default function NiaHeroJourneyBar({ chapter, status }: { chapter: number; status: string }) {
  return (
    <div
      style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 9, background: '#FFFFFF',
        borderTop: '1px solid #E2E8F0', opacity: 'var(--o-hud, 0)', visibility: cssVar<'visibility'>('var(--v-hud, hidden)'),
      }}
    >
      <div style={{ height: 2, background: '#E2E8F0' }}>
        <div style={{ height: '100%', width: 'calc(var(--p, 0) * 100%)', background: '#4F46E5' }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '16px max(20px, 4vw)' }}>
        <div style={{ display: 'flex', gap: 30 }}>
          {CHAPTER_NAMES.map((name, i) => {
            const n = i + 1;
            const color = chapter === n ? '#0F172A' : chapter > n ? '#334155' : '#64748B';
            const numColor = chapter >= n ? '#4F46E5' : '#64748B';
            return (
              <span key={name} className="nx-mono" style={{ display: 'flex', gap: 8, fontSize: 11, color }}>
                <span style={{ color: numColor }}>0{n}</span>
                <span className="nx-hudlabel">{name}</span>
              </span>
            );
          })}
        </div>
        <span className="nx-mono" style={{ fontSize: 11, color: '#64748B', whiteSpace: 'nowrap' }}>
          Row 4821 · <span style={{ color: '#0F172A' }}>{status}</span>
        </span>
      </div>
    </div>
  );
}
