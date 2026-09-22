// Pure data for the hero's fixed canvas layer: node positions (all relative
// to the Supabase card's top-left at 0,0 — see the brief's position table),
// connector paths (canvas coordinates, copied verbatim from spec), and the
// dark-island color tokens. This layer is never transformed — only the
// `.window` clipping it grows — so every pixel value here is a real,
// final on-screen size, not something that gets scaled later.

export type NodeGlyph =
  | 'clock'
  | 'supabase'
  | 'claude'
  | 'branch'
  | 'powerbi'
  | 'slack'
  | 'mysql'
  | 'postgresql'
  | 'mongodb'
  | 'snowflake';

// Which slot of the shared 7.5s run-animation timeline a node card
// occupies (see HeroCanvasSection's <style> block for the actA-actE /
// ledA-ledE keyframes these map to). PowerBI and Slack intentionally
// share slot 'e' — the reference fires both destinations together at the
// end of the run.
export type TimelineSlot = 'a' | 'b' | 'c' | 'd' | 'e';

export type PortDef = { label: string; side: 'in' | 'out'; dy: number; connected: boolean };

export type CanvasNode = {
  id: string;
  x: number;
  y: number;
  height: number;
  glyph: NodeGlyph;
  title: string;
  subtitle: string;
  color: string;
  slot: TimelineSlot;
  ports: PortDef[];
};

export const CARD_W = 280;
export const PORT_ROW_H = 40;
export const PORT_ROW_Y = 92; // first port row's vertical center (dy)

// -------------------------------------------------------------------------
// Colors (dark-island palette outside the window, product-mockup palette
// inside it — the window interior matches "The Canvas" design reference
// exactly: white cards on a light dotted canvas, ink text, violet accent).
// -------------------------------------------------------------------------
export const COLOR = {
  ground: '#000000',
  // The window/canvas interior (dot grid + node cards) matches the rest of
  // the site's page background (--bg: #F8FAFC) rather than pure white —
  // only the surrounding "ground" letterbox stays black, so the window
  // reads as a lit portal into the pipeline while it's opening.
  canvasBg: '#F8FAFC',
  // Card surface/border/dividers match the reference design verbatim.
  cardSurface: '#FFFFFF',
  cardBorder: '#E4E5E8',
  iconTileBorder: '#E4E5E8',
  divider: '#F0F1F3',
  connector: '#D9D9DF',
  dotGrid: '#DFE1E5',
  textPrimary: '#FFFFFF',
  textSecondary: '#9AA0A8',
  textMuted: '#64696F',
  textDim: '#6E747C',
  // Chrome overlay sits atop the (now white) canvas once pinned, so it
  // needs dark ink here rather than the light `text*` tokens above (those
  // stay for the rest-state text, which is still over the black ground).
  // Also reused as the node card title color for the same reason.
  chromeMuted: '#8E9096',
  chromeStrong: '#101014',
  railTrack: '#E4E5E8',
  brandVioletOnBlack: '#7361FF',
  brandViolet: '#594CDF',
  connectedPort: '#101014',
  inactiveDot: '#C9CBD1',
  wireBase: '#C9CBD1',
  node: {
    schedule: '#F0A868',
    data: '#4FD1C5',
    action: '#5B4BE7',
    condition: '#F26D8A',
    ai: '#B99BFF',
  },
} as const;

export const NODES: CanvasNode[] = [
  {
    id: 'schedule',
    x: -360,
    y: 0,
    height: 112,
    glyph: 'clock',
    title: 'Schedule',
    subtitle: 'Every night at 02:00',
    color: COLOR.node.schedule,
    slot: 'a',
    ports: [{ label: 'Trigger', side: 'out', dy: PORT_ROW_Y, connected: true }],
  },
  {
    id: 'supabase',
    x: 0,
    y: 0,
    height: 112,
    // No-JS / first-paint fallback — must stay equal to CONNECTOR_CYCLE[0]
    // below, which is what useConnectorCycle actually drives this node's
    // glyph/title/subtitle/color from once mounted (see HeroCanvasLayer).
    glyph: 'supabase',
    title: 'Supabase',
    subtitle: 'Read new orders',
    color: '#3ECF8E',
    slot: 'b',
    ports: [
      { label: 'Input', side: 'in', dy: PORT_ROW_Y, connected: true },
      { label: 'Output', side: 'out', dy: PORT_ROW_Y, connected: true },
    ],
  },
  {
    id: 'claude',
    x: 360,
    y: 0,
    height: 112,
    glyph: 'claude',
    title: 'Claude',
    subtitle: 'Classify order notes',
    color: COLOR.node.ai,
    slot: 'c',
    ports: [{ label: 'Input', side: 'in', dy: PORT_ROW_Y, connected: true }],
  },
  {
    id: 'route',
    x: 0,
    y: 240,
    height: 152,
    glyph: 'branch',
    title: 'Route by Type',
    subtitle: 'Multi-way branch by value',
    color: COLOR.node.condition,
    slot: 'd',
    ports: [
      { label: 'Input', side: 'in', dy: PORT_ROW_Y, connected: true },
      { label: 'New rows', side: 'out', dy: PORT_ROW_Y, connected: true },
      { label: 'Nothing new', side: 'out', dy: PORT_ROW_Y + PORT_ROW_H, connected: false },
    ],
  },
  {
    id: 'powerbi',
    x: 360,
    y: 240,
    height: 112,
    glyph: 'powerbi',
    title: 'Power BI',
    subtitle: 'Push dataset',
    color: COLOR.node.action,
    slot: 'e',
    ports: [{ label: 'Input', side: 'in', dy: PORT_ROW_Y, connected: true }],
  },
  {
    id: 'slack',
    x: 360,
    y: 440,
    height: 112,
    glyph: 'slack',
    title: 'Slack',
    subtitle: 'Notify #data-ops',
    color: COLOR.textDim,
    slot: 'e',
    ports: [{ label: 'Input', side: 'in', dy: PORT_ROW_Y, connected: true }],
  },
];

