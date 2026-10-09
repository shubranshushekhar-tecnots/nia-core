'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  COMMAND_MENU_TABS,
  SLASH_COMMANDS,
  filterAiSuggestions,
  filterCommands,
  groupCommands,
  moveActiveIndex,
  moveTab,
  recentCommands,
  type CommandMenuTabId,
  type SlashCommand,
} from '@/lib/canvas/commandMenu';
import {
  commandMenuEmptyStyle,
  commandMenuGroupHeaderStyle,
  commandMenuHintStyle,
  commandMenuListStyle,
  commandMenuPanelStyle,
  commandMenuRowDescStyle,
  commandMenuRowIconStyle,
  commandMenuRowNameStyle,
  commandMenuRowStyle,
  commandMenuTabBtnStyle,
  commandMenuTabStripStyle,
} from './styles';
import { CATEGORY_ICONS, type IconComponent } from '@nia/canvas-view';
import { ChatIcon, ConnectionsIcon, RunsIcon } from './navIcons';
import { AggregateIcon, EyeIcon, FilterIcon, MapFieldsIcon, PulseIcon, SparkleIcon, StopSquareIcon } from './commandIcons';

const ICONS: Record<SlashCommand['icon'], IconComponent> = {
  source: CATEGORY_ICONS.source,
  destination: CATEGORY_ICONS.destination,
  connections: ConnectionsIcon,
  map: MapFieldsIcon,
  filter: FilterIcon,
  aggregate: AggregateIcon,
  clean: SparkleIcon,
  run: RunsIcon,
  status: PulseIcon,
  cancel: StopSquareIcon,
  preview: EyeIcon,
  chat: ChatIcon,
};

const TAB_LABEL: Record<CommandMenuTabId, string> = {
  commands: 'Commands',
  recent: 'Recent',
  ai: 'AI Command',
};

type FlatItem = { id: string; kind: 'command'; command: SlashCommand } | { id: string; kind: 'ai'; text: string };

/** Rows register themselves here (keyed by option id) so the highlighted row can be scrolled into view — a plain mutable ref, never null after init, unlike RefObject<T>'s `T | null`. */
type RowRefMap = { current: Map<string, HTMLButtonElement> };

/**
 * The "/" command menu (docs/plans/copilot-command-menu.md). Renders above
 * (or, when there isn't room, below) CommandBar.tsx's input bar. Owns its
 * own keyboard handling by attaching a native `keydown` listener directly
 * to `inputRef`'s element rather than requiring CommandBar to thread key
 * events through — a real DOM listener on the input itself fires during
 * the bubble phase before React's own onKeyDown (delegated to the root)
 * does, so calling `stopPropagation()` here for the keys this menu owns
 * (arrows, Enter/Tab, Escape, tab-switching) cleanly suppresses CommandBar's
 * own Enter-to-send handler without CommandBar needing to know this menu
 * exists at the event-wiring level. Focus never leaves the input — this is
 * a combobox/listbox pattern, not a focus-trapped popup.
 */
