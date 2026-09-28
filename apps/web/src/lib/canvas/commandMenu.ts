/**
 * Pure logic for CommandBar.tsx's "/" command menu (docs/plans/
 * copilot-command-menu.md). Kept out of components/canvas so it's covered
 * by vitest.config.ts's `src/lib/**` include (component tests aren't wired
 * up yet — see that file's header comment) and so it never has to import
 * React/icons.tsx — CommandMenu.tsx maps each command's `icon` key to an
 * actual icon component at render time.
 *
 * Constraint from the design doc: UI only. Every command still ends up as
 * plain text sent through the existing proposePlan() ("/"...) or
 * runAgentTurn() ("//"...) flows — there is no new command-specific
 * backend logic here, just canned NL templates a user can edit before
 * sending.
 */

export type CommandGroupName = 'Build' | 'Transform' | 'Run' | 'Inspect';

/** Keys into CommandMenu.tsx's own icon lookup — see that file's ICONS map. Every command has a distinct key (no repeats). */
export type CommandIconKey =
  | 'source'
  | 'destination'
  | 'connections'
  | 'map'
  | 'filter'
  | 'aggregate'
  | 'clean'
  | 'run'
  | 'status'
  | 'cancel'
  | 'preview'
  | 'chat';

export type SlashCommand = {
  id: string;
  /** Displayed as "/name" (Build/Transform commands) regardless of which prefix it actually inserts. */
  name: string;
  group: CommandGroupName;
  icon: CommandIconKey;
  description: string;
  /** NL text inserted after the prefix; may contain `<placeholder>` tokens. */
  template: string;
  /** Which Copilot path this command dispatches through once sent. */
  prefix: '/' | '//';
};

export const COMMAND_GROUP_ORDER: CommandGroupName[] = ['Build', 'Transform', 'Run', 'Inspect'];

// Locked 12-command list (user-approved). Order within each group is the
// approved order; do not resort alphabetically.
export const SLASH_COMMANDS: SlashCommand[] = [
  // ---------- Build ----------
  {
    id: 'source',
    name: 'source',
    group: 'Build',
    icon: 'source',
    description: 'Add a source node reading a table from a connection.',
    template: 'Add a source node reading <table> from <connection>.',
    prefix: '/',
  },
  {
    id: 'destination',
    name: 'destination',
    group: 'Build',
    icon: 'destination',
    description: 'Add a destination node writing to a table.',
    template: 'Add a destination node writing to <table> in <connection>.',
    prefix: '/',
  },
  {
    id: 'connect',
    name: 'connect',
    group: 'Build',
    icon: 'connections',
    description: 'Connect two nodes together.',
    template: 'Connect <source node> to <destination node>.',
    prefix: '/',
  },
  {
    id: 'map',
    name: 'map',
    group: 'Build',
    icon: 'map',
    description: 'Map fields from one node to another.',
    template: 'Map the fields from <source node> to <destination node>.',
    prefix: '//',
  },
  // ---------- Transform ----------
  {
    id: 'filter',
    name: 'filter',
    group: 'Transform',
    icon: 'filter',
    description: 'Add a filter on a column.',
    template: 'Add a filter on <column> where <condition>.',
    prefix: '/',
  },
  {
    id: 'aggregate',
    name: 'aggregate',
    group: 'Transform',
    icon: 'aggregate',
    description: 'Group by a column and aggregate a value.',
    template: 'Group by <group by column> and aggregate <value column> with <function>.',
    prefix: '/',
  },
  {
    id: 'clean',
    name: 'clean',
    group: 'Transform',
    icon: 'clean',
    description: 'Clean up messy values on a transform node.',
    template: 'Clean the data on <transform node>.',
    prefix: '//',
  },
  // ---------- Run ----------
  {
    id: 'run',
    name: 'run',
    group: 'Run',
    icon: 'run',
    description: 'Start a run for a destination node.',
    template: 'Run <destination node>.',
    prefix: '//',
  },
  {
    id: 'status',
    name: 'status',
    group: 'Run',
    icon: 'status',
    description: 'Check the status of a run.',
    template: "What's the status of <run>?",
    prefix: '//',
  },
  {
    id: 'cancel',
    name: 'cancel',
    group: 'Run',
    icon: 'cancel',
    description: 'Cancel a running run.',
    template: 'Cancel <run>.',
    prefix: '//',
  },
  // ---------- Inspect ----------
  {
    id: 'preview',
    name: 'preview',
    group: 'Inspect',
    icon: 'preview',
    description: 'Preview sample rows from a node.',
    template: 'Preview rows from <node>.',
    prefix: '//',
  },
  {
    id: 'explain',
    name: 'explain',
    group: 'Inspect',
    icon: 'chat',
    description: 'Explain the last error on this workflow.',
    template: 'Explain the last error.',
    prefix: '//',
  },
];

