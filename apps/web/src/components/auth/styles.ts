import type { CSSProperties } from 'react';

// Uses the auth screens' own light-indigo theme (Nia Core App.html's
// `T` override string), scoped under [data-auth-theme] — distinct from
// the app shell's Midnight Navy/rust [data-app-theme], which applies
// only post-login. Tokens only: --ign for the one primary action,
// --bad/--bad-bg/--bad-bd for errors, --font-display/--font-ui/--font-data
// for type. See packages/ui/src/theme.css's [data-auth-theme] block.

export const signinRootStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 70,
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  padding: '24px 20px',
  background: 'var(--bg)',
  color: 'var(--text)',
  fontFamily: 'var(--font-ui)',
  WebkitFontSmoothing: 'antialiased',
  overflow: 'auto',
};

export const dotGridStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 0,
  pointerEvents: 'none',
  opacity: 0.45,
  backgroundImage: 'radial-gradient(circle, var(--line-strong) 1px, transparent 1px)',
  backgroundSize: '26px 26px',
  WebkitMaskImage: 'radial-gradient(ellipse 70% 60% at 50% 45%, #000 40%, transparent 100%)',
  maskImage: 'radial-gradient(ellipse 70% 60% at 50% 45%, #000 40%, transparent 100%)',
};

export const pipeWrapStyle: CSSProperties = {
  position: 'fixed',
  left: '50%',
  top: '50%',
  transform: 'translate(-50%,-50%)',
  width: 'min(1080px, 110vw)',
  zIndex: 0,
  pointerEvents: 'none',
  opacity: 0.9,
};

export const themeToggleStyle: CSSProperties = {
  position: 'fixed',
  top: 20,
  right: 20,
  zIndex: 3,
  width: 36,
  height: 36,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 15,
  color: 'var(--text-2)',
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  borderRadius: 10,
  cursor: 'pointer',
};

export const brandRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  marginBottom: 28,
  animation: 'authRise .55s cubic-bezier(.2,.7,.2,1) both',
};

export const brandMarkStyle: CSSProperties = {
  width: 32,
  height: 32,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 9,
  background: 'linear-gradient(145deg, var(--ign), var(--ign-text))',
  color: 'var(--onacc)',
  fontFamily: 'var(--font-display)',
  fontSize: 15,
  fontWeight: 700,
  lineHeight: 1,
};

export function authCardStyle(narrow: boolean): CSSProperties {
  return {
    boxSizing: 'border-box',
    padding: narrow ? '28px 22px 26px' : '36px 32px 32px',
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: narrow ? 16 : 20,
    boxShadow: 'var(--drop)',
    animation: 'authRise .55s cubic-bezier(.2,.7,.2,1) .06s both',
  };
}

export const authFooterStyle: CSSProperties = {
  marginTop: 26,
  textAlign: 'center',
  animation: 'authRise .55s cubic-bezier(.2,.7,.2,1) .14s both',
};

export const titleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-display)',
  fontSize: 28,
  fontWeight: 700,
  letterSpacing: '-.02em',
  color: 'var(--text)',
};

export const subtitleStyle: CSSProperties = {
  margin: '8px 0 26px',
  fontSize: 14.5,
  lineHeight: 1.55,
  color: 'var(--text-2)',
};

export const fieldLabelStyle: CSSProperties = { fontSize: 13.5, fontWeight: 600, color: 'var(--text)' };

export function fieldStyle(hasError: boolean, isPassword: boolean): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    height: 44,
    padding: '12px 14px',
    fontFamily: 'inherit',
    fontSize: 14.5,
    fontWeight: 500,
    color: 'var(--text)',
    background: 'var(--surface2)',
    border: `1px solid ${hasError ? 'var(--bad)' : 'transparent'}`,
    borderRadius: 10,
    outline: 'none',
    transition: 'background .16s ease, border-color .16s ease, box-shadow .16s ease',
    boxShadow: hasError ? '0 0 0 3px var(--bad-bg)' : undefined,
    paddingRight: isPassword ? 44 : undefined,
  };
}

export const noteStyle: CSSProperties = { fontSize: 12, color: 'var(--text-3)' };

export const eyeBtnStyle: CSSProperties = {
  position: 'absolute',
  right: 8,
  width: 30,
  height: 30,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 13,
  lineHeight: 1,
  color: 'var(--text-2)',
  background: 'transparent',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
};

export const forgotLinkStyle: CSSProperties = {
  padding: 0,
  fontFamily: 'inherit',
  fontSize: 13.5,
  fontWeight: 500,
  color: 'var(--ign)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
};

export const signinBtnStyle: CSSProperties = {
  width: '100%',
  height: 46,
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 9,
  fontFamily: 'inherit',
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--onacc)',
  background: 'var(--ign)',
  border: 'none',
  borderRadius: 10,
  boxShadow: 'var(--amb)',
  cursor: 'pointer',
  transition: 'background .16s ease, box-shadow .16s ease, transform .1s ease',
};

export const googleBtnStyle: CSSProperties = {
  width: '100%',
  height: 46,
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  fontFamily: 'inherit',
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--text)',
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  borderRadius: 10,
  cursor: 'pointer',
  transition: 'background .16s ease, border-color .16s ease',
};

export const ssoLinkStyle: CSSProperties = {
  padding: '0 0 2px',
  fontFamily: 'inherit',
  fontSize: 13.5,
  fontWeight: 500,
  color: 'var(--text-2)',
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid var(--line)',
  cursor: 'pointer',
  transition: 'color .16s ease, border-color .16s ease',
};

export const createLinkStyle: CSSProperties = {
  padding: 0,
  fontFamily: 'inherit',
  fontSize: 14.5,
  fontWeight: 700,
  color: 'var(--ign)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
};

export const errorTextStyle: CSSProperties = { fontSize: 13, lineHeight: 1.5, color: 'var(--bad)' };

export const successTextStyle: CSSProperties = { fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-2)' };
