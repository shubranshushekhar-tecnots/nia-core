import { create } from "zustand";

// Sidebar UI-only state (project tree accordion, rail width / drag state).
// Nothing here is server data — that always comes from the Server Component
// queries — this just remembers presentation state across client-side
// interaction within a session.
//
// railW mirrors the design's own `state.railW` resizable-rail model
// (Nia Core App.html): drag clamps to 168-360px, drops to a fixed 64px
// "narrow" rail below a 150px threshold, and a double-click on the drag
// handle toggles between 64 and the 240px default (`railReset`).
//
// navProjectsOpen/openProject mirror the design's own `state.navProjectsOpen`
// (whole tree disclosure) and `state.openProject` (single-project accordion —
// only one project's workflow list is expanded at a time).
type AppShellState = {
  railW: number;
  railDrag: boolean;
  setRailW: (w: number) => void;
  setRailDrag: (dragging: boolean) => void;
  toggleRailCollapse: () => void;
  navProjectsOpen: boolean;
  toggleNavProjectsOpen: () => void;
  openProject: string | null;
  toggleOpenProject: (projectId: string) => void;
  setOpenProject: (projectId: string) => void;
};

export const useAppShellStore = create<AppShellState>((set) => ({
  railW: 240,
  railDrag: false,
  setRailW: (railW) => set({ railW }),
  setRailDrag: (railDrag) => set({ railDrag }),
  toggleRailCollapse: () => set((s) => ({ railW: s.railW === 64 ? 240 : 64 })),
  navProjectsOpen: true,
  toggleNavProjectsOpen: () => set((s) => ({ navProjectsOpen: !s.navProjectsOpen })),
  openProject: null,
  toggleOpenProject: (projectId) =>
    set((s) => ({ openProject: s.openProject === projectId ? null : projectId })),
  // Unconditional set (unlike toggleOpenProject) — used to auto-expand the
  // project tree around the currently-open workflow on landing directly on
  // a /app/workflows/:id URL (e.g. via a bookmark or reload), where there's
  // no prior click to have already opened it.
  setOpenProject: (projectId) => set({ openProject: projectId }),
}));