/**
 * Fuzzy-ish ranking: prefix matches on the command name rank above
 * substring matches on the name, which rank above matches found only in
 * the description. Empty/whitespace query returns every command,
 * unfiltered, in the approved order (identity — no ranking noise on open).
 */
export function filterCommands(query: string, commands: SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  const scored: { cmd: SlashCommand; score: number; index: number }[] = [];
  commands.forEach((cmd, index) => {
    const name = cmd.name.toLowerCase();
    const desc = cmd.description.toLowerCase();
    let score: number | null = null;
    if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (desc.includes(q)) score = 2;
    if (score !== null) scored.push({ cmd, score, index });
  });
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.map((s) => s.cmd);
}

/** Buckets commands by group in COMMAND_GROUP_ORDER, dropping empty groups (so a narrow filter doesn't render blank group headers). */
export function groupCommands(commands: SlashCommand[]): { group: CommandGroupName; commands: SlashCommand[] }[] {
  return COMMAND_GROUP_ORDER.map((group) => ({ group, commands: commands.filter((c) => c.group === group) })).filter(
    (g) => g.commands.length > 0,
  );
}

/** The literal text CommandBar's draft becomes once a command is picked. */
export function commandInsertText(cmd: SlashCommand): string {
  return cmd.prefix + cmd.template;
}

/** First `<placeholder>` token's [start, end) index range within `text`, or null if there isn't one (cursor should just land at the end). */
export function firstPlaceholderRange(text: string): { start: number; end: number } | null {
  const match = /<[^>]+>/.exec(text);
  if (!match) return null;
  return { start: match.index, end: match.index + match[0].length };
}

// ---------- recently-used commands (localStorage, try/catch guarded per design doc) ----------

const RECENT_COMMANDS_KEY = 'nia:command-bar:recent-commands';
const RECENT_COMMANDS_LIMIT = 5;

/** Storage is injectable so tests can pass a fake without touching window.localStorage. Defaults to window.localStorage when present (undefined during SSR). */
function defaultStorage(): Storage | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage;
}

export function loadRecentCommandIds(storage: Storage | undefined = defaultStorage()): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(RECENT_COMMANDS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

export function recordRecentCommand(id: string, storage: Storage | undefined = defaultStorage()): void {
  if (!storage) return;
  try {
    const current = loadRecentCommandIds(storage);
    const next = [id, ...current.filter((existing) => existing !== id)].slice(0, RECENT_COMMANDS_LIMIT);
    storage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(next));
  } catch {
    // Storage full/unavailable (private mode, quota) — recent commands are a nicety, never block the menu.
  }
}

/** Resolves stored ids back to full SlashCommand objects, silently dropping any id that no longer matches a command. */
export function recentCommands(
  storage: Storage | undefined = defaultStorage(),
  commands: SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  const ids = loadRecentCommandIds(storage);
  const byId = new Map(commands.map((c) => [c.id, c]));
  return ids.map((id) => byId.get(id)).filter((c): c is SlashCommand => !!c);
}

// ---------- CommandMenu.tsx keyboard-nav helpers (kept framework-free so they're unit-testable without jsdom) ----------

export type CommandMenuTabId = 'commands' | 'recent' | 'ai';

export const COMMAND_MENU_TABS: CommandMenuTabId[] = ['commands', 'recent', 'ai'];

/** ArrowDown/ArrowUp over a flat item list — wraps at both ends. `count <= 0` always yields 0 (nothing to select). */
export function moveActiveIndex(current: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return 0;
  return (current + direction + count) % count;
}

/** ArrowLeft/ArrowRight or Ctrl+Tab — cycles through the three tabs, wrapping. */
export function moveTab(current: CommandMenuTabId, direction: 1 | -1): CommandMenuTabId {
  const idx = COMMAND_MENU_TABS.indexOf(current);
  return COMMAND_MENU_TABS[(idx + direction + COMMAND_MENU_TABS.length) % COMMAND_MENU_TABS.length]!;
}

/** AI Command tab's filter — SLASH_SUGGESTIONS are plain example prompts, not SlashCommand objects, so this is a simpler case-insensitive substring match rather than filterCommands' ranked one. */
export function filterAiSuggestions(query: string, suggestions: string[]): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return suggestions;
  return suggestions.filter((s) => s.toLowerCase().includes(q));
}
