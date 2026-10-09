import { cssVar } from '../cssVar';

// 01 · EXTRACT — the data center, seen first through the headline's node
// window, then dollied down the aisle into a rack, match-cut to a close-up
// of its drive bay. Port of designs/nia-hero/index.html lines 107-131.
export default function ExtractScene() {
  return (
    <>
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 1,
          clipPath: 'var(--s1-clip, inset(50% 50% 50% 50%))',
          visibility: cssVar<'visibility'>('var(--v1, visible)'),
        }}
      >
        <div style={{ position: 'absolute', inset: 0, transform: 'var(--s1-pre, none)', transformOrigin: '50% 50%' }}>
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: 1672,
              height: 941,
              transform: 'translate(-836px, -500px) scale(var(--cover, 1))',
              transformOrigin: '836px 500px',
            }}
          >
            <div
              style={{
                position: 'absolute',
                inset: 0,
                transform: 'scale(var(--s-room, 1))',
                transformOrigin: '836px 500px',
                filter: 'blur(var(--room-blur, 0px))',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/landing/s1-room.webp"
                alt=""
                style={{ position: 'absolute', left: 0, top: 0, width: 1672, height: 941, maxWidth: 'none', display: 'block' }}
              />
            </div>
            <div
              style={{
                position: 'absolute',
                left: 324,
                top: -242,
                width: 1024,
                height: 1536,
                transform: 'scale(var(--s-hero, 0.0977))',
                transformOrigin: '512px 742px',
                filter: 'blur(var(--hero-blur, 0px))',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: 60,
                  top: 1480,
                  width: 904,
                  height: 120,
                  background: 'radial-gradient(ellipse at center, rgba(15,23,42,0.28), rgba(15,23,42,0) 70%)',
                }}
              />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/landing/s1-rack-hero.webp"
                alt=""
                style={{ position: 'absolute', left: 0, top: 0, width: 1024, height: 1536, maxWidth: 'none', display: 'block' }}
              />
              <div
                className="glowpulse"
                style={{
                  position: 'absolute',
                  left: 132,
                  top: 662,
                  width: 760,
                  height: 160,
                  background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.55), rgba(99,102,241,0) 68%)',
                }}
              />
            </div>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                transform: 'scale(var(--s-racks, 1))',
                transformOrigin: '836px 500px',
                opacity: 'var(--o-racks, 1)',
                filter: 'blur(var(--racks-blur, 0px))',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/landing/s1-racks.webp"
                alt=""
                style={{ position: 'absolute', left: 0, top: 0, width: 1672, height: 941, maxWidth: 'none', display: 'block' }}
              />
            </div>
          </div>
        </div>
      </div>
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 1,
          background: '#F7FAFE',
          opacity: 'var(--o-drive, 0)',
          visibility: cssVar<'visibility'>('var(--v-drive, hidden)'),
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: 2172,
            height: 724,
            transform: 'var(--t-bay, none)',
            transformOrigin: '0 0',
            filter: 'blur(var(--bay-blur, 0px))',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/landing/s1-bay-closeup.webp"
            alt=""
            style={{ position: 'absolute', left: 0, top: 0, width: 2172, height: 724, maxWidth: 'none', display: 'block' }}
          />
          <div
            className="glowpulse"
            style={{
              position: 'absolute',
              left: 1050,
              top: 190,
              width: 215,
              height: 92,
              background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.5), rgba(99,102,241,0) 70%)',
            }}
          />
        </div>
      </div>
      <div
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, zIndex: 5, pointerEvents: 'none', background: '#F7FAFE', opacity: 'var(--flash-a, 0)' }}
      />
    </>
  );
}
