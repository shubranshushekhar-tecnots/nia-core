import type { RefObject } from 'react';
import { ghostBtn, gradientBtn } from './styles';

export default function Nav({ navRef }: { navRef: RefObject<HTMLElement> }) {
  return (
    <nav
      ref={navRef}
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        boxSizing: 'border-box',
        padding: '14px 0',
        background: 'rgba(248,250,252,.82)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderBottom: '1px solid transparent',
        transition: 'border-color .2s ease, box-shadow .2s ease',
      }}
    >
      <div style={{ maxWidth: 1180, margin: '0 auto', boxSizing: 'border-box', padding: '0 24px', display: 'flex', alignItems: 'center', gap: 16 }}>
        <span
          style={{
            width: 30,
            height: 30,
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 9,
            background: 'linear-gradient(145deg,#6366F1,#4338CA)',
            color: '#FFFFFF',
            fontSize: 14,
            fontWeight: 700,
          }}
        >
          N
        </span>
        <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-.02em' }}>Nia Core</span>
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
          <a href="#product" style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--secondary)' }}>Product</a>
          <a href="#pricing" style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--secondary)' }}>Pricing</a>
          <a href="#connectors" style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--secondary)' }}>Docs</a>
          <a href="#stats" style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--secondary)' }}>Changelog</a>
          <a href="/login" style={ghostBtn}>Sign in</a>
          <a href="/signup" style={gradientBtn}>Start free</a>
        </div>
      </div>
    </nav>
  );
}
