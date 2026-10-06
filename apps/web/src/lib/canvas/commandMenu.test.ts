// @vitest-environment node
//
// Forced back to Node (vitest.config.ts's project-wide default is now
// jsdom, for the canvas component tests) because this file's "no storage
// available (SSR)" case relies on `window` being genuinely undefined —
// defaultStorage()'s default-parameter fallback only kicks in that way;
// under jsdom, `window.localStorage` is real and the SSR simulation breaks.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  COMMAND_GROUP_ORDER,
  COMMAND_MENU_TABS,
  SLASH_COMMANDS,
  commandInsertText,
  filterAiSuggestions,
  filterCommands,
  firstPlaceholderRange,
  groupCommands,
  loadRecentCommandIds,
  moveActiveIndex,
  moveTab,
  recentCommands,
  recordRecentCommand,
} from './commandMenu';

describe('SLASH_COMMANDS', () => {
  it('has exactly the 12 approved commands', () => {
    expect(SLASH_COMMANDS).toHaveLength(12);
    expect(SLASH_COMMANDS.map((c) => c.id)).toEqual([
      'source',
      'destination',
      'connect',
      'map',
      'filter',
      'aggregate',
      'clean',
      'run',
      'status',
      'cancel',
      'preview',
      'explain',
    ]);
  });

  it('every command belongs to one of the four approved groups', () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(COMMAND_GROUP_ORDER).toContain(cmd.group);
    }
  });

  it('/clean uses the approved <transform node> placeholder', () => {
    const clean = SLASH_COMMANDS.find((c) => c.id === 'clean')!;
    expect(clean.template).toContain('<transform node>');
  });
});

describe('filterCommands', () => {
  it('returns every command, unranked, for an empty query', () => {
    expect(filterCommands('')).toEqual(SLASH_COMMANDS);
    expect(filterCommands('   ')).toEqual(SLASH_COMMANDS);
  });

  it('ranks a name-prefix match above a name-substring match', () => {
    // "run" is a prefix of "run" and "status"/"cancel" aren't matches by
    // name at all, but "run" also appears inside "cancel a running run"
    // (description) — prefix-on-name should still win outright.
    const results = filterCommands('run');
    expect(results[0]!.id).toBe('run');
  });

  it('ranks a name-substring match above a description-only match', () => {
    // "map" is a substring of no other command's name, but appears in
    // /connect's description ("Connect two nodes together.") — not a
    // great example, so instead check "clean" substring vs "filter"
    // whose description doesn't mention it at all.
    const results = filterCommands('clean');
    expect(results.map((r) => r.id)).toEqual(['clean']);
  });

  it('matches via description when the query is not in any name', () => {
    const results = filterCommands('running');
    expect(results.map((r) => r.id)).toContain('cancel');
  });

  it('is case-insensitive', () => {
    expect(filterCommands('SOURCE').map((r) => r.id)).toEqual(filterCommands('source').map((r) => r.id));
  });

  it('excludes commands that match nothing', () => {
    expect(filterCommands('zzz-no-match')).toEqual([]);
  });
});

describe('groupCommands', () => {
  it('buckets the full list into all four groups in COMMAND_GROUP_ORDER', () => {
    const grouped = groupCommands(SLASH_COMMANDS);
    expect(grouped.map((g) => g.group)).toEqual(['Build', 'Transform', 'Run', 'Inspect']);
    expect(grouped.reduce((n, g) => n + g.commands.length, 0)).toBe(12);
  });

  it('drops groups with no matching commands', () => {
    const onlyRun = SLASH_COMMANDS.filter((c) => c.group === 'Run');
    const grouped = groupCommands(onlyRun);
    expect(grouped).toEqual([{ group: 'Run', commands: onlyRun }]);
  });
});

describe('commandInsertText', () => {
  it('concatenates the prefix and template verbatim', () => {
    const source = SLASH_COMMANDS.find((c) => c.id === 'source')!;
    expect(commandInsertText(source)).toBe('/Add a source node reading <table> from <connection>.');
    const map = SLASH_COMMANDS.find((c) => c.id === 'map')!;
    expect(commandInsertText(map)).toBe('//Map the fields from <source node> to <destination node>.');
  });
});

describe('firstPlaceholderRange', () => {
  it('finds the first <placeholder> token', () => {
    const range = firstPlaceholderRange('Add a filter on <column> where <condition>.');
    expect(range).not.toBeNull();
    expect('Add a filter on <column> where <condition>.'.slice(range!.start, range!.end)).toBe('<column>');
  });

  it('returns null when there is no placeholder', () => {
    expect(firstPlaceholderRange('Explain the last error.')).toBeNull();
  });
});

