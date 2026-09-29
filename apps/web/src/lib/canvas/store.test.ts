import { beforeEach, describe, it, expect } from "vitest";
import { useCanvasStore } from "./store";

const PROMPT = "[Connection: conn-1, namespace: public] Explain the write grant for this step.";

/**
 * Learning mode, Step 6 — GrantAccessPanel/RevokeAccessPanel ("Ask Copilot
 * about this step") and CommandBar's watcher effect never touch each other
 * directly; pendingAgentPrompt (+ copilotOpen) is the entire contract
 * between them. This app has no jsdom/RTL setup (see vitest.config.ts's
 * header comment), so CommandBar/FlowCanvas aren't rendered here — this
 * proves the store half of the wiring: a set prompt is readable, forces
 * the (possibly collapsed) Copilot sidebar open, and clearing it back to
 * null (what CommandBar's effect does immediately after it reads a
 * pending prompt, to ensure a single send per click) actually clears it
 * without re-collapsing the sidebar.
 */
describe("useCanvasStore pendingAgentPrompt / copilotOpen", () => {
  beforeEach(() => {
    useCanvasStore.setState({ pendingAgentPrompt: null, copilotOpen: true });
  });

  it("starts null / open", () => {
    expect(useCanvasStore.getState().pendingAgentPrompt).toBeNull();
    expect(useCanvasStore.getState().copilotOpen).toBe(true);
  });

  it("is set by setPendingAgentPrompt and cleared back to null after being consumed", () => {
    useCanvasStore.getState().setPendingAgentPrompt(PROMPT);
    expect(useCanvasStore.getState().pendingAgentPrompt).toBe(PROMPT);

    useCanvasStore.getState().setPendingAgentPrompt(null);
    expect(useCanvasStore.getState().pendingAgentPrompt).toBeNull();
  });

  it("opens a collapsed Copilot sidebar when a prompt is set, and leaves it open once the prompt is consumed (sent exactly once)", () => {
    useCanvasStore.getState().setCopilotOpen(false);
    expect(useCanvasStore.getState().copilotOpen).toBe(false);

    // "Ask Copilot about this step" while collapsed: prompt lands and the
    // panel opens in the same atomic update, so CommandBar mounts already
    // able to see the pending prompt (no missed-mount race).
    useCanvasStore.getState().setPendingAgentPrompt(PROMPT);
    expect(useCanvasStore.getState().copilotOpen).toBe(true);
    expect(useCanvasStore.getState().pendingAgentPrompt).toBe(PROMPT);

    // CommandBar's effect consumes-then-clears exactly once; the sidebar
    // must stay open (never force-closed by consuming the prompt).
    useCanvasStore.getState().setPendingAgentPrompt(null);
    expect(useCanvasStore.getState().pendingAgentPrompt).toBeNull();
    expect(useCanvasStore.getState().copilotOpen).toBe(true);
  });

  it("toggleCopilot flips copilotOpen both ways (the header/sidebar toggle button)", () => {
    useCanvasStore.getState().setCopilotOpen(false);
    useCanvasStore.getState().toggleCopilot();
    expect(useCanvasStore.getState().copilotOpen).toBe(true);
    useCanvasStore.getState().toggleCopilot();
    expect(useCanvasStore.getState().copilotOpen).toBe(false);
  });
});
