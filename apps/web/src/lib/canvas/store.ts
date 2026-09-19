import { create } from "zustand";
import type { Plan } from "@nia/schemas";

// Canvas UI-only state (same convention as components/app/store.ts). *Committed*
// node and edge data live in React Flow's own useNodesState/useEdgesState,
// sourced from mapping.ts on load — this store only tracks selection, the
// autosave lifecycle, and (Phase 7) the in-memory Copilot ghost preview,
// never committed graph content itself.
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
  /**
   * Phase 7 Copilot's proposed-but-not-yet-applied plan, or null when no
   * ghost is showing. Deliberately NOT merged into useNodesState/
   * useEdgesState (FlowCanvas.tsx derives a display-only merged array from
   * this instead) — this keeps the ghost out of autosave's `nodes`/`edges`
   * dependency entirely, so a ghost can never be accidentally persisted.
   * Never persisted itself either: purely in-memory, discarded on reload,
   * same as selectedNodeId.
   */
  ghostPlan: Plan | null;
  setGhostPlan: (plan: Plan | null) => void;
  clearGhost: () => void;
};

export const useCanvasStore = create<CanvasState>((set) => ({
  selectedNodeId: null,
  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
  saveState: "idle",
  setSaveState: (saveState) => set({ saveState }),
  version: 0,
  setVersion: (version) => set({ version }),
  ghostPlan: null,
  setGhostPlan: (ghostPlan) => set({ ghostPlan }),
  clearGhost: () => set({ ghostPlan: null }),
}));
