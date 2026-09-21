import type { CSSProperties } from 'react';
import { CARD_W, COLOR, type CanvasNode } from './config';
import NodeGlyphIcon from './icons';

// A single canvas node card, rendered at its real pixel size always — this
// component is never wrapped in a scaling transform. Port rows are
// absolutely positioned at their exact `dy` from the card top so they line
// up pixel-for-pixel with the connector SVG paths in config.ts, regardless
// of how the header content reflows.
export default function NodeCard({ node, style }: { node: CanvasNode; style?: CSSProperties }) {
  const active = node.state === 'active';
  const notTaken = node.state === 'not-taken';
  const maxDy = Math.max(...node.ports.map((p) => p.dy));

  return (
    <div
      style={{
        position: 'absolute',
        left: node.x,
        top: node.y,
        width: CARD_W,
        boxSizing: 'border-box',
        borderRadius: 12,
        background: COLOR.cardSurface,
        border: `1px solid ${active ? COLOR.brandViolet : COLOR.cardBorder}`,
        borderStyle: notTaken ? 'dashed' : 'solid',
        opacity: notTaken ? 0.55 : 1,
        padding: '13px 14px 11px',
        height: maxDy + 9 + 11,
        fontFamily: 'var(--font-hero-sans)',
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 11 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            flex: 'none',
            borderRadius: 8,
            background: COLOR.iconTile,
            border: `1px solid ${COLOR.iconTileBorder}`,
            color: node.color,
          }}
        >
          <NodeGlyphIcon glyph={node.glyph} />
        </span>
        <span style={{ minWidth: 0 }}>
          <span
            style={{
              display: 'block',
              fontSize: 14,
              fontWeight: 500,
              letterSpacing: '-.015em',
              color: COLOR.textPrimary,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {node.title}
          </span>
          <span
            style={{
              display: 'block',
              fontSize: 11.5,
              color: COLOR.textMuted,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {node.subtitle}
          </span>
        </span>
      </div>

      <div style={{ height: 1, background: COLOR.divider, marginBottom: 10 }} />

      {node.ports.map((port) => {
        const isOut = port.side === 'out';
        const dotColor = isOut && active ? COLOR.brandViolet : COLOR.inactiveDot;
        return (
          <div
            key={`${port.side}-${port.label}`}
            style={{
              position: 'absolute',
              top: port.dy - 9,
              [isOut ? 'right' : 'left']: 14,
              display: 'flex',
              alignItems: 'center',
              flexDirection: isOut ? 'row-reverse' : 'row',
              gap: 7,
              fontSize: 11.5,
              color: COLOR.textMuted,
              whiteSpace: 'nowrap',
            }}
          >
            <span
              aria-hidden="true"
              style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, flex: 'none' }}
            />
            <span>{port.label}</span>
          </div>
        );
      })}
    </div>
  );
}
