// Static style objects extracted verbatim from designs/Nia Core Landing.html
// (renderVals() in the __bundler/template's inline <script>). Values are
// copied character-for-character — do not adjust by eye.
import type { CSSProperties } from 'react';

export const ghostBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 36,
  padding: '0 14px',
  borderRadius: 9,
  fontSize: 13.5,
  fontWeight: 600,
  color: 'var(--secondary)',
  background: 'var(--surface)',
  border: '1px solid var(--line)',
};

export const ghostBtnLg: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 44,
  padding: '0 20px',
  borderRadius: 11,
  fontSize: 14.5,
  fontWeight: 600,
  color: 'var(--secondary)',
  background: 'var(--surface)',
  border: '1px solid var(--line)',
};

export const gradientBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 36,
  padding: '0 15px',
  borderRadius: 9,
  fontSize: 13.5,
  fontWeight: 600,
  color: '#FFFFFF',
  background: 'linear-gradient(120deg,#4F46E5,#7C3AED)',
  boxShadow: '0 10px 22px -12px rgba(79,70,229,.8)',
};

export const darkBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 44,
  padding: '0 20px',
  borderRadius: 11,
  fontSize: 14.5,
  fontWeight: 600,
  color: '#FFFFFF',
  background: 'var(--text)',
};

export const whiteBtn: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  height: 48,
  padding: '0 24px',
  borderRadius: 12,
  fontSize: 15,
  fontWeight: 700,
  color: 'var(--primary)',
  background: '#FFFFFF',
  boxShadow: '0 14px 30px -16px rgba(2,6,23,.5)',
};

export const kickerStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '6px 13px',
  borderRadius: 999,
  background: 'var(--primary-soft)',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.11em',
  color: 'var(--primary)',
};

export const recPillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '4px 10px',
  borderRadius: 999,
  background: 'linear-gradient(120deg,#4F46E5,#7C3AED)',
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '.06em',
  color: '#FFFFFF',
};

export const statCardStyle: CSSProperties = {
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
  padding: 20,
  borderRadius: 14,
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  boxShadow: '0 1px 2px rgba(15,23,42,.04)',
};

export const demoFrameStyle: CSSProperties = {
  marginTop: 26,
  overflow: 'hidden',
  borderRadius: 18,
  background: 'rgba(255,255,255,.8)',
  backdropFilter: 'blur(14px) saturate(1.4)',
  WebkitBackdropFilter: 'blur(14px) saturate(1.4)',
  border: '1px solid var(--line)',
  boxShadow: '0 30px 60px -40px rgba(15,23,42,.5)',
};

export function rail(c: string): CSSProperties {
  return {
    position: 'absolute',
    left: 12,
    right: 12,
    top: 0,
    height: 2.5,
    borderRadius: '0 0 2px 2px',
    background: `linear-gradient(90deg,transparent,${c} 14% 86%,transparent)`,
  };
}

export function tile(c: string, t: string): CSSProperties {
  return {
    width: 28,
    height: 28,
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
    background: t,
    color: c,
    fontSize: 11,
    fontWeight: 700,
  };
}