export default function CommandMenu({
  open,
  draft,
  inputRef,
  onPickCommand,
  onPickAiSuggestion,
  onClose,
  aiSuggestions,
}: {
  open: boolean;
  /** Full input value, e.g. "/fil" — the leading "/" is stripped internally to get the search query. */
  draft: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onPickCommand: (cmd: SlashCommand) => void;
  onPickAiSuggestion: (text: string) => void;
  onClose: () => void;
  aiSuggestions: string[];
}) {
  const [activeTab, setActiveTab] = useState<CommandMenuTabId>('commands');
  const [activeIndex, setActiveIndex] = useState(0);
  const [placement, setPlacement] = useState<'above' | 'below'>('above');
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const query = draft.replace(/^\/+/, '');

  const groupedCommands = useMemo(() => groupCommands(filterCommands(query, SLASH_COMMANDS)), [query]);
  const filteredRecent = useMemo(() => filterCommands(query, recentCommands()), [query, open]);
  const filteredAi = useMemo(() => filterAiSuggestions(query, aiSuggestions), [query, aiSuggestions]);

  const commandsCount = groupedCommands.reduce((n, g) => n + g.commands.length, 0);
  const recentCount = filteredRecent.length;
  const aiCount = filteredAi.length;

  const items: FlatItem[] = useMemo(() => {
    if (activeTab === 'commands') return groupedCommands.flatMap((g) => g.commands.map((c) => ({ id: c.id, kind: 'command' as const, command: c })));
    if (activeTab === 'recent') return filteredRecent.map((c) => ({ id: c.id, kind: 'command' as const, command: c }));
    return filteredAi.map((text, i) => ({ id: `ai-${i}`, kind: 'ai' as const, text }));
  }, [activeTab, groupedCommands, filteredRecent, filteredAi]);

  // Reset to a clean slate every time the menu opens, and whenever the
  // active tab or filtered results change underneath the user's typing —
  // an index into a list that just shrank could otherwise point nowhere.
  useEffect(() => {
    if (open) {
      setActiveTab('commands');
      setActiveIndex(0);
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [activeTab, query]);

  // Flip above/below based on actual available space — see design doc:
  // "flips below the input if there's no room above".
  useEffect(() => {
    if (!open) return;
    const input = inputRef.current;
    if (!input) return;
    const rect = input.getBoundingClientRect();
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    setPlacement(spaceAbove >= 360 || spaceAbove >= spaceBelow ? 'above' : 'below');
  }, [open, inputRef]);

  const activeItem = items[activeIndex];
  const activeId = activeItem ? `command-menu-option-${activeItem.id}` : undefined;

  // Keeps the highlighted row in view and mirrors combobox ARIA state onto
  // the input (which lives in CommandBar.tsx, not here) — see this file's
  // header comment on why this menu owns its own keyboard wiring directly
  // against inputRef rather than through CommandBar's props.
  useEffect(() => {
    if (!open) return;
    const input = inputRef.current;
    if (input) {
      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-expanded', 'true');
      input.setAttribute('aria-controls', 'command-menu-listbox');
      if (activeId) input.setAttribute('aria-activedescendant', activeId);
      else input.removeAttribute('aria-activedescendant');
    }
    if (activeId) rowRefs.current.get(activeId)?.scrollIntoView({ block: 'nearest' });
    return () => {
      if (!input) return;
      input.removeAttribute('role');
      input.removeAttribute('aria-expanded');
      input.removeAttribute('aria-controls');
      input.removeAttribute('aria-activedescendant');
    };
  }, [open, activeId, inputRef]);

  function pick(item: FlatItem) {
    if (item.kind === 'command') onPickCommand(item.command);
    else onPickAiSuggestion(item.text);
    onClose();
  }

  useEffect(() => {
    if (!open) return;
    const input = inputRef.current;
    if (!input) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setActiveIndex((i) => moveActiveIndex(i, items.length, 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setActiveIndex((i) => moveActiveIndex(i, items.length, -1));
      } else if (e.key === 'ArrowRight' || (e.key === 'Tab' && e.ctrlKey && !e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        setActiveTab((t) => moveTab(t, 1));
      } else if (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.ctrlKey && e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        setActiveTab((t) => moveTab(t, -1));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (items.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        pick(items[activeIndex]!);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    input.addEventListener('keydown', handleKeyDown);
    return () => input.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, items, activeIndex, inputRef]);

  if (!open) return null;

  const emptyMessage = items.length > 0 ? null : activeTab === 'recent' ? 'No recent commands yet.' : 'No matching commands';

  return (
    <div style={commandMenuPanelStyle(placement)} data-testid="command-bar-slash-menu">
      <div style={commandMenuListStyle} role="listbox" id="command-menu-listbox" aria-label="Copilot commands">
        {emptyMessage ? (
          <div style={commandMenuEmptyStyle}>{emptyMessage}</div>
        ) : activeTab === 'commands' ? (
          groupedCommands.map((g) => (
            <div key={g.group}>
              <div style={commandMenuGroupHeaderStyle}>{g.group}</div>
              {g.commands.map((cmd) => (
                <CommandRow
                  key={cmd.id}
                  command={cmd}
                  active={activeItem?.kind === 'command' && activeItem.command.id === cmd.id}
                  onHover={() => setActiveIndex(items.findIndex((it) => it.id === cmd.id))}
                  onPick={() => pick({ id: cmd.id, kind: 'command', command: cmd })}
                  rowRefs={rowRefs}
                />
              ))}
            </div>
          ))
        ) : activeTab === 'recent' ? (
          filteredRecent.map((cmd) => (
            <CommandRow
              key={cmd.id}
              command={cmd}
              active={activeItem?.kind === 'command' && activeItem.command.id === cmd.id}
              onHover={() => setActiveIndex(items.findIndex((it) => it.id === cmd.id))}
              onPick={() => pick({ id: cmd.id, kind: 'command', command: cmd })}
              rowRefs={rowRefs}
            />
          ))
        ) : (
          filteredAi.map((text, i) => (
            <AiRow
              key={`ai-${i}`}
              optionId={`ai-${i}`}
              text={text}
              active={activeItem?.kind === 'ai' && activeItem.id === `ai-${i}`}
              onHover={() => setActiveIndex(items.findIndex((it) => it.id === `ai-${i}`))}
              onPick={() => pick({ id: `ai-${i}`, kind: 'ai', text })}
              rowRefs={rowRefs}
            />
          ))
        )}
      </div>
      {activeItem?.kind === 'command' && (
        <div style={commandMenuHintStyle}>
          {activeItem.command.name} — {activeItem.command.description}
        </div>
      )}
      <div style={commandMenuTabStripStyle} role="tablist" aria-label="Command menu sections">
        {COMMAND_MENU_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            style={commandMenuTabBtnStyle(activeTab === tab)}
            onMouseDown={(e) => {
              e.preventDefault();
              setActiveTab(tab);
            }}
          >
            {TAB_LABEL[tab]} {tab === 'commands' ? commandsCount : tab === 'recent' ? recentCount : aiCount}
          </button>
        ))}
      </div>
    </div>
  );
}

function CommandRow({
  command,
  active,
  onHover,
  onPick,
  rowRefs,
}: {
  command: SlashCommand;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
  rowRefs: RowRefMap;
}) {
  const Icon = ICONS[command.icon];
  const id = `command-menu-option-${command.id}`;
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={active}
      ref={(el) => {
        if (el) rowRefs.current.set(id, el);
        else rowRefs.current.delete(id);
      }}
      style={commandMenuRowStyle(active)}
      onMouseEnter={onHover}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
    >
      <span style={commandMenuRowIconStyle}>
        <Icon size={16} />
      </span>
      <span style={commandMenuRowNameStyle}>{command.name}</span>
    </button>
  );
}

function AiRow({
  optionId,
  text,
  active,
  onHover,
  onPick,
  rowRefs,
}: {
  optionId: string;
  text: string;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
  rowRefs: RowRefMap;
}) {
  const id = `command-menu-option-${optionId}`;
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={active}
      ref={(el) => {
        if (el) rowRefs.current.set(id, el);
        else rowRefs.current.delete(id);
      }}
      style={commandMenuRowStyle(active)}
      onMouseEnter={onHover}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
    >
      <span style={commandMenuRowDescStyle}>{text}</span>
    </button>
  );
}
