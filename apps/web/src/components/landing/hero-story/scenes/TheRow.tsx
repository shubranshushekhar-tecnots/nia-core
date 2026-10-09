// THE ROW — a node card riding a square pulse. Port of
// designs/nia-hero/index.html lines 319-326.
export default function TheRow() {
  return (
    <div className="nx-anchor" aria-hidden="true" style={{ zIndex: 7 }}>
      <div
        style={{
          position: 'absolute', left: -9, top: -9, width: 18, height: 18, background: '#6366F1',
          boxShadow: '0 0 0 6px rgba(99,102,241,0.18), 0 0 40px 14px rgba(99,102,241,0.55)',
          opacity: 'var(--dot-o, 0)',
        }}
      />
      <div className="nd" style={{ left: 0, top: -50, transform: 'translate(-50%, -100%)', opacity: 'var(--dot-o, 0)', width: 236, borderColor: '#5446E0' }}>
        <div className="nd-h" style={{ padding: '10px 12px' }}>
          <span className="nd-i" style={{ width: 30, height: 30 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/landing/logos/sql-server.svg" alt="" width={16} height={16} />
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span className="nd-l" style={{ fontSize: 10 }}>ROW</span>
            <span className="nd-t" style={{ fontSize: 15 }}>dbo.orders #4821</span>
          </span>
        </div>
        <div className="nd-r" style={{ padding: '7px 12px' }}>
          <span>branch</span>
          <b>&apos;North&apos;</b>
        </div>
      </div>
    </div>
  );
}
