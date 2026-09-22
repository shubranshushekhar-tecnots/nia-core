import type { CSSProperties } from 'react';
import { hlFontFamily } from '../hairline/styles';
import { CARD_W, COLOR, type CanvasNode } from './config';
import NodeGlyphIcon from './icons';

// A single canvas node card, rendered at its real pixel size always — this
// component is never wrapped in a scaling transform. Port rows are
// absolutely positioned at their exact `dy` from the card top so they line
// up pixel-for-pixel with the connector SVG paths in config.ts, regardless
// of how the header content reflows.
//
// Visual identity ("active"/"running") is driven entirely by CSS classes
// (`animClass`/`ledClass`) supplied by the caller — see HeroCanvasLayer's
// slot→class mapping — rather than a static prop, since the shared 7.5s
// run-animation loop cycles every card's border/LED continuously.
export default function NodeCard({
  node,
  animClass,
  ledClass,
  selected = false,
  onSelect,
  style,
}: {
  node: CanvasNode;
  animClass?: string;
  ledClass?: string;
  selected?: boolean;
  onSelect?: () => void;
  style?: CSSProperties;
}) {
  const rows = groupPortsByRow(node.ports);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={animClass}
      style={{
        position: 'absolute',
        left: node.x,
        top: node.y,
        width: CARD_W,
        height: node.height,
        boxSizing: 'border-box',
        borderRadius: 12,
        background: COLOR.cardSurface,
        border: `1px solid ${COLOR.cardBorder}`,
        outline: selected ? `2px solid ${COLOR.brandViolet}` : 'none',
        outlineOffset: -2,
        padding: 0,
        margin: 0,
        display: 'flex',
        flexDirection: 'column',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: hlFontFamily,
        ...style,
      }}
    >
      <div style={{ flexGrow: 1, padding: '16px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            flex: 'none',
            borderRadius: 8,
            border: `1px solid ${COLOR.iconTileBorder}`,
            color: node.color,
          }}
        >
          <NodeGlyphIcon glyph={node.glyph} size={18} />
        </span>
        <span style={{ minWidth: 0, flexGrow: 1 }}>
          <span
            style={{
              display: 'block',
              fontSize: 15,
              fontWeight: 500,
              lineHeight: '20px',
              letterSpacing: '-.015em',
              color: COLOR.chromeStrong,
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
              marginTop: 3,
              fontSize: 13,
              lineHeight: '18px',
              color: COLOR.textMuted,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {node.subtitle}
          </span>
        </span>
        <span
          aria-hidden="true"
          className={ledClass}
          style={{ width: 6, height: 6, marginTop: 7, flex: 'none', background: COLOR.brandViolet }}
        />
      </div>

      {rows.map(({ dy, ports }, i) => {
        const hasIn = ports.some((p) => p.side === 'in');
        const hasOut = ports.some((p) => p.side === 'out');
        const justify = hasIn && hasOut ? 'space-between' : hasIn ? 'flex-start' : 'flex-end';
        return (
          <div
            key={dy}
            style={{
              position: 'absolute',
              top: dy - 20,
              left: 0,
              right: 0,
              height: 40,
              boxSizing: 'border-box',
              borderTop: i === 0 ? `1px solid ${COLOR.divider}` : 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: justify,
              padding: '0 12px',
              gap: 10,
            }}
          >
            {ports.map((port) => (
              <span
                key={`${port.side}-${port.label}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flexDirection: port.side === 'out' ? 'row-reverse' : 'row',
                  gap: 10,
                  fontSize: 12,
                  color: COLOR.textMuted,
                  whiteSpace: 'nowrap',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 8,
                    height: 8,
                    flex: 'none',
                    background: port.connected ? COLOR.connectedPort : COLOR.inactiveDot,
                  }}
                />
                <span>{port.label}</span>
              </span>
            ))}
          </div>
        );
      })}
    </button>
  );
}

// Groups a node's ports by their `dy` (row position) so rows with both an
// `in` and an `out` port at the same height render as one space-between
// row instead of two overlapping absolutely-positioned rows.
function groupPortsByRow(ports: CanvasNode['ports']) {
  const byDy = new Map<number, CanvasNode['ports']>();
  for (const port of ports) {
    const existing = byDy.get(port.dy);
    if (existing) existing.push(port);
    else byDy.set(port.dy, [port]);
  }
  return Array.from(byDy.entries())
    .sort(([a], [b]) => a - b)
    .map(([dy, rowPorts]) => ({ dy, ports: rowPorts }));
}
