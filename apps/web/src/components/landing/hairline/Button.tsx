import type { CSSProperties, MouseEventHandler, ReactNode } from 'react';

type Variant = 'solid' | 'outline';
type Ground = 'light' | 'dark';

// Button for the "hairline" design system: one component, two variants
// (solid, outline) x two grounds (light, dark) = the four combinations
// used across Connectors.dc.html and Pricing.dc.html (hero CTAs, the
// closing CTA band's white-fill + #4a4d55-outline pair, plan CTAs, etc).
// 52px tall, sharp corners, 15px/500 label — values extracted verbatim
// from the design files. Hover uses the shared .hl-btn class (opacity .78,
// 140ms linear) from theme.css.
const base: CSSProperties = {
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: 52,
  padding: '0 28px',
  borderRadius: 0,
  fontSize: 15,
  fontWeight: 500,
  fontFamily: 'inherit',
  textDecoration: 'none',
  cursor: 'pointer',
};

const variantStyles: Record<Ground, Record<Variant, CSSProperties>> = {
  light: {
    solid: { background: 'var(--hl-ink)', color: 'var(--hl-ground)', border: '1px solid var(--hl-ink)' },
    outline: { background: 'transparent', color: 'var(--hl-ink)', border: '1px solid var(--hl-ink)' },
  },
  dark: {
    solid: { background: 'var(--hl-ground)', color: 'var(--hl-ink)', border: '1px solid var(--hl-ground)' },
    outline: { background: 'transparent', color: 'var(--hl-ground)', border: '1px solid var(--hl-ink-2)' },
  },
};

export default function Button({
  children,
  variant = 'solid',
  ground = 'light',
  href,
  onClick,
  style,
  type = 'button',
  disabled,
}: {
  children: ReactNode;
  variant?: Variant;
  ground?: Ground;
  href?: string;
  onClick?: MouseEventHandler;
  style?: CSSProperties;
  type?: 'button' | 'submit';
  disabled?: boolean;
}) {
  const combinedStyle: CSSProperties = {
    ...base,
    ...variantStyles[ground][variant],
    ...(disabled ? { opacity: 0.6, cursor: 'not-allowed' } : null),
    ...style,
  };

  if (href) {
    return (
      <a href={href} className="hl-btn" style={combinedStyle} onClick={onClick}>
        {children}
      </a>
    );
  }

  return (
    <button type={type} className="hl-btn" style={combinedStyle} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
