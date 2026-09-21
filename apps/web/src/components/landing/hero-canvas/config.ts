// Pure data for the hero's fixed canvas layer: node positions (all relative
// to the Supabase card's top-left at 0,0 — see the brief's position table),
// connector paths (canvas coordinates, copied verbatim from spec), and the
// dark-island color tokens. This layer is never transformed — only the
// `.window` clipping it grows — so every pixel value here is a real,
// final on-screen size, not something that gets scaled later.

export type NodeGlyph = 'clock' | 'supabase' | 'claude' | 'branch' | 'powerbi' | 'slack';
export type NodeState = 'active' | 'idle' | 'not-taken';

export type PortDef = { label: string; side: 'in' | 'out'; dy: number };

export type CanvasNode = {
  id: string;
  x: number;
  y: number;
  glyph: NodeGlyph;
  title: string;
  subtitle: string;
  color: string;
  state: NodeState;
  ports: PortDef[];
};

export const CARD_W = 236;
export const PORT_ROW_Y = 72;

// -------------------------------------------------------------------------
// Colors (dark-island palette — intentionally not reusing the light landing
// page's --c-trigger/--c-data tokens, this hero is a self-contained dark
// section per the brief).
// -------------------------------------------------------------------------
export const COLOR = {
  ground: '#000000',
  // The window/canvas interior (dot grid + node cards) is a white canvas —
  // only the surrounding "ground" letterbox stays black, so the window
  // reads as a lit portal into the pipeline while it's opening.
  canvasBg: '#FFFFFF',
  // Card surface is white (not the old dark-island look) — cards read as
  // real workflow-canvas nodes sitting on the white canvas, per the
  // reference design. Title text uses `chromeStrong` (dark ink), not
  // `textPrimary`, because `textPrimary` is shared with the rest-state
  // headline over the black ground and must stay white there.
  cardSurface: '#F2F2F4',
  cardBorder: '#E5E5EA',
  cardShadow: '0 1px 2px rgba(16,16,20,0.04), 0 8px 24px -12px rgba(16,16,20,0.12)',
  iconTile: '#F5F5F7',
  iconTileBorder: '#EBEBF0',
  divider: '#EEEEF2',
  connector: '#D9D9DF',
  dotGrid: '#E6E6EC',
  textPrimary: '#FFFFFF',
  textSecondary: '#9AA0A8',
  textMuted: '#7B818A',
  textDim: '#6E747C',
  // Chrome overlay sits atop the (now white) canvas once pinned, so it
  // needs dark ink here rather than the light `text*` tokens above (those
  // stay for the rest-state text, which is still over the black ground).
  // Also reused as the node card title color for the same reason.
  chromeMuted: '#6B6B75',
  chromeStrong: '#101014',
  railTrack: '#E6E6EC',
  brandVioletOnBlack: '#7361FF',
  brandViolet: '#5B4BE7',
  inactiveDot: '#C7C7D1',
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
    x: -306,
    y: 0,
    glyph: 'clock',
    title: 'Schedule',
    subtitle: 'Every night at 02:00',
    color: COLOR.node.schedule,
    state: 'idle',
    ports: [{ label: 'Trigger', side: 'out', dy: PORT_ROW_Y }],
  },
  {
    id: 'supabase',
    x: 0,
    y: 0,
    glyph: 'supabase',
    title: 'Supabase',
    subtitle: 'Read new orders',
    color: '#3ECF8E',
    state: 'active',
    ports: [
      { label: 'Input', side: 'in', dy: PORT_ROW_Y },
      { label: 'Output', side: 'out', dy: PORT_ROW_Y },
    ],
  },
  {
    id: 'claude',
    x: 306,
    y: 0,
    glyph: 'claude',
    title: 'Claude',
    subtitle: 'Classify order notes',
    color: COLOR.node.ai,
    state: 'idle',
    ports: [{ label: 'Input', side: 'in', dy: PORT_ROW_Y }],
  },
  {
    id: 'route',
    x: 0,
    y: 190,
    glyph: 'branch',
    title: 'Route by Type',
    subtitle: 'Multi-way branch by value',
    color: COLOR.node.condition,
    state: 'idle',
    ports: [
      { label: 'Input', side: 'in', dy: PORT_ROW_Y },
      { label: 'New rows', side: 'out', dy: 72 },
      { label: 'Nothing new', side: 'out', dy: 100 },
    ],
  },
  {
    id: 'powerbi',
    x: 424,
    y: 190,
    glyph: 'powerbi',
    title: 'Power BI',
    subtitle: 'Push dataset',
    color: COLOR.node.action,
    state: 'idle',
    ports: [{ label: 'Input', side: 'in', dy: PORT_ROW_Y }],
  },
  {
    id: 'slack',
    x: 424,
    y: 360,
    glyph: 'slack',
    title: 'Slack',
    subtitle: 'Notify #data-ops',
    color: COLOR.textDim,
    state: 'not-taken',
    ports: [{ label: 'Input', side: 'in', dy: PORT_ROW_Y }],
  },
];

export const nodeById = (id: string): CanvasNode => NODES.find((n) => n.id === id)!;

// Connector paths, canvas coordinates (Supabase top-left = 0,0). Copied
// verbatim from the brief — do not "clean up" by re-deriving from node
// positions, these already account for the port-row/elbow geometry.
export const CONNECTORS: string[] = [
  'M-84 72 H14',
  'M222 72 H320',
  'M528 72 H566 Q578 72 578 84 V130 Q578 142 566 142 H-94 Q-106 142 -106 154 V250 Q-106 262 -94 262 H14',
  'M222 262 H438',
  'M222 290 H378 Q390 290 390 302 V420 Q390 432 402 432 H438',
];

// Bounding box of the full canvas (node cards + connector reach), used to
// size the fixed canvas layer and to compute the offset that keeps the
// Supabase node's centre pinned under the window's centre at every scale.
export const CANVAS_BOUNDS = {
  left: -306 - 110,
  top: -60,
  right: 424 + CARD_W + 40,
  bottom: 360 + 175,
};

export const PRIMARY_NODE_CENTER = { x: CARD_W / 2, y: PORT_ROW_Y };

// Rest-state window metrics. Sized as a small inline thumbnail that sits on
// the headline's own text line (roughly matching its line-height) rather
// than a large window spanning past it — see the reference: the image
// should read as a small inline chip, not a floating panel. Used only as an
// SSR-safe default before hydration / as a fallback if the ghost span can't
// be measured — the real rest box + center used for the scroll rig's Phase
// A lerp is measured live from the ghost span itself (see
// useHeroScrollProgress) so the window always lands exactly where the
// headline's ghost reserved room for it, at any viewport width.
export const REST_WINDOW = { w: 240, h: 150 };
export const PIN_THRESHOLD = 0.12; // fraction of scrollable range where Phase A ends
