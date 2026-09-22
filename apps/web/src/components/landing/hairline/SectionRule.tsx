import type { CSSProperties } from 'react';

// The repeating 1px section divider. `tone="hairline"` uses the lighter
// #e4e5e8 rule (dividers between grid cells/rows); the default "strong"
// tone is the #101014 rule used between major page sections.
export default function SectionRule({
  tone = 'strong',
  style,
}: {
  tone?: 'strong' | 'hairline';
  style?: CSSProperties;
}) {
  return (
    <div
      aria-hidden="true"
      style={{
        height: 1,
        background: tone === 'strong' ? 'var(--hl-rule)' : 'var(--hl-rule-hairline)',
        ...style,
      }}
    />
  );
}
