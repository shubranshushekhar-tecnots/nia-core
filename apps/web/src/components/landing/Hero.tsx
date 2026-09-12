import type { RefObject } from 'react';

export default function Hero({ heroRef }: { heroRef: RefObject<HTMLElement> }) {
  return (
    <header
      ref={heroRef}
      style={{
        position: 'relative',
        zIndex: 1,
        maxWidth: 1260,
        margin: '0 auto',
        boxSizing: 'border-box',
        padding: '26px 24px 0',
        willChange: 'transform, opacity',
      }}
    >
      <div
        style={{
          position: 'relative',
          overflow: 'hidden',
          boxSizing: 'border-box',
          minHeight: 'min(76vh, 700px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '132px 28px 140px',
          borderRadius: 34,
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          boxShadow: '0 40px 90px -46px rgba(79,70,229,.42)',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: 'radial-gradient(circle,#E7ECF3 1px,transparent 1px)',
            backgroundSize: '20px 20px',
            pointerEvents: 'none',
          }}
        />

        <div style={{ position: 'relative', zIndex: 2, maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, textAlign: 'center' }}>
          <h1 style={{ margin: 0, fontSize: 'clamp(34px,5vw,60px)', fontWeight: 700, lineHeight: 1.12, letterSpacing: '-.035em' }}>
            <span style={{ display: 'block', animation: 'riseIn .6s cubic-bezier(.2,.7,.2,1) .1s both' }}>
              <span style={{ color: 'var(--c-data)' }}>Extract.</span> <span style={{ color: 'var(--c-action)' }}>Transform.</span> <span style={{ color: 'var(--c-condition)' }}>Load.</span>
            </span>
            <span style={{ display: 'block', marginTop: 6, color: 'var(--muted)', fontSize: '.72em', animation: 'riseIn .6s cubic-bezier(.2,.7,.2,1) .2s both' }}>
              All on one canvas you can watch.
            </span>
          </h1>
          <p style={{ margin: 0, maxWidth: 600, fontSize: 18, lineHeight: 1.65, color: 'var(--secondary)', animation: 'riseIn .6s cubic-bezier(.2,.7,.2,1) .3s both' }}>
            Draw the ETL pipeline, schedule it, and wake up to dashboards that filled themselves.
          </p>
        </div>
      </div>
    </header>
  );
}
