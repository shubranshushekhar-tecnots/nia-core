import { create } from "zustand";

// Canvas UI-only state (same convention as components/app/store.ts). Node
// and edge *data* live in React Flow's own useNodesState/useEdgesState,
// sourced from mapping.ts on load — this store only tracks selection and
// the autosave lifecycle, never graph content itself.
//
// saveState:
//   idle     - no unsaved changes since the last successful save/load
//   saving   - a debounced PUT is in flight
//   saved    - the last PUT succeeded (transient; caller fades this back to idle)
//   conflict - the last PUT got a 409 VERSION_CONFLICT; local changes are
//              held pending until the user reloads (never silently
//              overwritten/discarded - see graphClient.ts's putWorkflowGraph
//              doc comment)
export type SaveState = "idle" | "saving" | "saved" | "conflict";

type CanvasState = {
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  saveState: SaveState;
  setSaveState: (state: SaveState) => void;
  version: number;
  setVersion: (version: number) => void;
};

export const useCanvasStore = create<CanvasState>((set) => ({
  selectedNodeId: null,
  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
  saveState: "idle",
  setSaveState: (saveState) => set({ saveState }),
  version: 0,
  setVersion: (version) => set({ version }),
}));