export const nodeById = (id: string): CanvasNode => NODES.find((n) => n.id === id)!;

// -------------------------------------------------------------------------
// Anchor-node connector cycle — the 'supabase' node above is the pinned
// handoff anchor shown in both the approach block's small window and the
// pin block's fullscreen canvas. useConnectorCycle drives its glyph/title/
// subtitle/color through this list over time, showing the canvas works
// with any source, not just Supabase.
// -------------------------------------------------------------------------
export type ConnectorFrame = {
  glyph: NodeGlyph;
  title: string;
  subtitle: string;
  color: string;
};

export const CONNECTOR_CYCLE: ConnectorFrame[] = [
  { glyph: 'supabase', title: 'Supabase', subtitle: 'Read new orders', color: '#3ECF8E' },
  { glyph: 'mysql', title: 'MySQL', subtitle: 'Read orders table', color: '#4479A1' },
  { glyph: 'postgresql', title: 'PostgreSQL', subtitle: 'Read orders view', color: '#4169E1' },
  { glyph: 'powerbi', title: 'Power BI', subtitle: 'Sync orders dataset', color: COLOR.node.action },
  { glyph: 'mongodb', title: 'MongoDB', subtitle: 'Read orders collection', color: '#47A248' },
  { glyph: 'snowflake', title: 'Snowflake', subtitle: 'Query ORDERS_RAW', color: '#29B5E8' },
];

// Connector paths, canvas coordinates (Supabase top-left = 0,0), copied
// verbatim from "The Canvas" design reference and shifted by the same
// (-440, -110) offset used to re-anchor the reference's absolute node
// coordinates onto the Supabase-at-origin convention this file already
// uses. Do not "clean up" by re-deriving from node positions — these
// already account for the port-row/elbow geometry the reference specifies.
export const CONNECTORS: string[] = [
  'M-80 92 H0',
  'M280 92 H360',
  'M640 92 H686 Q700 92 700 106 V151 Q700 165 686 165 H-26 Q-40 165 -40 179 V318 Q-40 332 -26 332 H0',
  'M280 332 H360',
  'M280 372 H306 Q320 372 320 386 V518 Q320 532 334 532 H360',
];

// Bounding box of the full canvas (node cards + connector reach), used to
// size the fixed canvas layer and to compute the offset that keeps the
// Supabase node's centre pinned under the window's centre at every scale.
export const CANVAS_BOUNDS = {
  left: -360 - 40,
  top: -40,
  right: 700 + 40,
  bottom: 552 + 40,
};

// Anchor point (canvas coords, Supabase card top-left = 0,0) kept centered
// under the window at every scroll frame — the card's real vertical
// midpoint (height 112 / 2).
export const PRIMARY_NODE_CENTER = { x: CARD_W / 2, y: 56 };

// Rest-state window metrics — the window's *native* (pre-CSS-scale) crop
// size in canvas px, snug around the card's real content (logo → divider →
// Input/Output port row) with a small margin on every edge, ending just past
// the purple Output dot rather than showing the full card + blank canvas
// below it. The on-page *displayed* size is smaller still — see the ghost
// span in HeroCanvasSection and the `restScale` transform derived from it
// in useHeroScrollProgress — this constant only fixes the crop's aspect
// ratio and what's visible, not how large it renders.
export const REST_WINDOW = { w: 260, h: 100 };

// Size the window has grown to by the end of the approach block / start of
// the pin block (the handoff instant). Previously the window stayed at
// REST_WINDOW's tiny native size for the entire approach block while only
// its position moved to center — since the headline scrolls away much
// faster than that, this left a long stretch of near-empty black ground
// with just a small floating chip in it. Growing the window from
// REST_WINDOW to this larger size *during* the approach block (see
// useHeroApproachProgress) means neighboring nodes/connectors are already
// filling the frame well before the pin block's fullscreen-growth phase
// takes over from here.
export const HANDOFF_WINDOW = { w: 640, h: 360 };

// Height of the "approach" block — normal (non-sticky) document flow where
// the headline scrolls away naturally while the small Supabase window
// drifts from its rest position to dead-center of the viewport. All of this
// height is real scroll distance (nothing is frozen/pinned), unlike the pin
// block below it.
export const HERO_APPROACH_VH = 140;

// Height of the pin block's tall wrapper — its sticky stage stays stuck for
// (this - 100vh) of scroll while the window grows from centered-small to
// fullscreen.
export const HERO_PIN_VH = 300;
