import type { ReactElement } from 'react';
import type { GraphNodeType } from '@nia/schemas';

/**
 * Connector/category icon registry (UI feedback item 4 — "connectors and
 * projects can't be differentiated"). Every icon is a monochrome inline SVG
 * using `currentColor` for fill/stroke — no hardcoded brand hex — so color
 * still comes from the caller (GraphFlowNode.tsx's KIND_COLOR / theme
 * tokens), exactly like every other surface in this repo. Adding a new
 * connector is one entry in CONNECTOR_ICONS, not a component change.
 */
export type IconComponent = (props: { size?: number }) => ReactElement;

// ---------- connector brand silhouettes (keyed by CONNECTOR_MANIFESTS id) ----------

const MysqlIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M4 15c2-3 3.5-7 3-11 2.5 1 4 4.5 3.5 8.5-.3 2.3-1.5 4-3.5 4.8"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M9 16.5c3.5-1.5 7-1.2 10.5 1-1 1.6-3 2.3-5 1.9-2-.4-4-1.5-5.5-2.9Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <circle cx="18" cy="17" r=".9" fill="currentColor" />
  </svg>
);

const MongodbIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M12 2.5c3 3 4.5 6.4 4.5 9.7 0 3.6-2 6.6-4.5 8.3-2.5-1.7-4.5-4.7-4.5-8.3 0-3.3 1.5-6.7 4.5-9.7Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <path d="M12 13.2V21" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const SupabaseIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10.5H13l0-8.5Z" fill="currentColor" />
  </svg>
);

export const CONNECTOR_ICONS: Record<string, IconComponent> = {
  mysql: MysqlIcon,
  mongodb: MongodbIcon,
  supabase: SupabaseIcon,
};

// ---------- category glyphs (fallback when no connector-specific icon applies) ----------

const SourceIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="3.5" y="6" width="10" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
    <path d="M14 12h6.5M17.5 8.5 21 12l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const TransformIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M4 8h13M17 8l-3-3M17 8l-3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M20 16H7M7 16l3-3M7 16l3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const DestinationIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="10.5" y="6" width="10" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
    <path d="M2.5 12H9M5.5 8.5 2 12l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const CATEGORY_ICONS: Record<GraphNodeType, IconComponent> = {
  source: SourceIcon,
  transform: TransformIcon,
  destination: DestinationIcon,
};

export const TriggerIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10.5H13l0-8.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);

const GenericNodeIcon: IconComponent = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="4" y="4" width="16" height="16" rx="3" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

/** Connector kind wins when known; falls back to the node's category glyph, then a generic tile. */
export function getConnectorIcon(manifestId?: string, nodeType?: GraphNodeType): IconComponent {
  if (manifestId && CONNECTOR_ICONS[manifestId]) return CONNECTOR_ICONS[manifestId];
  if (nodeType) return CATEGORY_ICONS[nodeType];
  return GenericNodeIcon;
}
