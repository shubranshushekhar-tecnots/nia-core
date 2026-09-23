import { describe, it, expect } from "vitest";
import { getContextMenuItems } from "../../components/canvas/contextMenuItems.js";

function actionsOf(graphNodeType: "source" | "transform" | "destination", hasConnection: boolean) {
  return getContextMenuItems(graphNodeType, hasConnection)
    .filter((item) => item.kind === "action")
    .map((item) => (item as { action: string }).action);
}

describe("getContextMenuItems", () => {
  it("gives source/destination nodes with a resolved connection the full action set", () => {
    expect(actionsOf("source", true)).toEqual([
      "test-connection",
      "refresh",
      "edit-connection",
      "remove-node",
      "delete-connection",
    ]);
    expect(actionsOf("destination", true)).toEqual([
      "test-connection",
      "refresh",
      "edit-connection",
      "remove-node",
      "delete-connection",
    ]);
  });

  it("omits connection-scoped actions for source/destination nodes with no resolved connection", () => {
    expect(actionsOf("source", false)).toEqual(["remove-node"]);
    expect(actionsOf("destination", false)).toEqual(["remove-node"]);
  });

  it("gives transform nodes only 'Remove from workflow', regardless of hasConnection", () => {
    expect(actionsOf("transform", true)).toEqual(["remove-node"]);
    expect(actionsOf("transform", false)).toEqual(["remove-node"]);
  });

  it("separates the destructive delete action with a separator when present", () => {
    const items = getContextMenuItems("source", true);
    const deleteIndex = items.findIndex((item) => item.kind === "action" && item.action === "delete-connection");
    expect(items[deleteIndex - 1]).toEqual({ kind: "separator" });
  });
});
