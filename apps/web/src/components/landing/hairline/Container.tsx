import type { CSSProperties, ReactNode } from 'react';

// Gutter primitive for the "hairline" design system: 112px at desktop,
// stepping down to 56/32/20px (see .hl-container in theme.css). There is
// no existing generic Container in the codebase to reuse — every other
// landing section just inlines maxWidth/padding — so this is new.
export default function Container({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className="hl-container" style={style}>
      {children}
    </div>
  );
}
