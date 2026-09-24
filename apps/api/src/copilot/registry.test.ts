import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { z } from "zod";
import { registerTool, listTools, __clearRegistryForTests } from "./registry.js";
import type { ActingUser, ToolDefinition } from "./types.js";
import type { WithUser } from "../lib/withUser.js";

/**
 * Required test (docs/plans/copilot-agent.md, "Tests" section): "the
 * registry rejects a tool without a tier or summarizer, and every
 * execute-tier tool refuses without a matching confirmed pending action."
 */

const baseTool = {
  name: "test_tool",
  description: "a test tool",
  tier: "read" as const,
  inputSchema: z.object({}),
  handler: async () => ({}),
  summarize: () => "summary",
  render: () => ({ kind: "test", payload: {} }),
};

describe("registerTool", () => {
  beforeEach(() => {
    __clearRegistryForTests();
  });

  it("rejects a tool with no tier", () => {
    const tool = { ...baseTool, tier: undefined } as unknown as ToolDefinition<unknown, unknown>;
    expect(() => registerTool(tool)).toThrow(/tier/i);
  });

  it("rejects a tool with an invalid tier", () => {
    const tool = { ...baseTool, tier: "dangerous" } as unknown as ToolDefinition<unknown, unknown>;
    expect(() => registerTool(tool)).toThrow(/tier/i);
  });

  it("rejects a tool with no summarizer", () => {
    const tool = { ...baseTool, summarize: undefined } as unknown as ToolDefinition<unknown, unknown>;
    expect(() => registerTool(tool)).toThrow(/summarize/i);
  });

  it("rejects a tool with no renderer", () => {
    const tool = { ...baseTool, render: undefined } as unknown as ToolDefinition<unknown, unknown>;
    expect(() => registerTool(tool)).toThrow(/render/i);
  });

  it("rejects a tool with no handler", () => {
    const tool = { ...baseTool, handler: undefined } as unknown as ToolDefinition<unknown, unknown>;
    expect(() => registerTool(tool)).toThrow(/handler/i);
  });

  it("rejects a tool with no inputSchema", () => {
    const tool = { ...baseTool, inputSchema: undefined } as unknown as ToolDefinition<unknown, unknown>;
    expect(() => registerTool(tool)).toThrow(/inputSchema/i);
  });

  it("rejects a duplicate tool name", () => {
    registerTool(baseTool);
    expect(() => registerTool(baseTool)).toThrow(/already registered/i);
  });

  it("accepts a well-formed tool", () => {
    expect(() => registerTool(baseTool)).not.toThrow();
    expect(listTools().map((t) => t.name)).toContain("test_tool");
  });
});

describe("every execute-tier tool refuses without a matching confirmed pending action", () => {
  // Any query other than consume_pending_action means the tool tried to do
  // its real work *before* successfully consuming a confirmed pending
  // action, which is exactly what this test must catch. Mirrors what the
  // real consume_pending_action RPC returns for an unconfirmed, expired, or
  // hash-mismatched pending action.
  function makeRefusingWithUser(): WithUser {
    return (async (fn) =>
      fn({
        query: async (text: string) => {
          if (text.includes("consume_pending_action")) {
            throw new Error("pending action some-pending-action-id is not confirmed, already consumed, expired, or its arguments no longer match");
          }
          throw new Error(`execute-tier tool ran a query before a pending action was confirmed: ${text}`);
        },
      })) as WithUser;
  }

  const user: ActingUser = {
    userId: "11111111-1111-1111-1111-111111111111",
    scope: { ownerId: "11111111-1111-1111-1111-111111111111" },
    actor: { userId: "11111111-1111-1111-1111-111111111111", email: "test@example.com", fullName: null, org: null, role: "individual" },
  };

  // One fixture of minimally-valid input per execute-tier tool name. A new
  // execute-tier tool with no entry here fails this suite loudly (see the
  // "every execute-tier tool has a fixture" test below) rather than being
  // silently skipped.
  const inputFixtures: Record<string, unknown> = {
    start_run: { workflowId: "22222222-2222-2222-2222-222222222222", destNodeIds: ["dest-1"] },
  };

  // tools/index.js's imports register every real tool exactly once (ES
  // module caching means a second `import()` would be a no-op) — import it
  // once in beforeAll rather than clearing+re-importing per test.
  beforeAll(async () => {
    __clearRegistryForTests();
    await import("./tools/index.js");
  });

  it("every execute-tier tool has an input fixture in this test", () => {
    const executeTools = listTools().filter((t) => t.tier === "execute");
    expect(executeTools.length).toBeGreaterThan(0);
    for (const tool of executeTools) {
      expect(inputFixtures, `add an inputFixtures["${tool.name}"] entry above`).toHaveProperty(tool.name);
    }
  });

  const executeToolNames = Object.keys(inputFixtures);
  for (const name of executeToolNames) {
    it(`${name} refuses to do its real work with a pendingActionId that fails to consume`, async () => {
      const tool = listTools().find((t) => t.name === name);
      expect(tool?.tier).toBe("execute");
      const input = tool!.inputSchema.parse(inputFixtures[name]);
      await expect(
        tool!.handler(
          { withUser: makeRefusingWithUser(), user, pendingActionId: "some-pending-action-id" },
          input,
        ),
      ).rejects.toThrow(/not confirmed|PENDING_ACTION_NOT_CONFIRMED/i);
    });
  }
});