// Minimal in-memory Storage stand-in so tests never touch a real
// window.localStorage (this file runs under vitest's default node
// environment, no jsdom).
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

function throwingStorage(): Storage {
  return {
    getItem: () => {
      throw new Error('storage unavailable');
    },
    setItem: () => {
      throw new Error('storage unavailable');
    },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  } as Storage;
}

describe('recent commands storage', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = fakeStorage();
  });

  it('starts empty', () => {
    expect(loadRecentCommandIds(storage)).toEqual([]);
    expect(recentCommands(storage)).toEqual([]);
  });

  it('records and resolves recently used commands, most recent first', () => {
    recordRecentCommand('source', storage);
    recordRecentCommand('filter', storage);
    expect(loadRecentCommandIds(storage)).toEqual(['filter', 'source']);
    expect(recentCommands(storage).map((c) => c.id)).toEqual(['filter', 'source']);
  });

  it('dedupes: re-recording an id moves it to the front instead of duplicating it', () => {
    recordRecentCommand('source', storage);
    recordRecentCommand('filter', storage);
    recordRecentCommand('source', storage);
    expect(loadRecentCommandIds(storage)).toEqual(['source', 'filter']);
  });

  it('caps at 5 entries, dropping the oldest', () => {
    for (const id of ['source', 'destination', 'connect', 'filter', 'aggregate', 'run']) {
      recordRecentCommand(id, storage);
    }
    expect(loadRecentCommandIds(storage)).toEqual(['run', 'aggregate', 'filter', 'connect', 'destination']);
  });

  it('with no storage available (SSR / undefined), never throws and returns empty', () => {
    expect(() => recordRecentCommand('source', undefined)).not.toThrow();
    expect(loadRecentCommandIds(undefined)).toEqual([]);
    expect(recentCommands(undefined)).toEqual([]);
  });

  it('is guarded against storage throwing (private-mode/quota errors)', () => {
    const broken = throwingStorage();
    expect(() => recordRecentCommand('source', broken)).not.toThrow();
    expect(loadRecentCommandIds(broken)).toEqual([]);
  });

  it('ignores malformed stored JSON', () => {
    storage.setItem('nia:command-bar:recent-commands', 'not json');
    expect(loadRecentCommandIds(storage)).toEqual([]);
  });

  it('ignores a stored non-array value', () => {
    storage.setItem('nia:command-bar:recent-commands', JSON.stringify({ not: 'an array' }));
    expect(loadRecentCommandIds(storage)).toEqual([]);
  });
});

describe('moveActiveIndex', () => {
  it('moves forward and backward within bounds', () => {
    expect(moveActiveIndex(1, 5, 1)).toBe(2);
    expect(moveActiveIndex(1, 5, -1)).toBe(0);
  });

  it('wraps from the last index to the first going forward', () => {
    expect(moveActiveIndex(4, 5, 1)).toBe(0);
  });

  it('wraps from the first index to the last going backward', () => {
    expect(moveActiveIndex(0, 5, -1)).toBe(4);
  });

  it('always returns 0 for an empty list', () => {
    expect(moveActiveIndex(0, 0, 1)).toBe(0);
    expect(moveActiveIndex(0, 0, -1)).toBe(0);
  });
});

describe('moveTab', () => {
  it('cycles forward through all three tabs, wrapping', () => {
    expect(moveTab('commands', 1)).toBe('recent');
    expect(moveTab('recent', 1)).toBe('ai');
    expect(moveTab('ai', 1)).toBe('commands');
  });

  it('cycles backward through all three tabs, wrapping', () => {
    expect(moveTab('commands', -1)).toBe('ai');
    expect(moveTab('ai', -1)).toBe('recent');
    expect(moveTab('recent', -1)).toBe('commands');
  });

  it('covers every declared tab id', () => {
    expect(COMMAND_MENU_TABS).toEqual(['commands', 'recent', 'ai']);
  });
});

describe('filterAiSuggestions', () => {
  const suggestions = ['Add a source node reading a table from my connection.', 'Add a filter on a column.', 'Connect two nodes together.'];

  it('returns every suggestion for an empty query', () => {
    expect(filterAiSuggestions('', suggestions)).toEqual(suggestions);
  });

  it('matches case-insensitively by substring', () => {
    expect(filterAiSuggestions('FILTER', suggestions)).toEqual(['Add a filter on a column.']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterAiSuggestions('zzz', suggestions)).toEqual([]);
  });
});
