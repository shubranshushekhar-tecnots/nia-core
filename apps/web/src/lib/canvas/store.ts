import { create } from "zustand";
import type { CleanProposalResult, Plan, PlanDiff } from "@nia/schemas";

/**
 * Phase 13, Step 7 — the full "Propose cleaning" result plus the nodeId it
 * targets (the API call site already knows this; the result itself doesn't
 * carry it — see cleanPropose.ts's header comment on why `nodeId` isn't
 * part of CleanProposalResult).
 */
export type CleanProposal = CleanProposalResult & { nodeId: string };

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
  /**
   * Phase 12 — same in-memory-only, never-autosaved contract as ghostPlan
   * above, for a diff-shaped proposal instead of an add-only one. Mutually
   * exclusive with ghostPlan in practice (setting one is expected to clear
   * the other), but kept as a separate field rather than a tagged union so
   * FlowCanvas's existing `ghostPlan`-typed call sites don't need a runtime
   * narrow on every read.
   */
  ghostDiff: PlanDiff | null;
  setGhostDiff: (diff: PlanDiff | null) => void;
  /**
   * Phase 13, Step 7 — set alongside ghostDiff (never independently):
   * cleanProposal.diff IS ghostDiff whenever this is non-null. Kept as a
   * separate field, rather than folding nodeId/columns/binding into
   * ghostDiff itself, so Copilot's existing plan-diff call sites
   * (setGhostDiff, used for a diff with no clean-specific payload) don't
   * need to carry a shape they have no use for. TransformEditor reads this
   * to render Step 7's per-column route/rationale/onFailure/dry-run detail
   * for the node it targets; FlowCanvas reads `.binding` to populate
   * applyPlanDiff's `cleanBinding` field on Apply.
   */
  cleanProposal: CleanProposal | null;
  setCleanProposal: (proposal: CleanProposal | null) => void;
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
  setGhostPlan: (ghostPlan) => set({ ghostPlan, ghostDiff: null, cleanProposal: null }),
  ghostDiff: null,
  setGhostDiff: (ghostDiff) => set({ ghostDiff, ghostPlan: null, cleanProposal: null }),
  cleanProposal: null,
  setCleanProposal: (cleanProposal) => set({ cleanProposal, ghostDiff: cleanProposal?.diff ?? null, ghostPlan: null }),
  clearGhost: () => set({ ghostPlan: null, ghostDiff: null, cleanProposal: null }),
}));
