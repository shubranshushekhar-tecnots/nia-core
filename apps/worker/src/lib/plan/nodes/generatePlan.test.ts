import { describe, expect, it } from "vitest";
import { stripNullConnectionIds } from "./generatePlan.js";

/**
 * Pure-function tests for stripNullConnectionIds — the LLM-boundary
 * sanitizer that tolerates models emitting `"connectionId": null` on
 * transform nodes (see generatePlan.ts's doc comment). Scoped tests
 * specifically pin down the item-9 requirement: this must strip null ONLY
 * on transform nodes, never on source/destination nodes, since a
 * source/destination node with no connection is a real generation defect
 * that must surface as a loud Zod validation error, not get silently
 * normalized away.
 */
describe("stripNullConnectionIds", () => {
  it("strips an explicit null connectionId on a transform node", () => {
    const raw = {
      plan: {
        summary: "test",
        nodes: [{ id: "n1", type: "transform", connectionId: null, config: {}, position: { x: 0, y: 0 } }],
        edges: [],
      },
    };
    const result = stripNullConnectionIds(raw) as typeof raw;
    expect("connectionId" in result.plan.nodes[0]!).toBe(false);
  });

  it("leaves a null connectionId on a source node untouched (must surface as a validation error)", () => {
    const raw = {
      plan: {
        summary: "test",
        nodes: [{ id: "n1", type: "source", connectionId: null, config: {}, position: { x: 0, y: 0 } }],
        edges: [],
      },
    };
    const result = stripNullConnectionIds(raw) as typeof raw;
    expect(result.plan.nodes[0]!.connectionId).toBeNull();
  });

  it("leaves a null connectionId on a destination node untouched", () => {
    const raw = {
      plan: {
        summary: "test",
        nodes: [{ id: "n1", type: "destination", connectionId: null, config: {}, position: { x: 0, y: 0 } }],
        edges: [],
      },
    };
    const result = stripNullConnectionIds(raw) as typeof raw;
    expect(result.plan.nodes[0]!.connectionId).toBeNull();
  });

  it("leaves a real connectionId untouched on any node type", () => {
    const raw = {
      plan: {
        summary: "test",
        nodes: [{ id: "n1", type: "source", connectionId: "conn-1", config: {}, position: { x: 0, y: 0 } }],
        edges: [],
      },
    };
    const result = stripNullConnectionIds(raw) as typeof raw;
    expect(result.plan.nodes[0]!.connectionId).toBe("conn-1");
  });

  it("is a no-op when a transform node simply omits the key", () => {
    const raw = {
      plan: {
        summary: "test",
        nodes: [{ id: "n1", type: "transform", config: {}, position: { x: 0, y: 0 } }],
        edges: [],
      },
    };
    const result = stripNullConnectionIds(raw) as typeof raw;
    expect("connectionId" in result.plan.nodes[0]!).toBe(false);
  });

  it("passes through non-object input, clarify-only responses, and malformed shapes unchanged", () => {
    expect(stripNullConnectionIds(null)).toBeNull();
    expect(stripNullConnectionIds("not an object")).toBe("not an object");
    expect(stripNullConnectionIds({ clarifyQuestion: "which table?", plan: null })).toEqual({
      clarifyQuestion: "which table?",
      plan: null,
    });
    expect(stripNullConnectionIds({ plan: { summary: "test", nodes: "not-an-array", edges: [] } })).toEqual({
      plan: { summary: "test", nodes: "not-an-array", edges: [] },
    });
  });

  it("handles multiple nodes independently", () => {
    const raw = {
      plan: {
        summary: "test",
        nodes: [
          { id: "n1", type: "source", connectionId: "conn-1", config: {}, position: { x: 0, y: 0 } },
          { id: "n2", type: "transform", connectionId: null, config: {}, position: { x: 240, y: 0 } },
          { id: "n3", type: "destination", connectionId: null, config: {}, position: { x: 480, y: 0 } },
        ],
        edges: [],
      },
    };
    const result = stripNullConnectionIds(raw) as typeof raw;
    expect(result.plan.nodes[0]!.connectionId).toBe("conn-1");
    expect("connectionId" in result.plan.nodes[1]!).toBe(false);
    expect(result.plan.nodes[2]!.connectionId).toBeNull();
  });
});
